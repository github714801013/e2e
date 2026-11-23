/**
 * The account pool's rules without a gateway: validation, description
 * matching, the secret split between `secrets.env` and the generated runtime
 * targets, and the errors an admin or a run sees.
 */

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore, type AccountInput } from '../../src/mcp/http/accounts.ts';

const PASSWORD = 'unit-password-one';

function account(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    name: 'oa-pc-main',
    description: 'OA 电脑端 主账号',
    url: 'https://oa.example.test',
    username: 'oa-user',
    password: PASSWORD,
    ...overrides,
  };
}

describe('HTTP MCP account store', () => {
  let directory: string;
  let baseFile: string;
  let store: AccountStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'e2e-unit-accounts-'));
    baseFile = path.join(directory, 'base-targets.json');
    await writeFile(baseFile, JSON.stringify([{ name: 'base', url: 'http://127.0.0.1:1', username: 'base', password: 'base-password' }]));
    store = new AccountStore({ directory: path.join(directory, 'accounts'), baseTargetsFile: baseFile });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('keeps the password out of accounts.json and puts a placeholder in the runtime targets', async () => {
    const created = await store.create(account());
    expect(created).not.toHaveProperty('password');
    const records = await readFile(path.join(directory, 'accounts', 'accounts.json'), 'utf8');
    expect(records).not.toContain(PASSWORD);
    const secrets = await readFile(path.join(directory, 'accounts', 'secrets.env'), 'utf8');
    const passwordRef = ['E2E_ACCOUNT', 'OA_PC_MAIN', 'PASSWORD'].join('_');
    expect(secrets).toContain(`${passwordRef}=${JSON.stringify(PASSWORD)}`);

    const env = await store.childEnvironment();
    expect(env[passwordRef]).toBe(PASSWORD);
    const runtimeFile = env['E2E_TARGETS_FILE']!;
    const runtime = await readFile(runtimeFile, 'utf8');
    expect(runtime).not.toContain(PASSWORD);
    expect(JSON.parse(runtime)).toMatchObject([
      { name: 'base' },
      { name: 'oa-pc-main', username: 'oa-user', password: `{{${passwordRef}}}` },
    ]);
  });

  it('matches every word against one enabled description, split on punctuation and case', async () => {
    await store.create(account());
    await store.create(account({ name: 'oa-pc-backup', description: 'OA 电脑端 备用账号' }));
    await expect(store.resolve('OA, 主账号')).resolves.toMatchObject({ name: 'oa-pc-main' });
    await expect(store.resolve('oa-pc-main')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });
    await expect(store.resolve('电脑端')).rejects.toMatchObject({ code: 'ACCOUNT_AMBIGUOUS' });
    await expect(store.resolve('没有这个账号')).rejects.toMatchObject({ code: 'ACCOUNT_NOT_FOUND' });

    await store.create(account({ name: 'oa-pc-readonly', description: 'OA 电脑端 无权限 PC' }));
    await expect(store.resolve('无权限PC')).resolves.toMatchObject({ name: 'oa-pc-readonly' });

    await store.update('oa-pc-main', { enabled: false });
    await expect(store.resolve('主账号')).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });
    await expect(store.resolve(' ')).rejects.toMatchObject({ code: 'ACCOUNT_INVALID' });
  });

  it('refuses a bad field, a duplicate name, and a name a base target holds', async () => {
    await expect(store.create(account({ name: 'OA Main' }))).rejects.toMatchObject({ code: 'ACCOUNT_INVALID' });
    await expect(store.create(account({ url: 'ftp://oa.example.test' }))).rejects.toMatchObject({ code: 'ACCOUNT_INVALID' });
    await expect(store.create(account({ password: '' }))).rejects.toMatchObject({ code: 'ACCOUNT_INVALID' });
    await expect(store.create(account({ password: 'short' }))).rejects.toMatchObject({ code: 'ACCOUNT_INVALID' });
    await store.create(account());
    await expect(store.create(account())).rejects.toMatchObject({ code: 'ACCOUNT_DUPLICATE' });
    await expect(store.create(account({ name: 'base' }))).rejects.toMatchObject({ code: 'ACCOUNT_DUPLICATE' });
  });

  it('updates a description, the enabled flag, and a password, and drops the secret on removal', async () => {
    await store.create(account());
    const updated = await store.update('oa-pc-main', { description: 'OA 电脑端 新描述', enabled: false, password: 'unit-password-two' });
    expect(updated).toMatchObject({ description: 'OA 电脑端 新描述', enabled: false });
    const secrets = await readFile(path.join(directory, 'accounts', 'secrets.env'), 'utf8');
    expect(secrets).toContain(JSON.stringify('unit-password-two'));
    expect(secrets).not.toContain(PASSWORD);

    await store.remove('oa-pc-main');
    await expect(store.list()).resolves.toEqual([]);
    const passwordRef = ['E2E_ACCOUNT', 'OA_PC_MAIN', 'PASSWORD'].join('_');
    expect(await readFile(path.join(directory, 'accounts', 'secrets.env'), 'utf8')).not.toContain(passwordRef);
  });

  it('removes a temporary file a killed gateway left beside the store, and only those', async () => {
    const dir = path.join(directory, 'accounts');
    await mkdir(dir, { recursive: true });
    const stale = path.join(dir, 'accounts.json.deadbeefdeadbeef.tmp');
    await writeFile(stale, 'torn');
    const unrelated = path.join(dir, 'notes.tmp');
    await writeFile(unrelated, 'keep');

    await store.list();

    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(unrelated)).resolves.toBeDefined();
  });

  it('fails a corrupt store and a run that has no base targets file', async () => {
    await store.create(account());
    const file = path.join(directory, 'accounts', 'accounts.json');
    await writeFile(file, 'not json');
    await expect(store.list()).rejects.toMatchObject({ code: 'ACCOUNT_STORE_INVALID' });

    await writeFile(file, JSON.stringify({ version: 1, accounts: [] }));
    await rm(baseFile);
    await store.create(account());
    await expect(store.childEnvironment()).rejects.toMatchObject({ code: 'ACCOUNT_STORE_INVALID' });
    await expect(stat(path.join(directory, 'accounts', 'runtime-targets.json'))).rejects.toThrow();
  });
});
