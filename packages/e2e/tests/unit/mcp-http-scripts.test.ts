/**
 * The gateway's script tools at their two trust boundaries: the test root,
 * which no client path may leave, and the collection child, which is the only
 * place project code runs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ScriptService, SCRIPT_TOOL_DEFINITIONS } from '../../src/mcp/http/scripts.ts';
import type { McpToolResult } from '../../src/mcp/tools.ts';

const MAX_SCRIPT_BYTES = 256 * 1024;

const roots: string[] = [];
function root(): string {
  // Canonical spelling: a short 8.3 name in os.tmpdir() would not compare
  // equal to the realpath the service holds.
  const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'e2e-mcp-scripts-')));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function service(dir: string, cliEntry = collecting(dir)): Promise<ScriptService> {
  return ScriptService.create({ root: dir, cliEntry, env: process.env, log: () => undefined });
}

async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (cause) {
    return cause as { code: string; message: string };
  }
  throw new Error('expected the call to fail');
}

function textOf(result: McpToolResult): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('expected a text result');
  return first.text;
}

/** A stand-in for the built CLI: prints what `list --reporter json` prints. */
function fakeCli(dir: string, body: string): string {
  const file = path.join(dir, 'fake-cli.mjs');
  writeFileSync(file, body);
  return file;
}

function collected(projectRoot: string) {
  return {
    projectRoot,
    pairs: [
      { file: 'tests/forms.e2e.ts', title: 'submits the form', target: 'web', agent: 'default', tags: [] },
      { file: 'tests/forms.e2e.ts', title: 'rejects a bad email', target: 'web', agent: 'default', tags: ['slow'] },
      { file: 'tests/login.e2e.ts', title: 'signs in', target: 'web', agent: 'default', tags: [] },
      { file: '../shared/out.e2e.ts', title: 'outside', target: 'web', agent: 'default', tags: [] },
    ],
    targets: [
      { name: 'web', url: 'https://example.test' },
      { name: 'device' },
    ],
  };
}

/** A fake CLI whose stdout is this collection result, narrowed to the files it was given. */
function collecting(dir: string, projectRoot = dir): string {
  return fakeCli(
    dir,
    `import path from 'node:path';
const positionals = process.argv.slice(2).filter((arg) => arg.endsWith('.e2e.ts'));
const base = ${JSON.stringify(collected(projectRoot))};
const selected = positionals.length === 0
  ? base.pairs
  : base.pairs.filter((pair) => positionals.some((positional) => path.relative(${JSON.stringify(projectRoot)}, positional).split(path.sep).join('/') === pair.file));
console.log(JSON.stringify({ ...base, pairs: selected }));
`,
  );
}

/** Creates fixture scripts so listing can resolve them. */
function writeFiles(dir: string, ...files: string[]): void {
  for (const file of files) {
    const absolute = path.join(dir, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, '// fixture');
  }
}

describe('script tool definitions', () => {
  it('names the three tools and refuses undeclared arguments', () => {
    expect(SCRIPT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(['list_test_scripts', 'get_test_script', 'save_test_script']);
    for (const tool of SCRIPT_TOOL_DEFINITIONS) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(typeof tool.description).toBe('string');
    }
    // The search is the way in; a call without one is refused.
    expect(SCRIPT_TOOL_DEFINITIONS[0]?.inputSchema.required).toEqual(['keyword']);
    // Listing imports test files' top-level code; only reading is a read.
    expect(SCRIPT_TOOL_DEFINITIONS[0]?.annotations?.readOnlyHint).toBe(false);
    expect(SCRIPT_TOOL_DEFINITIONS[1]?.annotations?.readOnlyHint).toBe(true);
    expect(SCRIPT_TOOL_DEFINITIONS[2]?.annotations?.readOnlyHint).toBe(false);
  });
});

describe('ScriptService path safety', () => {
  it('reads and saves only inside the test root', async () => {
    const dir = root();
    const outside = root();
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests', 'ok.e2e.ts'), 'ok');
    writeFileSync(path.join(outside, 'secret.e2e.ts'), 'secret');
    const scripts = await service(dir);

    expect((await scripts.getScript('tests/ok.e2e.ts')).content).toBe('ok');
    expect((await scripts.getScript(path.join(dir, 'tests', 'ok.e2e.ts'))).path).toBe('tests/ok.e2e.ts');

    const escaped = await rejection(scripts.getScript('../' + path.basename(outside) + '/secret.e2e.ts'));
    expect(escaped.code).toBe('POLICY_DENIED');
    const absolute = await rejection(scripts.getScript(path.join(outside, 'secret.e2e.ts')));
    expect(absolute.code).toBe('POLICY_DENIED');
    const saved = await rejection(scripts.saveScript('../' + path.basename(outside) + '/new.e2e.ts', 'x', false));
    expect(saved.code).toBe('POLICY_DENIED');
  });

  it('refuses anything that is not an .e2e.ts file', async () => {
    const dir = root();
    writeFileSync(path.join(dir, 'notes.md'), 'x');
    const scripts = await service(dir);

    const wrongName = await rejection(scripts.getScript('notes.md'));
    expect(wrongName.code).toBe('INVALID_ARGUMENT');
    const bare = await rejection(scripts.getScript(path.join(dir, '.e2e.ts')));
    expect(bare.code).toBe('INVALID_ARGUMENT');
    const control = await rejection(scripts.getScript('tests/a\u0000.e2e.ts'));
    expect(control.code).toBe('INVALID_ARGUMENT');
    const empty = await rejection(scripts.getScript(''));
    expect(empty.code).toBe('INVALID_ARGUMENT');
  });

  it('does not follow a linked directory out of the root', async () => {
    const dir = root();
    const outside = root();
    writeFileSync(path.join(outside, 'escape.e2e.ts'), 'escape');
    // A junction needs no elevated privilege where a directory symlink does.
    symlinkSync(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const scripts = await service(dir);

    const error = await rejection(scripts.getScript('linked/escape.e2e.ts'));
    expect(error.code).toBe('POLICY_DENIED');
    // A save under the link would have to create the missing directory there.
    const nested = await rejection(scripts.saveScript('linked/new/sub.e2e.ts', 'x', false));
    expect(nested.code).toBe('POLICY_DENIED');
    expect(existsSync(path.join(outside, 'new'))).toBe(false);
  });
});

describe('ScriptService get and save', () => {
  it('reports a missing script, and creates missing parents on save', async () => {
    const dir = root();
    const scripts = await service(dir);

    expect((await rejection(scripts.getScript('tests/absent.e2e.ts'))).code).toBe('SCRIPT_NOT_FOUND');

    const created = await scripts.saveScript('no-dir/deeper/new.e2e.ts', 'x', false);
    expect(created).toEqual({ path: 'no-dir/deeper/new.e2e.ts', bytes: 1, created: true });
    expect(readFileSync(path.join(dir, 'no-dir', 'deeper', 'new.e2e.ts'), 'utf8')).toBe('x');
  });

  it('creates a script, then refuses to replace it without overwrite', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    const scripts = await service(dir);

    const created = await scripts.saveScript('tests/new.e2e.ts', 'first', false);
    expect(created).toEqual({ path: 'tests/new.e2e.ts', bytes: 5, created: true });
    expect(readFileSync(path.join(dir, 'tests', 'new.e2e.ts'), 'utf8')).toBe('first');

    const exists = await rejection(scripts.saveScript('tests/new.e2e.ts', 'second', false));
    expect(exists.code).toBe('SCRIPT_EXISTS');

    const replaced = await scripts.saveScript('tests/new.e2e.ts', 'second', true);
    expect(replaced.created).toBe(false);
    expect(readFileSync(path.join(dir, 'tests', 'new.e2e.ts'), 'utf8')).toBe('second');
    expect(readdirSync(path.join(dir, 'tests'))).toEqual(['new.e2e.ts']);
  });

  it('refuses content over the per-file limit and leaves the target alone', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests', 'big.e2e.ts'), 'keep');
    const scripts = await service(dir);

    expect((await rejection(scripts.saveScript('tests/big.e2e.ts', 'x'.repeat(MAX_SCRIPT_BYTES + 1), true))).code).toBe('INVALID_ARGUMENT');
    expect(readFileSync(path.join(dir, 'tests', 'big.e2e.ts'), 'utf8')).toBe('keep');
  });

  it('serializes concurrent saves of one path', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    const scripts = await service(dir);

    await Promise.all([
      scripts.saveScript('tests/race.e2e.ts', 'a', true),
      scripts.saveScript('tests/race.e2e.ts', 'b', true),
    ]);
    // The second call is queued behind the first: the last complete write wins.
    expect(readFileSync(path.join(dir, 'tests', 'race.e2e.ts'), 'utf8')).toBe('b');
    expect(readdirSync(path.join(dir, 'tests'))).toEqual(['race.e2e.ts']);
  });

  it('lets exactly one of two concurrent creates win', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    const scripts = await service(dir);

    const results = await Promise.allSettled([
      scripts.saveScript('tests/one.e2e.ts', 'a', false),
      scripts.saveScript('tests/one.e2e.ts', 'b', false),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect((failed.reason as { code: string }).code).toBe('SCRIPT_EXISTS');
    expect(readFileSync(path.join(dir, 'tests', 'one.e2e.ts'), 'utf8')).toBe('a');
  });
});

describe('ScriptService list', () => {
  it('groups collected pairs by file, inside the root only', async () => {
    const dir = root();
    writeFiles(dir, 'tests/forms.e2e.ts', 'tests/login.e2e.ts');
    const scripts = await service(dir, collecting(dir));

    const result = await scripts.listScripts({ keyword: 'fixture' }, new AbortController().signal);
    expect(result.scripts.map((script) => script.path)).toEqual(['tests/forms.e2e.ts', 'tests/login.e2e.ts']);
    expect(result.scripts[0]?.tests).toEqual([
      { title: 'submits the form', target: 'web', agent: 'default', tags: [] },
      { title: 'rejects a bad email', target: 'web', agent: 'default', tags: ['slow'] },
    ]);
    expect(result.total).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('maps project-relative files against the project root and lists only the test root', async () => {
    const dir = root();
    const testRoot = path.join(dir, 'tests');
    writeFiles(dir, 'tests/nested/a.e2e.ts', 'other.e2e.ts');
    const cli = fakeCli(
      dir,
      `console.log(${JSON.stringify(
        JSON.stringify({
          projectRoot: dir,
          pairs: [
            { file: 'tests/nested/a.e2e.ts', title: 'inside', target: 'web', agent: 'default', tags: [] },
            { file: 'other.e2e.ts', title: 'outside', target: 'web', agent: 'default', tags: [] },
          ],
        }),
      )})`,
    );
    const scripts = await service(testRoot, cli);

    const result = await scripts.listScripts({ keyword: 'fixture' }, new AbortController().signal);
    expect(result.scripts.map((script) => script.path)).toEqual(['nested/a.e2e.ts']);
    // The listed path is the one get_test_script takes.
    expect((await scripts.getScript('nested/a.e2e.ts')).content).toBe('// fixture');
  });

  it('narrows the scan by prefix, searches the source, and reports truncation', async () => {
    const dir = root();
    writeFiles(dir, 'tests/forms.e2e.ts', 'tests/login.e2e.ts');
    writeFileSync(path.join(dir, 'tests', 'forms.e2e.ts'), '// fixture bad email');
    const scripts = await service(dir, collecting(dir));
    const signal = new AbortController().signal;

    expect((await scripts.listScripts({ prefix: './tests/login', keyword: 'fixture' }, signal)).scripts.map((script) => script.path)).toEqual([
      'tests/login.e2e.ts',
    ]);
    expect((await scripts.listScripts({ keyword: 'BAD EMAIL' }, signal)).scripts.map((script) => script.path)).toEqual([
      'tests/forms.e2e.ts',
    ]);
    const limited = await scripts.listScripts({ keyword: 'fixture', limit: 1 }, signal);
    expect(limited.scripts).toHaveLength(1);
    expect(limited.total).toBe(2);
    expect(limited.truncated).toBe(true);
  });

  it('collects only the files the scan matched', async () => {
    const dir = root();
    writeFiles(dir, 'tests/healthy/a.e2e.ts', 'tests/other/b.e2e.ts');
    const result = {
      projectRoot: dir,
      pairs: [
        { file: 'tests/healthy/a.e2e.ts', title: 'healthy', target: 'web', agent: 'default', tags: [] },
        { file: 'tests/other/b.e2e.ts', title: 'other', target: 'web', agent: 'default', tags: [] },
      ],
    };
    const cli = fakeCli(
      dir,
      `import path from 'node:path';
const names = process.argv.slice(2).filter((arg) => arg.endsWith('.e2e.ts')).map((arg) => path.basename(arg)).toSorted();
if (names.join(',') !== 'a.e2e.ts') process.exitCode = 2;
else console.log(${JSON.stringify(JSON.stringify(result))});`,
    );
    const scripts = await service(dir, cli);
    const listed = await scripts.listScripts({ prefix: 'tests/healthy', keyword: 'fixture' }, new AbortController().signal);
    expect(listed.scripts.map((script) => script.path)).toEqual(['tests/healthy/a.e2e.ts']);
  });

  it('imports the matched candidates and any file that may declare a setup', async () => {
    const dir = root();
    writeFiles(dir, 'tests/setup.e2e.ts', 'tests/consumer.e2e.ts');
    writeFileSync(path.join(dir, 'tests', 'setup.e2e.ts'), "import { test } from 'e2e';\n\ntest.setup('signs in', { session: 'tester' }, async () => {});\n");
    writeFileSync(path.join(dir, 'tests', 'consumer.e2e.ts'), '// fixture');
    const calls = path.join(dir, 'calls.txt');
    const cli = fakeCli(
      dir,
      `import path from 'node:path';
import { appendFileSync } from 'node:fs';
const names = process.argv.slice(2).filter((arg) => arg.endsWith('.e2e.ts')).map((arg) => path.basename(arg)).toSorted();
appendFileSync(${JSON.stringify(calls)}, process.argv.includes('--imports-named') + ' ' + names.join(',') + '\\n');
console.log(JSON.stringify({ projectRoot: ${JSON.stringify(dir)}, pairs: [
  { file: 'tests/consumer.e2e.ts', title: 'consumer', target: 'web', agent: 'default', tags: [] },
]}));`,
    );
    const scripts = await service(dir, cli);

    const listed = await scripts.listScripts({ keyword: 'fixture' }, new AbortController().signal);
    // The setup file matched nothing, but a selected test may consume its session.
    expect(readFileSync(calls, 'utf8').trim()).toBe('true consumer.e2e.ts,setup.e2e.ts');
    expect(listed.scripts.map((script) => script.path)).toEqual(['tests/consumer.e2e.ts']);
  });

  it('falls back to the full collection when the narrowed one fails', async () => {
    const dir = root();
    writeFiles(dir, 'tests/forms.e2e.ts', 'tests/login.e2e.ts');
    const calls = path.join(dir, 'calls.txt');
    const cli = fakeCli(
      dir,
      `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, process.argv.includes('--imports-named') ? 'narrow\\n' : 'full\\n');
if (process.argv.includes('--imports-named')) process.exitCode = 2;
else console.log(${JSON.stringify(JSON.stringify(collected(dir)))});`,
    );
    const scripts = await service(dir, cli);

    const listed = await scripts.listScripts({ keyword: 'fixture' }, new AbortController().signal);
    expect(readFileSync(calls, 'utf8').trim()).toBe('narrow\nfull');
    expect(listed.scripts.map((script) => script.path)).toEqual(['tests/forms.e2e.ts', 'tests/login.e2e.ts']);
  });

  it('reports a file the collection could not read instead of failing', async () => {
    const dir = root();
    writeFiles(dir, 'tests/healthy/a.e2e.ts', 'tests/broken/b.e2e.ts');
    const result = {
      projectRoot: dir,
      pairs: [{ file: 'tests/healthy/a.e2e.ts', title: 'healthy', target: 'web', agent: 'default', tags: [] }],
      targets: [
        { name: 'web', url: 'https://example.test' },
        { name: 'device' },
      ],
      uncollected: [
        { file: 'tests/broken/b.e2e.ts', reason: 'Invalid Unicode escape sequence' },
        { file: '../outside/b.e2e.ts', reason: 'outside the root' },
      ],
    };
    const cli = fakeCli(
      dir,
      `if (!process.argv.includes('--allow-uncollected')) process.exitCode = 2;
else console.log(${JSON.stringify(JSON.stringify(result))});`,
    );
    const scripts = await service(dir, cli);
    const signal = new AbortController().signal;

    const listed = await scripts.listScripts({ keyword: 'fixture' }, signal);
    expect(listed.scripts.map((script) => script.path)).toEqual(['tests/healthy/a.e2e.ts']);
    // A path under the test root only, and no reason: a collection error can quote the source.
    expect(listed.uncollected).toEqual(['tests/broken/b.e2e.ts']);
    // Targets carry the app URL a caller picks one by, and nothing secret.
    expect(listed.targets).toEqual([
      { name: 'web', url: 'https://example.test' },
      { name: 'device' },
    ]);
    // A prefix narrows the failures the same way it narrows the scripts.
    expect((await scripts.listScripts({ prefix: 'tests/healthy', keyword: 'fixture' }, signal)).uncollected).toEqual([]);
  });

  it('turns a failed, silent, or malformed collection into COLLECTION_ERROR', async () => {
    const dir = root();
    writeFiles(dir, 'tests/a.e2e.ts');
    const signal = new AbortController().signal;

    const failed = await service(dir, fakeCli(dir, 'console.error("boom"); process.exitCode = 1;'));
    expect((await rejection(failed.listScripts({ keyword: 'fixture' }, signal))).code).toBe('COLLECTION_ERROR');

    const malformed = await service(dir, fakeCli(dir, 'console.log("not json");'));
    expect((await rejection(malformed.listScripts({ keyword: 'fixture' }, signal))).code).toBe('COLLECTION_ERROR');

    const shapeless = await service(dir, fakeCli(dir, 'console.log("{}");'));
    expect((await rejection(shapeless.listScripts({ keyword: 'fixture' }, signal))).code).toBe('COLLECTION_ERROR');
  });

  it('waits for a running collection before saving, so its candidate is never collected', async () => {
    const dir = root();
    writeFiles(dir, 'tests/forms.e2e.ts', 'tests/login.e2e.ts');
    const started = path.join(dir, 'collecting.txt');
    const release = path.join(dir, 'release.txt');
    // The child finishes only when the test lets it, so the order is fixed.
    const cli = fakeCli(
      dir,
      `import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(started)}, 'x');
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 20));
console.log(${JSON.stringify(JSON.stringify(collected(dir)))});
`,
    );
    const scripts = await service(dir, cli);
    const pending = scripts.listScripts({ keyword: 'fixture' }, new AbortController().signal);
    await expect.poll(() => existsSync(started), { timeout: 10_000 }).toBe(true);
    let saved = false;
    const saving = scripts.saveScript('tests/during.e2e.ts', '// fixture', false).then(() => {
      saved = true;
    });
    // The save is queued behind the collection, so no candidate exists yet.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(saved).toBe(false);
    expect(existsSync(path.join(dir, 'tests', 'during.e2e.ts'))).toBe(false);
    expect(readdirSync(path.join(dir, 'tests')).toSorted()).toEqual(['forms.e2e.ts', 'login.e2e.ts']);
    writeFileSync(release, 'go');
    await saving;
    expect((await pending).scripts.map((script) => script.path)).toEqual(['tests/forms.e2e.ts', 'tests/login.e2e.ts']);
    expect(readFileSync(path.join(dir, 'tests', 'during.e2e.ts'), 'utf8')).toBe('// fixture');
  });

  it('queues a listing behind a save that is validating its candidate', async () => {
    const dir = root();
    writeFiles(dir, 'tests/forms.e2e.ts', 'tests/login.e2e.ts');
    writeFileSync(path.join(dir, 'tests', 'bad.e2e.ts'), 'old');
    const validating = path.join(dir, 'validating.txt');
    const listed = path.join(dir, 'listed.txt');
    const release = path.join(dir, 'release.txt');
    // The candidate validation blocks; a listing that got the lock next would
    // see the temporary file, so it must wait.
    const cli = fakeCli(
      dir,
      `import { existsSync, writeFileSync } from 'node:fs';
if (process.argv.some((arg) => arg.endsWith('.tmp.e2e.ts'))) {
  writeFileSync(${JSON.stringify(validating)}, 'x');
  while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 20));
  console.error('broken');
  process.exitCode = 2;
} else {
  writeFileSync(${JSON.stringify(listed)}, 'x');
  console.log(${JSON.stringify(JSON.stringify(collected(dir)))});
}`,
    );
    const scripts = await service(dir, cli);
    const saving = scripts.saveScript('tests/bad.e2e.ts', 'broken', true);
    await expect.poll(() => existsSync(validating), { timeout: 10_000 }).toBe(true);
    const pending = scripts.listScripts({ keyword: 'fixture' }, new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(listed)).toBe(false);
    writeFileSync(release, 'go');
    expect((await rejection(saving)).code).toBe('COLLECTION_ERROR');
    expect(readFileSync(path.join(dir, 'tests', 'bad.e2e.ts'), 'utf8')).toBe('old');
    expect((await pending).scripts.map((script) => script.path)).toEqual(['tests/forms.e2e.ts', 'tests/login.e2e.ts']);
  });

  it('refuses a script the runner cannot collect and keeps the old file', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    writeFileSync(path.join(dir, 'tests', 'bad.e2e.ts'), 'old');
    // A candidate is the only call the collection child sees with a .tmp name;
    // it fails the way a real import failure does. The candidate validation
    // must never ask for --allow-uncollected: with it, this branch would
    // succeed and the save would land.
    const cli = fakeCli(
      dir,
      `if (process.argv.at(-1)?.includes('.tmp.e2e.ts') === true) {
  if (process.argv.includes('--allow-uncollected')) console.log(${JSON.stringify(JSON.stringify({ projectRoot: dir, pairs: [] }))});
  else { console.error('boom'); process.exitCode = 2; }
} else console.log(${JSON.stringify(JSON.stringify(collected(dir)))});`,
    );
    const scripts = await service(dir, cli);

    const error = await rejection(scripts.saveScript('tests/bad.e2e.ts', 'broken', true));
    expect(error.code).toBe('COLLECTION_ERROR');
    expect(error.message).toContain('tests/bad.e2e.ts');
    expect(error.message).toContain('exit 2');
    expect(error.message).not.toContain('boom');
    expect(readFileSync(path.join(dir, 'tests', 'bad.e2e.ts'), 'utf8')).toBe('old');
    // The candidate is removed, so the failed save leaves no trace.
    expect(readdirSync(path.join(dir, 'tests'))).toEqual(['bad.e2e.ts']);
  });

  it('removes a candidate a killed save left behind when the service starts', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    const leftover = path.join(dir, 'tests', 'left.e2e.ts.00000000-0000-4000-8000-000000000000.tmp.e2e.ts');
    const lookalike = path.join(dir, 'tests', 'left.e2e.ts.tmp.e2e.ts');
    writeFileSync(leftover, 'broken');
    writeFileSync(lookalike, 'not ours');

    await service(dir, path.join(dir, 'missing-cli.mjs'));

    expect(existsSync(leftover)).toBe(false);
    expect(readFileSync(lookalike, 'utf8')).toBe('not ours');
  });

  it('does not return collection stderr, which project code controls', async () => {
    const dir = root();
    writeFiles(dir, 'tests/a.e2e.ts');
    const cli = fakeCli(dir, `process.stderr.write('x'.repeat(64 * 1024)); process.exitCode = 1;`);
    const error = await rejection((await service(dir, cli)).listScripts({ keyword: 'fixture' }, new AbortController().signal));
    expect(error.code).toBe('COLLECTION_ERROR');
    expect(error.message).not.toContain('xxx');
    expect(error.message).toContain('exit 1');
  });

  it('refuses unknown arguments and over-limit values before touching a file', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    const scripts = await service(dir);
    const signal = new AbortController().signal;

    const errors = await Promise.all([
      rejection(scripts.call('list_test_scripts', { unknown: true }, signal)),
      rejection(scripts.call('list_test_scripts', { keyword: 'fixture', limit: 0 }, signal)),
      rejection(scripts.call('list_test_scripts', { keyword: 'fixture', limit: 501 }, signal)),
      rejection(scripts.call('get_test_script', { path: 'tests/a.e2e.ts', extra: 1 }, signal)),
      rejection(scripts.call('get_test_script', { path: `${'a'.repeat(512)}.e2e.ts` }, signal)),
      rejection(scripts.call('save_test_script', { path: 'tests/a.e2e.ts', content: 'x'.repeat(MAX_SCRIPT_BYTES + 1) }, signal)),
    ]);
    expect(errors.map((error) => error.code)).toEqual(Array.from({ length: errors.length }, () => 'INVALID_ARGUMENT'));
  });

  it('returns every tool result as compact JSON', async () => {
    const dir = root();
    writeFiles(dir, 'tests/a.e2e.ts');
    const scripts = await service(dir);
    const signal = new AbortController().signal;

    const listed = await scripts.call('list_test_scripts', { keyword: 'fixture' }, signal);
    const read = await scripts.call('get_test_script', { path: 'tests/a.e2e.ts' }, signal);
    const saved = await scripts.call('save_test_script', { path: 'tests/new.e2e.ts', content: '// fixture' }, signal);

    for (const result of [listed, read, saved]) {
      const text = textOf(result);
      expect(text).not.toContain('\n');
      expect(() => JSON.parse(text) as unknown).not.toThrow();
    }
    expect(JSON.parse(textOf(read)) as unknown).toEqual({ path: 'tests/a.e2e.ts', content: '// fixture' });
  });

  it('requires a keyword, collects only the files it matches, and ranks by title', async () => {
    const dir = root();
    writeFiles(dir, 'tests/a.e2e.ts', 'tests/b.e2e.ts', 'tests/c.e2e.ts');
    writeFileSync(path.join(dir, 'tests', 'a.e2e.ts'), '// 登录 登录');
    writeFileSync(path.join(dir, 'tests', 'b.e2e.ts'), '// 登录');
    writeFileSync(path.join(dir, 'tests', 'c.e2e.ts'), '// unrelated');
    const calls = path.join(dir, 'calls.txt');
    const cli = fakeCli(
      dir,
      `import path from 'node:path';
import { appendFileSync } from 'node:fs';
const names = process.argv.slice(2).filter((arg) => arg.endsWith('.e2e.ts')).map((arg) => path.basename(arg)).toSorted();
appendFileSync(${JSON.stringify(calls)}, names.join(',') + '\\n');
console.log(JSON.stringify({ projectRoot: ${JSON.stringify(dir)}, pairs: [
  { file: 'tests/a.e2e.ts', title: '登录 登录', target: 'web', agent: 'default', tags: [] },
  { file: 'tests/b.e2e.ts', title: '登录', target: 'web', agent: 'default', tags: [] },
]}));`,
    );
    const scripts = await service(dir, cli);
    const signal = new AbortController().signal;

    const missing = await rejection(scripts.call('list_test_scripts', {}, signal));
    expect(missing.code).toBe('INVALID_ARGUMENT');
    expect(missing.message).toContain('keyword');
    expect(existsSync(calls)).toBe(false);

    const listed = await scripts.listScripts({ keyword: '登录' }, signal);
    expect(readFileSync(calls, 'utf8').trim()).toBe('a.e2e.ts,b.e2e.ts');
    expect(listed.scripts.map((script) => script.path)).toEqual(['tests/a.e2e.ts', 'tests/b.e2e.ts']);
    expect(listed.total).toBe(2);

    const empty = await scripts.listScripts({ keyword: '不存在的关键词xyz' }, signal);
    expect(empty.scripts).toEqual([]);
    expect(empty.total).toBe(0);
    expect(empty.truncated).toBe(false);
    // A miss starts no collection child: the call log still has one line.
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('refuses a keyword that is blank, oversized, or carries a control character', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    // No CLI exists: a valid keyword would fail collection, an invalid one never runs it.
    const scripts = await service(dir, path.join(dir, 'missing-cli.mjs'));
    const signal = new AbortController().signal;

    for (const keyword of ['', '   ', 'a'.repeat(201), 'break\nout', 42]) {
      const error = await rejection(scripts.call('list_test_scripts', { keyword }, signal));
      expect(error.code).toBe('INVALID_ARGUMENT');
      expect(error.message).toContain('keyword');
    }
    // A keyword with no searchable token is a valid search that matches nothing.
    const noTokens = await scripts.call('list_test_scripts', { keyword: '***' }, signal);
    expect(JSON.parse(textOf(noTokens)) as unknown).toEqual({ scripts: [], total: 0, truncated: false, uncollected: [], targets: [] });
  });

  it('collects at most the top 100 scan hits, best first, and reports the rest as truncated', async () => {
    const dir = root();
    // Hits rise with the index, so the top 100 are f020..f119, not the first
    // 100 by path.
    const names = Array.from({ length: 120 }, (_, index) => `f${String(index).padStart(3, '0')}.e2e.ts`);
    writeFiles(dir, ...names.map((name) => `tests/${name}`));
    names.forEach((name, index) => {
      writeFileSync(path.join(dir, 'tests', name), `// ${'fixture '.repeat(index + 1)}`);
    });
    const calls = path.join(dir, 'candidates.txt');
    const cli = fakeCli(
      dir,
      `import path from 'node:path';
import { appendFileSync } from 'node:fs';
const names = process.argv.slice(2).filter((arg) => arg.endsWith('.e2e.ts')).map((arg) => path.basename(arg)).toSorted();
appendFileSync(${JSON.stringify(calls)}, names.join('\\n') + '\\n');
console.log(JSON.stringify({ projectRoot: ${JSON.stringify(dir)}, pairs: names.map((name) => ({ file: 'tests/' + name, title: name, target: 'web', agent: 'default', tags: [] })) }));`,
    );
    const scripts = await service(dir, cli);

    const listed = await scripts.listScripts({ keyword: 'fixture' }, new AbortController().signal);
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toEqual(names.slice(20));
    expect(listed.scripts.map((script) => script.path)).toEqual(names.slice(20).map((name) => `tests/${name}`));
    expect(listed.total).toBe(120);
    expect(listed.truncated).toBe(true);
  });

  it('ranks a title hit above a tag hit above a path hit', async () => {
    const dir = root();
    // The scan matches the source; relevance then weighs path, titles, and tags.
    writeFiles(dir, 'tests/a-checkout.e2e.ts', 'tests/b.e2e.ts', 'tests/c.e2e.ts');
    for (const file of ['tests/a-checkout.e2e.ts', 'tests/b.e2e.ts', 'tests/c.e2e.ts']) {
      writeFileSync(path.join(dir, file), '// checkout');
    }
    const cli = fakeCli(
      dir,
      `console.log(JSON.stringify({ projectRoot: ${JSON.stringify(dir)}, pairs: [
  { file: 'tests/a-checkout.e2e.ts', title: 'plain', target: 'web', agent: 'default', tags: [] },
  { file: 'tests/b.e2e.ts', title: 'plain', target: 'web', agent: 'default', tags: ['checkout'] },
  { file: 'tests/c.e2e.ts', title: 'checkout', target: 'web', agent: 'default', tags: [] },
]}));`,
    );
    const scripts = await service(dir, cli);

    const listed = await scripts.listScripts({ keyword: 'checkout' }, new AbortController().signal);
    expect(listed.scripts.map((script) => script.path)).toEqual(['tests/c.e2e.ts', 'tests/b.e2e.ts', 'tests/a-checkout.e2e.ts']);
  });

  it('refuses a prefix that leaves the test root, through a link too', async () => {
    const dir = root();
    const outside = root();
    writeFiles(dir, 'tests/a.e2e.ts');
    writeFiles(outside, 'secret.e2e.ts');
    // A junction needs no elevated privilege where a directory symlink does.
    symlinkSync(outside, path.join(dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const scripts = await service(dir, path.join(dir, 'missing-cli.mjs'));
    const signal = new AbortController().signal;

    for (const prefix of ['..', '../outside', path.join(dir, '..', 'outside'), 'linked']) {
      const error = await rejection(scripts.call('list_test_scripts', { prefix, keyword: 'fixture' }, signal));
      expect(error.code).toBe('POLICY_DENIED');
      expect(error.message).toContain('outside the test root');
    }
  });

  it('refuses a test root that is not a directory', async () => {
    const dir = root();
    const file = path.join(dir, 'file.txt');
    writeFileSync(file, 'x');

    // The root check runs before the CLI is ever used, so it need not exist.
    const cli = path.join(dir, 'missing-cli.mjs');
    expect((await rejection(service(file, cli))).code).toBe('INVALID_ARGUMENT');
    expect((await rejection(service(path.join(dir, 'missing'), cli))).code).toBe('INVALID_ARGUMENT');
  });
});
