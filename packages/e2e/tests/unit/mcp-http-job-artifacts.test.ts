/**
 * The artifact half of the job store without a Runner: which files a job's
 * report names, the copy under the job directory, the caps, path refusals,
 * and the index the listing and the download route read.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listedArtifacts,
  preserveJobArtifacts,
  readJobArtifactIndex,
  readReportArtifacts,
} from '../../src/mcp/http/job-artifacts.ts';

const roots: string[] = [];

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'e2e-job-artifacts-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha256(bytes: string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifact(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'attempt-1:artifact:0',
    kind: 'screenshot',
    mediaType: 'image/png',
    path: 'checkout/attempt-1/screenshots/001.png',
    size: 3,
    sha256: sha256('png'),
    redaction: 'complete',
    producer: { kind: 'attempt' },
    ...overrides,
  };
}

function writeReport(output: string, results: readonly unknown[], serialGroups: readonly unknown[] = []): void {
  mkdirSync(output, { recursive: true });
  writeFileSync(
    path.join(output, 'report.json'),
    JSON.stringify({ schemaVersion: 'report-1', run: { results, serialGroups } }),
    'utf8',
  );
}

function writeResult(output: string, relative: string, bytes: string): void {
  const file = path.join(output, 'results', ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes, 'utf8');
}

async function preserve(options: {
  output: string;
  store: string;
  resultIds: readonly string[];
  jobId?: string;
  report?: Awaited<ReturnType<typeof readReportArtifacts>>;
}): Promise<Awaited<ReturnType<typeof readJobArtifactIndex>>> {
  const jobId = options.jobId ?? 'job-a';
  await preserveJobArtifacts({
    jobId,
    resultIds: options.resultIds,
    report: options.report === undefined ? await readReportArtifacts(options.output) : options.report,
    output: options.output,
    dir: path.join(options.store, 'artifacts', jobId),
    indexFile: path.join(options.store, 'artifacts', `${jobId}.json`),
  });
  return readJobArtifactIndex(path.join(options.store, 'artifacts', `${jobId}.json`));
}

describe('HTTP MCP job artifacts', () => {
  it('copies only the job\'s files and keeps url-only and withheld artifacts in the listing', async () => {
    const dir = root();
    const output = path.join(dir, 'run');
    writeResult(output, 'checkout/attempt-1/screenshots/001.png', 'png');
    writeResult(output, 'other/attempt-1/screenshots/002.png', 'other');
    writeReport(
      output,
      [
        { id: 'result-a', attempts: [{ index: 0, artifacts: [artifact()] }] },
        {
          id: 'result-b',
          attempts: [{ index: 0, artifacts: [artifact({ id: 'b', path: 'other/attempt-1/screenshots/002.png' })] }],
        },
      ],
    );

    const index = await preserve({
      output,
      store: dir,
      resultIds: ['result-a'],
    });

    expect(index).toMatchObject({ version: 1, jobId: 'job-a' });
    expect(index?.error).toBeUndefined();
    expect(index?.artifacts).toHaveLength(1);
    expect(index?.artifacts[0]).toMatchObject({
      artifactId: 'attempt-1:artifact:0',
      kind: 'screenshot',
      mediaType: 'image/png',
      resultId: 'result-a',
      attempt: 1,
      fileName: '001.png',
      file: '0.png',
      size: 3,
      sha256: sha256('png'),
    });
    expect(readFileSync(path.join(dir, 'artifacts', 'job-a', '0.png'), 'utf8')).toBe('png');

    const listing = listedArtifacts(index!, 'http://gateway.example/mcp/e2e');
    expect(listing.ready).toBe(true);
    expect(listing.truncated).toBe(false);
    expect(listing.artifacts[0]).toMatchObject({ downloadUrl: 'http://gateway.example/mcp/e2e/artifacts/job-a/0' });
    expect(listing.artifacts[0]).not.toHaveProperty('file');
  });

  it('keeps a serial group\'s artifacts for its members once, including hosted and withheld videos', async () => {
    const dir = root();
    const output = path.join(dir, 'run');
    writeResult(output, 'group/attempt-1/screenshots/001.png', 'png');
    writeReport(
      output,
      [
        { id: 'member-a', serialGroupId: 'group-1', attempts: [] },
        { id: 'member-b', serialGroupId: 'group-1', attempts: [] },
      ],
      [
        {
          id: 'group-1',
          attempts: [
            {
              index: 0,
              artifacts: [
                artifact({ path: 'group/attempt-1/screenshots/001.png' }),
                artifact({
                  id: 'hosted',
                  kind: 'video',
                  mediaType: 'video/webm',
                  path: undefined,
                  url: 'https://videos.example/a.webm',
                }),
                artifact({ id: 'withheld', kind: 'video', mediaType: 'video/webm', path: undefined }),
              ],
            },
          ],
        },
      ],
    );

    const index = await preserve({ output, store: dir, resultIds: ['member-a', 'member-b'] });

    expect(index?.artifacts).toHaveLength(3);
    expect(index?.artifacts[0]).toMatchObject({ resultId: 'group-1', attempt: 1, file: '0.png' });
    expect(index?.artifacts[1]).toMatchObject({
      artifactId: 'hosted',
      url: 'https://videos.example/a.webm',
      fileName: 'a.webm',
    });
    expect(index?.artifacts[2]).toMatchObject({ artifactId: 'withheld', unavailable: 'no_local_file' });
  });

  it('refuses a path that leaves the run, a link that resolves outside, and a missing file', async () => {
    const dir = root();
    const output = path.join(dir, 'run');
    const outside = root();
    writeFileSync(path.join(outside, 'secret.png'), 'secret', 'utf8');
    writeResult(output, 'job/attempt-1/screenshots/001.png', 'png');
    mkdirSync(path.join(output, 'results', 'linked'), { recursive: true });
    symlinkSync(outside, path.join(output, 'results', 'linked', 'attempt-1'), process.platform === 'win32' ? 'junction' : 'dir');
    writeReport(output, [
      {
        id: 'result-a',
        attempts: [
          {
            index: 0,
            artifacts: [
              artifact({ id: 'escape', path: '../../secret.png' }),
              artifact({ id: 'link', path: 'linked/attempt-1/secret.png' }),
              artifact({ id: 'missing', path: 'job/attempt-1/screenshots/missing.png' }),
              artifact({ id: 'good', path: 'job/attempt-1/screenshots/001.png' }),
            ],
          },
        ],
      },
    ]);

    const index = await preserve({ output, store: dir, resultIds: ['result-a'] });

    expect(index?.artifacts.map((entry) => [entry.artifactId, entry.unavailable])).toEqual([
      ['escape', 'outside_run'],
      ['link', 'outside_run'],
      ['missing', 'missing_file'],
      ['good', undefined],
    ]);
  });

  it('skips a file over the per-artifact cap and copies nothing for it', async () => {
    const dir = root();
    const output = path.join(dir, 'run');
    const screenshots = path.join(output, 'results', 'job', 'attempt-1', 'screenshots');
    mkdirSync(screenshots, { recursive: true });
    // A sparse file stats at the cap without writing 257 MiB of data.
    const big = path.join(screenshots, 'big.png');
    writeFileSync(big, '');
    truncateSync(big, 257 * 1024 * 1024);
    writeReport(output, [
      {
        id: 'result-a',
        attempts: [
          {
            index: 0,
            artifacts: [artifact({ id: 'big', path: 'job/attempt-1/screenshots/big.png' })],
          },
        ],
      },
    ]);

    const index = await preserve({ output, store: dir, resultIds: ['result-a'] });

    expect(index?.artifacts[0]).toMatchObject({
      artifactId: 'big',
      size: 257 * 1024 * 1024,
      unavailable: 'file_too_large',
    });
    expect(existsSync(path.join(dir, 'artifacts', 'job-a', '0.png'))).toBe(false);
  });

  it('writes an index with report_unavailable when the run left no report', async () => {
    const dir = root();
    const output = path.join(dir, 'run');

    const index = await preserve({ output, store: dir, resultIds: ['result-a'] });

    expect(index).toMatchObject({ jobId: 'job-a', error: 'report_unavailable', artifacts: [] });
  });

  it('reads only stored file names, and drops an index entry that names a path', async () => {
    const dir = root();
    const file = path.join(dir, 'artifacts', 'job-a.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        jobId: 'job-a',
        createdAt: '2026-10-28T00:00:00.000Z',
        artifacts: [
          {
            artifactId: 'good',
            kind: 'screenshot',
            mediaType: 'image/png',
            redaction: 'complete',
            resultId: 'result-a',
            attempt: 1,
            fileName: '001.png',
            file: '0.png',
          },
          {
            artifactId: 'escape',
            kind: 'screenshot',
            mediaType: 'image/png',
            redaction: 'complete',
            resultId: 'result-a',
            attempt: 1,
            fileName: '002.png',
            file: '../escape.png',
          },
        ],
      }),
      'utf8',
    );

    const index = await readJobArtifactIndex(file);

    expect(index?.artifacts.map((entry) => entry.artifactId)).toEqual(['good']);
    expect(existsSync(file)).toBe(true);
  });
});
