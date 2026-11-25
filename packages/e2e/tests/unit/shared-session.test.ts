/** Cross-run shared login state: the encrypted envelope and its login lock. */

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SharedSessionStore, type SharedSessionIdentity } from '../../src/run/shared-sessions.ts';
import { assertValidSharedSessionEnvelope } from '../helpers/shared-session-schema.ts';

const identity: SharedSessionIdentity = {
  engineName: 'playwright',
  engineVersion: '1.61.1',
  spiVersion: 1,
  platform: 'web',
  appIdentity: 'a'.repeat(64),
};

const KEY = 'b'.repeat(64);

/** Temp dirs the cases in this file create, removed after each so a run leaves nothing behind. */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'e2e-shared-session-'));
  tempDirs.push(root);
  return root;
}

describe('shared session store', () => {
  it('round-trips the engine state through an encrypted shared-session-1 envelope', async () => {
    const root = await tempRoot();
    const store = new SharedSessionStore(root);
    const data = { cookies: [{ name: 'sid', value: 'cookie-value-7391' }] };
    await store.save(KEY, identity, 'tester', { format: 'playwright-storage-state', version: 1, data });

    const file = path.join(root, '.e2e', 'sessions', 'shared', `${KEY}.json`);
    const raw = await readFile(file, 'utf8');
    expect(raw).not.toContain('cookie-value-7391');
    const envelope = JSON.parse(raw) as Record<string, unknown>;
    assertValidSharedSessionEnvelope(envelope);
    expect(envelope['secrecy']).toBeUndefined();
    expect(envelope['secrets']).toBeUndefined();

    const loaded = await store.load(KEY, identity);
    expect(loaded).toEqual({ format: 'playwright-storage-state', version: 1, data });
  });

  it('treats a missing, tampered, or foreign envelope as a cold start', async () => {
    const root = await tempRoot();
    const store = new SharedSessionStore(root);
    expect(await store.load(KEY, identity)).toBeUndefined();

    await store.save(KEY, identity, 'tester', { format: 'playwright-storage-state', version: 1, data: { cookies: [] } });
    const file = path.join(root, '.e2e', 'sessions', 'shared', `${KEY}.json`);
    const envelope = JSON.parse(await readFile(file, 'utf8')) as { state: { ciphertext: string } };
    envelope.state.ciphertext = `${envelope.state.ciphertext.slice(0, -4)}AAAA`;
    await writeFile(file, JSON.stringify(envelope));
    expect(await store.load(KEY, identity)).toBeUndefined();

    await store.save(KEY, identity, 'tester', { format: 'playwright-storage-state', version: 1, data: {} });
    expect(await store.load(KEY, { ...identity, platform: 'ios' })).toBeUndefined();
  });

  it('fails closed when the key file is not 32 bytes', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, '.e2e', 'sessions', 'shared'), { recursive: true });
    await writeFile(path.join(root, '.e2e', 'sessions', 'shared', 'shared.key'), 'short');
    const store = new SharedSessionStore(root);
    await expect(store.save(KEY, identity, 'tester', { format: 'x', version: 1, data: {} })).rejects.toMatchObject({
      code: 'SESSION_KEY_INVALID',
    });
  });

  it('serializes logins and takes over a lock whose holder is gone', async () => {
    const root = await tempRoot();
    const store = new SharedSessionStore(root);
    const order: string[] = [];
    let release!: () => void;
    const first = store.withLoginLock(KEY, undefined, async () => {
      order.push('first-start');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push('first-end');
    });
    await vi.waitFor(() => expect(order).toEqual(['first-start']));
    const second = store.withLoginLock(KEY, undefined, async () => {
      order.push('second');
    }, { waitMs: 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(order).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);

    const lock = path.join(root, '.e2e', 'sessions', 'shared', `${KEY}.lock`);
    await writeFile(lock, JSON.stringify({ token: 'abandoned' }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    let ran = false;
    await store.withLoginLock(KEY, undefined, async () => {
      ran = true;
    }, { staleMs: 1_000, waitMs: 1_000 });
    expect(ran).toBe(true);
  });

  it('fails with SESSION_LOCK_TIMEOUT while a fresh lock is held', async () => {
    const root = await tempRoot();
    const store = new SharedSessionStore(root);
    const lock = path.join(root, '.e2e', 'sessions', 'shared', `${KEY}.lock`);
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, JSON.stringify({ token: 'held' }));
    await expect(
      store.withLoginLock(KEY, undefined, async () => undefined, { staleMs: 60_000, waitMs: 150 }),
    ).rejects.toMatchObject({ code: 'SESSION_LOCK_TIMEOUT' });
  });
});
