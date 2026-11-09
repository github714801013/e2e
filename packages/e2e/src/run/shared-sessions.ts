/** Cross-run shared login state: one encrypted envelope per app identity and account, plus its login lock. */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedTarget } from '../config/resolve.ts';
import type { EngineState } from '../engine/surface.ts';
import { writeFileAtomic } from '../internal/atomic-write.ts';
import { E2EError } from '../internal/errors.ts';
import { canonicalJson, timestamp } from '../internal/ids.ts';
import { sleep } from '../internal/time.ts';
import { targetIdentity, type SessionIdentity } from './sessions.ts';

/** A lock held longer than this is considered abandoned; logged-in state is written under it. */
const LOCK_STALE_MS = 10 * 60 * 1000;
/** How long a worker waits for the login lock before failing the run. */
const LOCK_WAIT_MS = LOCK_STALE_MS + 30 * 1000;
const LOCK_POLL_MS = 100;

/** The identity a shared envelope must match before it is restored. The target's name is not part of it. */
export type SharedSessionIdentity = Omit<SessionIdentity, 'targetId'>;

interface SharedSessionEnvelope {
  schemaVersion: 'shared-session-1';
  key: string;
  account: string;
  engine: { name: string; version: string; spiVersion: number };
  platform: string;
  appIdentity: string;
  createdAt: string;
  state: {
    format: string;
    version: number;
    algorithm: 'A256GCM';
    iv: string;
    tag: string;
    ciphertext: string;
  };
}

/** The identity a shared envelope is written and restored under, from the target's engine, platform, and app. */
export function sharedSessionIdentity(target: ResolvedTarget): SharedSessionIdentity {
  const identity = targetIdentity(target);
  return {
    engineName: identity.engineName,
    engineVersion: identity.engineVersion,
    spiVersion: identity.spiVersion,
    platform: identity.platform,
    appIdentity: identity.appIdentity,
  };
}

/**
 * Stores shared login state under `<projectRoot>/.e2e/sessions/shared/`, so
 * it survives the run and the container, and serializes logins across worker
 * processes with a lock file beside it. The key lives beside the envelopes,
 * mode 0600; unlike the per-run store's memory-only key, it must outlive the
 * process to make the state readable across runs.
 */
export class SharedSessionStore {
  private readonly directory: string;
  private readonly keyPath: string;
  private key: Buffer | undefined;

  constructor(projectRoot: string) {
    this.directory = path.join(projectRoot, '.e2e', 'sessions', 'shared');
    this.keyPath = path.join(this.directory, 'shared.key');
  }

  private filePath(key: string): string {
    return path.join(this.directory, `${key}.json`);
  }

  private lockPath(key: string): string {
    return path.join(this.directory, `${key}.lock`);
  }

  /**
   * Loads the cached state for `key`, or `undefined` for a cold start: a
   * missing, corrupt, undecryptable, or identity-mismatched envelope is
   * ignored rather than failing the run.
   */
  async load(key: string, identity: SharedSessionIdentity): Promise<EngineState | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(key), 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
    const envelope = parseEnvelope(raw);
    if (envelope === undefined || !matchesIdentity(envelope, identity)) return undefined;
    const secretKey = await this.keyBytes();
    let plaintext: Buffer;
    try {
      const { tag, ciphertext, ...aadState } = envelope.state;
      const aad = Buffer.from(canonicalJson({ ...envelope, state: aadState }), 'utf8');
      const decipher = createDecipheriv('aes-256-gcm', secretKey, Buffer.from(envelope.state.iv, 'base64'));
      decipher.setAAD(aad);
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
    } catch {
      return undefined;
    }
    // The encrypted payload: the engine's state under `data`, never a secret value.
    let payload: unknown;
    try {
      payload = JSON.parse(plaintext.toString('utf8'));
    } catch {
      return undefined;
    }
    if (typeof payload !== 'object' || payload === null || !('data' in payload)) return undefined;
    return { format: envelope.state.format, version: envelope.state.version, data: payload.data };
  }

  /** Encrypts and atomically writes one captured engine state. */
  async save(key: string, identity: SharedSessionIdentity, account: string, state: EngineState): Promise<void> {
    const secretKey = await this.keyBytes();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const iv = randomBytes(12);
    const envelopeWithoutCipher = {
      schemaVersion: 'shared-session-1' as const,
      key,
      account,
      engine: { name: identity.engineName, version: identity.engineVersion, spiVersion: identity.spiVersion },
      platform: identity.platform,
      appIdentity: identity.appIdentity,
      createdAt: timestamp(),
      state: { format: state.format, version: state.version, algorithm: 'A256GCM' as const, iv: iv.toString('base64') },
    };
    const aad = Buffer.from(canonicalJson(envelopeWithoutCipher), 'utf8');
    const cipher = createCipheriv('aes-256-gcm', secretKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify({ data: state.data }), 'utf8')),
      cipher.final(),
    ]);
    const envelope: SharedSessionEnvelope = {
      ...envelopeWithoutCipher,
      state: {
        ...envelopeWithoutCipher.state,
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      },
    };
    await writeFileAtomic(this.filePath(key), `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  }

  /** Runs `body` while holding the login lock for `key`; a lock left by a crashed worker is taken over. */
  async withLoginLock<T>(
    key: string,
    signal: AbortSignal | undefined,
    body: () => Promise<T>,
    options: { readonly staleMs?: number; readonly waitMs?: number } = {},
  ): Promise<T> {
    const lockPath = this.lockPath(key);
    const token = randomBytes(16).toString('hex');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.acquire(lockPath, token, signal, options);
    try {
      return await body();
    } finally {
      await this.release(lockPath, token);
    }
  }

  private async acquire(lockPath: string, token: string, signal: AbortSignal | undefined, options: { readonly staleMs?: number; readonly waitMs?: number }): Promise<void> {
    const staleMs = options.staleMs ?? LOCK_STALE_MS;
    const deadline = Date.now() + (options.waitMs ?? LOCK_WAIT_MS);
    for (;;) {
      signal?.throwIfAborted();
      let handle: FileHandle | undefined;
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (cause) {
        if (!isAlreadyExists(cause)) throw cause;
      }
      if (handle !== undefined) {
        try {
          await handle.writeFile(JSON.stringify({ token, pid: process.pid, at: timestamp() }));
        } catch (cause) {
          await rm(lockPath, { force: true });
          throw cause;
        } finally {
          await handle.close();
        }
        return;
      }
      if (await isStale(lockPath, staleMs)) {
        if (await takeOverStale(lockPath, token)) continue;
      }
      if (Date.now() >= deadline) {
        throw new E2EError(
          'infrastructure',
          'SESSION_LOCK_TIMEOUT',
          `timed out waiting for the shared login lock at ${lockPath}`,
        );
      }
      await sleep(LOCK_POLL_MS, signal);
    }
  }

  private async release(lockPath: string, token: string): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'token' in parsed && parsed.token === token) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // A missing lock was already taken over; a lock we do not own stays.
    }
  }

  /**
   * The store's AES key, created beside the envelopes on first use. Creation
   * links a fully written temporary file into place, so two workers starting
   * together settle on one key instead of overwriting each other's.
   */
  private async keyBytes(): Promise<Buffer> {
    if (this.key !== undefined) return this.key;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const existing = await this.readKey();
    if (existing !== undefined) {
      this.key = existing;
      return existing;
    }
    const created = randomBytes(32);
    const temporary = path.join(this.directory, `shared.key.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    await writeFile(temporary, created.toString('base64'), { mode: 0o600 });
    try {
      await link(temporary, this.keyPath);
    } catch (cause) {
      if (!isAlreadyExists(cause)) throw cause;
    } finally {
      await rm(temporary, { force: true });
    }
    const settled = await this.readKey();
    if (settled === undefined) {
      throw new E2EError('infrastructure', 'SESSION_KEY_INVALID', 'shared session key could not be created');
    }
    this.key = settled;
    return settled;
  }

  private async readKey(): Promise<Buffer | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.keyPath, 'utf8');
    } catch (cause) {
      if (isNotFound(cause)) return undefined;
      throw cause;
    }
    const key = Buffer.from(raw.trim(), 'base64');
    if (key.length !== 32) {
      throw new E2EError('infrastructure', 'SESSION_KEY_INVALID', 'shared session key must be 32 bytes');
    }
    return key;
  }
}

function matchesIdentity(envelope: SharedSessionEnvelope, identity: SharedSessionIdentity): boolean {
  return (
    envelope.engine.name === identity.engineName &&
    envelope.engine.version === identity.engineVersion &&
    envelope.engine.spiVersion === identity.spiVersion &&
    envelope.platform === identity.platform &&
    envelope.appIdentity === identity.appIdentity
  );
}

function parseEnvelope(raw: string): SharedSessionEnvelope | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const envelope = parsed as Partial<SharedSessionEnvelope>;
  if (envelope.schemaVersion !== 'shared-session-1') return undefined;
  if (typeof envelope.key !== 'string' || typeof envelope.account !== 'string') return undefined;
  if (typeof envelope.engine !== 'object' || envelope.engine === null) return undefined;
  if (typeof envelope.engine.name !== 'string' || typeof envelope.engine.version !== 'string') return undefined;
  if (typeof envelope.state !== 'object' || envelope.state === null) return undefined;
  const { state } = envelope;
  if (
    typeof state.format !== 'string' ||
    typeof state.version !== 'number' ||
    typeof state.iv !== 'string' ||
    typeof state.tag !== 'string' ||
    typeof state.ciphertext !== 'string'
  ) {
    return undefined;
  }
  if (typeof envelope.platform !== 'string' || typeof envelope.appIdentity !== 'string') return undefined;
  return envelope as SharedSessionEnvelope;
}

/**
 * Moves an abandoned lock out of the way. Renaming is the claim: two waiters
 * that both saw the same stale lock cannot both succeed, and neither can
 * delete a lock a third worker created after the rename.
 */
async function takeOverStale(lockPath: string, token: string): Promise<boolean> {
  const abandoned = `${lockPath}.${token}.stale`;
  try {
    await rename(lockPath, abandoned);
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw cause;
  }
  await rm(abandoned, { force: true });
  return true;
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs >= staleMs;
  } catch (cause) {
    if (isNotFound(cause)) return false;
    throw cause;
  }
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'ENOENT';
}

function isAlreadyExists(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as { code?: unknown }).code === 'EEXIST';
}
