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

function service(dir: string, cliEntry = path.join(dir, 'missing-cli.mjs')): Promise<ScriptService> {
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
  };
}

/** A fake CLI whose stdout is this collection result. */
function collecting(dir: string, projectRoot = dir): string {
  return fakeCli(dir, `console.log(${JSON.stringify(JSON.stringify(collected(projectRoot)))})`);
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
    // Listing imports every test file's top-level code; only reading is a read.
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

    const result = await scripts.listScripts({}, new AbortController().signal);
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

    const result = await scripts.listScripts({}, new AbortController().signal);
    expect(result.scripts.map((script) => script.path)).toEqual(['nested/a.e2e.ts']);
    // The listed path is the one get_test_script takes.
    expect((await scripts.getScript('nested/a.e2e.ts')).content).toBe('// fixture');
  });

  it('filters by prefix and keyword, and reports truncation', async () => {
    const dir = root();
    writeFiles(dir, 'tests/forms.e2e.ts', 'tests/login.e2e.ts');
    const scripts = await service(dir, collecting(dir));
    const signal = new AbortController().signal;

    expect((await scripts.listScripts({ prefix: './tests/login' }, signal)).scripts.map((script) => script.path)).toEqual([
      'tests/login.e2e.ts',
    ]);
    expect((await scripts.listScripts({ keyword: 'BAD EMAIL' }, signal)).scripts.map((script) => script.path)).toEqual([
      'tests/forms.e2e.ts',
    ]);
    const limited = await scripts.listScripts({ limit: 1 }, signal);
    expect(limited.scripts).toHaveLength(1);
    expect(limited.total).toBe(2);
    expect(limited.truncated).toBe(true);
  });

  it('turns a failed, silent, or malformed collection into COLLECTION_ERROR', async () => {
    const dir = root();
    const signal = new AbortController().signal;

    const failed = await service(dir, fakeCli(dir, 'console.error("boom"); process.exitCode = 1;'));
    expect((await rejection(failed.listScripts({}, signal))).code).toBe('COLLECTION_ERROR');

    const malformed = await service(dir, fakeCli(dir, 'console.log("not json");'));
    expect((await rejection(malformed.listScripts({}, signal))).code).toBe('COLLECTION_ERROR');

    const shapeless = await service(dir, fakeCli(dir, 'console.log("{}");'));
    expect((await rejection(shapeless.listScripts({}, signal))).code).toBe('COLLECTION_ERROR');
  });

  it('reports a save that lands while collection runs as SCRIPT_CHANGED', async () => {
    const dir = root();
    mkdirSync(path.join(dir, 'tests'));
    const started = path.join(dir, 'collecting.txt');
    const release = path.join(dir, 'release.txt');
    // The child finishes only after the test saved, so the race is fixed.
    const cli = fakeCli(
      dir,
      `import { existsSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(started)}, 'x');
while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 20));
console.log(${JSON.stringify(JSON.stringify(collected(dir)))});
`,
    );
    const scripts = await service(dir, cli);
    const pending = scripts.listScripts({}, new AbortController().signal);
    await expect.poll(() => existsSync(started), { timeout: 10_000 }).toBe(true);
    await scripts.saveScript('tests/during.e2e.ts', '// fixture', false);
    writeFileSync(release, 'go');
    expect((await rejection(pending)).code).toBe('SCRIPT_CHANGED');
  });

  it('does not return collection stderr, which project code controls', async () => {
    const dir = root();
    const cli = fakeCli(dir, `process.stderr.write('x'.repeat(64 * 1024)); process.exitCode = 1;`);
    const error = await rejection((await service(dir, cli)).listScripts({}, new AbortController().signal));
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
      rejection(scripts.call('list_test_scripts', { limit: 0 }, signal)),
      rejection(scripts.call('list_test_scripts', { limit: 501 }, signal)),
      rejection(scripts.call('get_test_script', { path: 'tests/a.e2e.ts', extra: 1 }, signal)),
      rejection(scripts.call('get_test_script', { path: `${'a'.repeat(512)}.e2e.ts` }, signal)),
      rejection(scripts.call('save_test_script', { path: 'tests/a.e2e.ts', content: 'x'.repeat(MAX_SCRIPT_BYTES + 1) }, signal)),
    ]);
    expect(errors.map((error) => error.code)).toEqual(Array.from({ length: errors.length }, () => 'INVALID_ARGUMENT'));
  });

  it('refuses a test root that is not a directory', async () => {
    const dir = root();
    const file = path.join(dir, 'file.txt');
    writeFileSync(file, 'x');

    expect((await rejection(service(file))).code).toBe('INVALID_ARGUMENT');
    expect((await rejection(service(path.join(dir, 'missing')))).code).toBe('INVALID_ARGUMENT');
  });
});
