/**
 * Artifacts a finished job keeps. The Runner writes them under its run output
 * and that directory is removed when the run stops, so the gateway copies the
 * files a report names into the job store first, with an index beside them.
 * `list_test_artifacts` reads the index; the download route streams the file.
 */

import { copyFile, lstat, mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../../internal/atomic-write.ts';

/** One file may take this much of a job's artifact budget. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
/** All files one job keeps may take this much. */
const MAX_JOB_ARTIFACT_BYTES = 1024 * 1024 * 1024;
/** Descriptors one listing returns before it is `truncated`. */
const MAX_LISTED_ARTIFACTS = 200;

export type JobArtifactKind = 'screenshot' | 'video' | 'download' | 'log' | 'other';

export type JobArtifactUnavailable =
  | 'file_too_large'
  | 'job_limit_reached'
  | 'missing_file'
  | 'outside_run'
  | 'copy_failed'
  | 'no_local_file';

/** One artifact as the report named it, plus where the job store keeps a copy. */
export interface JobArtifact {
  readonly artifactId: string;
  readonly kind: JobArtifactKind;
  readonly mediaType: string;
  readonly redaction: 'complete' | 'incomplete';
  readonly resultId: string;
  /** The attempt number, from 1, matching the report's `attempt-<n>` directory. */
  readonly attempt: number;
  readonly fileName: string;
  readonly size?: number;
  readonly sha256?: string;
  /** The stored copy under the job's artifact directory; absent when nothing is downloadable. */
  readonly file?: string;
  /** A provider-hosted artifact's URL, when the report named one instead of a path. */
  readonly url?: string;
  /** Why the artifact has no stored copy. */
  readonly unavailable?: JobArtifactUnavailable;
}

/** The per-job index written once the run output is gone. */
export interface JobArtifactIndex {
  readonly version: 1;
  readonly jobId: string;
  readonly createdAt: string;
  readonly error?: 'report_unavailable';
  readonly artifacts: readonly JobArtifact[];
}

/** One artifact as a tool returns it: no storage name, and a URL when it has one. */
export type ListedArtifact = Omit<JobArtifact, 'file'> & { readonly downloadUrl?: string };

/** What `list_test_artifacts` returns. */
export interface JobArtifactListing {
  readonly jobId: string;
  /** False while the run that produced the job is still alive or its copy is in flight. */
  readonly ready: boolean;
  readonly artifacts: readonly ListedArtifact[];
  readonly truncated: boolean;
  readonly error?: 'report_unavailable' | 'artifacts_unavailable';
}

/** A stored artifact the download route can stream. */
export interface StoredArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly fileName: string;
  readonly size: number;
}

/** The artifacts one report names, grouped by the result or serial group that owns them. */
export interface ReportArtifacts {
  readonly byResult: ReadonlyMap<string, readonly ReportArtifact[]>;
  readonly groupOfResult: ReadonlyMap<string, string>;
  readonly byGroup: ReadonlyMap<string, readonly ReportArtifact[]>;
}

/** One artifact named by `report.json`, before a job is chosen. */
export interface ReportArtifact {
  readonly artifactId: string;
  readonly kind: JobArtifactKind;
  readonly mediaType: string;
  readonly redaction: 'complete' | 'incomplete';
  readonly resultId: string;
  readonly attempt: number;
  readonly fileName: string;
  readonly path?: string;
  readonly url?: string;
  readonly size?: number;
  readonly sha256?: string;
}

/** Reads the artifact section of one run's `report.json`; undefined when it cannot. */
export async function readReportArtifacts(output: string): Promise<ReportArtifacts | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isObject(raw) || raw['schemaVersion'] !== 'report-1' || !isObject(raw['run'])) return undefined;
  const resultEntries = Array.isArray(raw['run']['results']) ? raw['run']['results'] : [];
  const groupEntries = Array.isArray(raw['run']['serialGroups']) ? raw['run']['serialGroups'] : [];
  const byResult = new Map<string, ReportArtifact[]>();
  const groupOfResult = new Map<string, string>();
  const byGroup = new Map<string, ReportArtifact[]>();
  for (const entry of resultEntries) {
    if (!isObject(entry)) continue;
    const id = entry['id'];
    if (typeof id !== 'string' || id === '') continue;
    const groupId = entry['serialGroupId'];
    if (typeof groupId === 'string' && groupId !== '') {
      groupOfResult.set(id, groupId);
      continue;
    }
    byResult.set(id, collect(entry['attempts'], id));
  }
  for (const entry of groupEntries) {
    if (!isObject(entry)) continue;
    const id = entry['id'];
    if (typeof id === 'string' && id !== '') byGroup.set(id, collect(entry['attempts'], id));
  }
  return { byResult, groupOfResult, byGroup };
}

/** Copies the files a job's results own, then writes its index even when none survived. */
export async function preserveJobArtifacts(options: {
  readonly jobId: string;
  readonly resultIds: readonly string[];
  readonly report: ReportArtifacts | undefined;
  readonly output: string;
  readonly dir: string;
  readonly indexFile: string;
}): Promise<void> {
  const candidates = candidatesOf(options.resultIds, options.report);
  const resultsRoot = path.join(options.output, 'results');
  const realRoot = candidates.some((candidate) => candidate.path !== undefined)
    ? await realpath(resultsRoot).catch(() => undefined)
    : undefined;
  const artifacts: ReportArtifact[] = [];
  let total = 0;
  for (const [position, candidate] of candidates.entries()) {
    const stored = await storeCandidate(candidate, position, {
      resultsRoot,
      realRoot,
      dir: options.dir,
      total,
    });
    if (stored.size !== undefined) total += stored.size;
    artifacts.push(stored.artifact);
  }
  const index: JobArtifactIndex = {
    version: 1,
    jobId: options.jobId,
    createdAt: new Date().toISOString(),
    ...(options.report === undefined ? { error: 'report_unavailable' as const } : {}),
    artifacts,
  };
  await mkdir(path.dirname(options.indexFile), { recursive: true, mode: 0o700 });
  await writeFileAtomic(options.indexFile, JSON.stringify(index), { mode: 0o600 });
}

/** Reads one job's index; undefined when it is missing or no longer valid. */
export async function readJobArtifactIndex(file: string): Promise<JobArtifactIndex | undefined> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) return undefined;
    return parseIndex(JSON.parse(await readFile(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/** Turns one index into the tool's listing, truncating descriptors only. */
export function listedArtifacts(index: JobArtifactIndex, baseUrl: string): JobArtifactListing {
  const artifacts = index.artifacts.slice(0, MAX_LISTED_ARTIFACTS);
  return {
    jobId: index.jobId,
    ready: true,
    artifacts: artifacts.map((artifact, position) => {
      const { file, ...listed } = artifact;
      return {
        ...listed,
        ...(file === undefined || baseUrl === ''
          ? {}
          : { downloadUrl: `${baseUrl}/artifacts/${encodeURIComponent(index.jobId)}/${String(position)}` }),
      };
    }),
    truncated: artifacts.length < index.artifacts.length,
    ...(index.error === undefined ? {} : { error: index.error }),
  };
}

/** The candidate artifacts one job owns, in report order. */
function candidatesOf(resultIds: readonly string[], report: ReportArtifacts | undefined): ReportArtifact[] {
  if (report === undefined) return [];
  const candidates: ReportArtifact[] = [];
  const groups = new Set<string>();
  for (const resultId of resultIds) {
    candidates.push(...(report.byResult.get(resultId) ?? []));
    const groupId = report.groupOfResult.get(resultId);
    if (groupId === undefined || groups.has(groupId)) continue;
    groups.add(groupId);
    candidates.push(...(report.byGroup.get(groupId) ?? []));
  }
  return candidates;
}

async function storeCandidate(
  candidate: ReportArtifact,
  position: number,
  options: { resultsRoot: string; realRoot: string | undefined; dir: string; total: number },
): Promise<{ artifact: JobArtifact; size?: number }> {
  const descriptor = {
    artifactId: candidate.artifactId,
    kind: candidate.kind,
    mediaType: candidate.mediaType,
    redaction: candidate.redaction,
    resultId: candidate.resultId,
    attempt: candidate.attempt,
    fileName: candidate.fileName,
    ...(candidate.size === undefined ? {} : { size: candidate.size }),
    ...(candidate.sha256 === undefined ? {} : { sha256: candidate.sha256 }),
  };
  if (candidate.path === undefined) {
    return {
      artifact: {
        ...descriptor,
        ...(candidate.url === undefined ? { unavailable: 'no_local_file' } : { url: candidate.url }),
      },
    };
  }
  if (!safeRelativePath(candidate.path)) {
    return { artifact: { ...descriptor, unavailable: 'outside_run' } };
  }
  if (options.realRoot === undefined) {
    return { artifact: { ...descriptor, unavailable: 'missing_file' } };
  }
  const absolute = path.join(options.resultsRoot, ...candidate.path.split('/'));
  const real = await realpath(absolute).catch(() => undefined);
  if (real === undefined) return { artifact: { ...descriptor, unavailable: 'missing_file' } };
  if (!inside(options.realRoot, real)) return { artifact: { ...descriptor, unavailable: 'outside_run' } };
  const info = await lstat(absolute).catch(() => undefined);
  if (info === undefined || info.isSymbolicLink() || !info.isFile()) {
    return { artifact: { ...descriptor, unavailable: 'outside_run' } };
  }
  const measured = await stat(real).catch(() => undefined);
  if (measured === undefined || !measured.isFile()) {
    return { artifact: { ...descriptor, unavailable: 'missing_file' } };
  }
  const size = measured.size;
  if (size > MAX_ARTIFACT_BYTES) return { artifact: { ...descriptor, size, unavailable: 'file_too_large' } };
  if (options.total + size > MAX_JOB_ARTIFACT_BYTES) {
    return { artifact: { ...descriptor, size, unavailable: 'job_limit_reached' } };
  }
  const file = `${String(position)}${safeExtension(candidate.fileName)}`;
  try {
    await mkdir(options.dir, { recursive: true, mode: 0o700 });
    await copyFile(real, path.join(options.dir, file));
  } catch {
    return { artifact: { ...descriptor, size, unavailable: 'copy_failed' } };
  }
  return { artifact: { ...descriptor, size, file }, size };
}

/** One attempt's artifacts, stamped with the result or group that owns them. */
function collect(attempts: unknown, ownerId: string): ReportArtifact[] {
  if (!Array.isArray(attempts)) return [];
  const artifacts: ReportArtifact[] = [];
  for (const [position, attempt] of attempts.entries()) {
    if (!isObject(attempt)) continue;
    const index = attempt['index'];
    const number = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index + 1 : position + 1;
    const entries = attempt['artifacts'];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const artifact = candidateOf(entry, ownerId, number);
      if (artifact !== undefined) artifacts.push(artifact);
    }
  }
  return artifacts;
}

/** One report artifact, validated; undefined when it cannot be described. */
function candidateOf(raw: unknown, resultId: string, attempt: number): ReportArtifact | undefined {
  if (!isObject(raw)) return undefined;
  const artifactId = raw['id'];
  const kind = raw['kind'];
  const mediaType = raw['mediaType'];
  if (typeof artifactId !== 'string' || artifactId === '') return undefined;
  if (!isKind(kind) || typeof mediaType !== 'string' || mediaType === '') return undefined;
  const redaction = raw['redaction'];
  const storedPath = raw['path'];
  const url = raw['url'];
  const fileName =
    typeof storedPath === 'string' ? headerFileName(path.posix.basename(storedPath)) : urlFileName(url);
  return {
    artifactId,
    kind,
    mediaType,
    redaction: redaction === 'complete' ? 'complete' : 'incomplete',
    resultId,
    attempt,
    fileName,
    ...(typeof storedPath === 'string' ? { path: storedPath } : {}),
    ...(validUrl(url) ? { url } : {}),
    ...(nonNegativeInteger(raw['size']) ? { size: raw['size'] } : {}),
    ...(typeof raw['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(raw['sha256']) ? { sha256: raw['sha256'] } : {}),
  };
}

function parseIndex(raw: unknown): JobArtifactIndex | undefined {
  if (!isObject(raw) || raw['version'] !== 1) return undefined;
  const jobId = raw['jobId'];
  const createdAt = raw['createdAt'];
  const error = raw['error'];
  if (typeof jobId !== 'string' || jobId === '' || typeof createdAt !== 'string') return undefined;
  if (error !== undefined && error !== 'report_unavailable') return undefined;
  const entries = raw['artifacts'];
  if (!Array.isArray(entries)) return undefined;
  const artifacts = entries.flatMap((entry) => {
    const artifact = storedArtifactOf(entry);
    return artifact === undefined ? [] : [artifact];
  });
  return {
    version: 1,
    jobId,
    createdAt,
    ...(error === undefined ? {} : { error }),
    artifacts,
  };
}

function storedArtifactOf(raw: unknown): JobArtifact | undefined {
  if (!isObject(raw)) return undefined;
  const artifactId = raw['artifactId'];
  const kind = raw['kind'];
  const mediaType = raw['mediaType'];
  const redaction = raw['redaction'];
  const resultId = raw['resultId'];
  const attempt = raw['attempt'];
  const fileName = raw['fileName'];
  if (typeof artifactId !== 'string' || artifactId === '') return undefined;
  if (!isKind(kind) || typeof mediaType !== 'string' || mediaType === '') return undefined;
  if (redaction !== 'complete' && redaction !== 'incomplete') return undefined;
  if (typeof resultId !== 'string' || resultId === '') return undefined;
  if (!nonNegativeInteger(attempt) || attempt < 1) return undefined;
  if (typeof fileName !== 'string' || fileName === '') return undefined;
  const file = raw['file'];
  const url = raw['url'];
  const unavailable = raw['unavailable'];
  if (file !== undefined && (typeof file !== 'string' || !safeStoredFile(file))) return undefined;
  if (!validUrl(url) && url !== undefined) return undefined;
  if (unavailable !== undefined && !isUnavailable(unavailable)) return undefined;
  return {
    artifactId,
    kind,
    mediaType,
    redaction,
    resultId,
    attempt,
    fileName,
    ...(nonNegativeInteger(raw['size']) ? { size: raw['size'] } : {}),
    ...(typeof raw['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(raw['sha256']) ? { sha256: raw['sha256'] } : {}),
    ...(typeof file === 'string' ? { file } : {}),
    ...(validUrl(url) ? { url } : {}),
    ...(unavailable === undefined ? {} : { unavailable }),
  };
}

function isKind(value: unknown): value is JobArtifactKind {
  return value === 'screenshot' || value === 'video' || value === 'download' || value === 'log' || value === 'other';
}

function isUnavailable(value: unknown): value is JobArtifactUnavailable {
  return (
    value === 'file_too_large' ||
    value === 'job_limit_reached' ||
    value === 'missing_file' ||
    value === 'outside_run' ||
    value === 'copy_failed' ||
    value === 'no_local_file'
  );
}

/** A report path the job store may join under `results`: relative, no traversal, no drive. */
function safeRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.startsWith('\\') || value.includes('\\')) return false;
  if (value.includes('\0') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** A stored file name is ours; only the shapes `storeCandidate` writes are accepted. */
function safeStoredFile(value: string): boolean {
  return /^[0-9]+(?:\.[a-z0-9]{1,10})?$/.test(value);
}

function safeExtension(fileName: string): string {
  const extension = path.posix.extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

export function headerFileName(value: string): string {
  return value.replaceAll(/[^\x20-\x7e]|["\\]/g, '_');
}

function urlFileName(value: unknown): string {
  if (!validUrl(value)) return 'artifact';
  try {
    const name = path.posix.basename(new URL(value).pathname);
    return name === '' || name === '/' ? 'artifact' : headerFileName(decodeURIComponent(name));
  } catch {
    return 'artifact';
  }
}

function validUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value) && URL.canParse(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
