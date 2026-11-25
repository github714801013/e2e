/**
 * The HTTP gateway's account pool. An account is a target plus a business
 * description, so an MCP caller picks an account by what it is for. Records
 * live in `accounts.json`; passwords live in `secrets.env` (mode 0600) and are
 * referenced by an `E2E_ACCOUNT_<NAME>_PASSWORD` placeholder. The pool belongs
 * to one gateway process: every write is atomic and serialized here.
 */

import { readFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '@e2e-dev/core/lib/internal/atomic-write';
import { ConfigurationError } from '@e2e-dev/core/lib/internal/errors';
import { timestamp } from '@e2e-dev/core/lib/internal/ids';

/** A stored account. The password itself is only in `secrets.env`. */
export interface AccountRecord {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly username: string;
  /** The `secrets.env` key holding this account's password. */
  readonly passwordRef: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** An account as the admin API and the MCP list return it; never a password. */
export interface AccountView {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly username: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A new account; the pool assigns its secret key and timestamps. */
export interface AccountInput {
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly username: string;
  readonly password: string;
}

/** The fields an update may change; a described field is validated, an absent one is kept. */
export interface AccountPatch {
  readonly description?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly password?: string | undefined;
}

/** Where one gateway keeps its pool and the targets it layers the accounts on. */
export interface AccountStoreOptions {
  /** Where `accounts.json`, `secrets.env`, and the generated runtime targets live. */
  readonly directory: string;
  /** The read-only targets file the pool is layered on; missing means an empty base. */
  readonly baseTargetsFile: string;
}

const ACCOUNTS_VERSION = 1;
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_NAME_CHARS = 64;
const KEYWORDS = /[\s\p{P}\p{S}]+/gu;
/** A temporary sibling `writeFileAtomic` left when the gateway was killed mid-write. */
const STALE_TEMPORARY = /^(?:accounts\.json|secrets\.env|runtime-targets\.json)\.[0-9a-f]{16}\.tmp$/u;

/** The environment key that holds one account's password. */
function passwordRefFor(name: string): string {
  return `E2E_ACCOUNT_${name.toUpperCase().replaceAll('-', '_')}_PASSWORD`;
}

/** The account pool; one instance is shared by the gateway's tools and admin API. */
export class AccountStore {
  private readonly directory: string;
  private readonly accountsFile: string;
  private readonly secretsFile: string;
  private readonly runtimeFile: string;
  private cache: { mtimeMs: number; size: number; accounts: readonly AccountRecord[] } | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private cleanup: Promise<void> | undefined;

  constructor(private readonly options: AccountStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.accountsFile = path.join(this.directory, 'accounts.json');
    this.secretsFile = path.join(this.directory, 'secrets.env');
    this.runtimeFile = path.join(this.directory, 'runtime-targets.json');
  }

  /**
   * Every account, enabled or not; a missing file is an empty pool. Reads take
   * the same turn as writes: on Windows a rename over a file another handle
   * has open fails, so a read must not run beside a store write.
   */
  async list(): Promise<readonly AccountRecord[]> {
    return this.exclusive(() => this.read());
  }

  private async read(): Promise<readonly AccountRecord[]> {
    // A gateway killed between a temporary write and its rename leaves the
    // temporary behind; the next process clears it before its first operation.
    await (this.cleanup ??= this.removeStaleTemporaries());
    const info = await stat(this.accountsFile).catch((cause: unknown) => {
      if (isMissing(cause)) return undefined;
      throw new ConfigurationError('ACCOUNT_STORE_INVALID', `cannot read ${this.accountsFile}: ${messageOf(cause)}`);
    });
    if (info === undefined) {
      this.cache = undefined;
      return [];
    }
    if (this.cache !== undefined && this.cache.mtimeMs === info.mtimeMs && this.cache.size === info.size) {
      return this.cache.accounts;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.accountsFile, 'utf8'));
    } catch (cause) {
      throw new ConfigurationError('ACCOUNT_STORE_INVALID', `${this.accountsFile} is not readable JSON: ${messageOf(cause)}`);
    }
    const accounts = parseAccounts(parsed, this.accountsFile);
    this.cache = { mtimeMs: info.mtimeMs, size: info.size, accounts };
    return accounts;
  }

  private async removeStaleTemporaries(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch (cause) {
      if (isMissing(cause)) return;
      throw new ConfigurationError('ACCOUNT_STORE_INVALID', `cannot read ${this.directory}: ${messageOf(cause)}`);
    }
    await Promise.all(
      entries
        .filter((name) => STALE_TEMPORARY.test(name))
        .map((name) => rm(path.join(this.directory, name), { force: true })),
    );
  }

  /** Adds one account; a duplicate name, including a base target's, is refused. */
  async create(input: AccountInput): Promise<AccountView> {
    return this.exclusive(async () => {
      const name = validName(input.name);
      const description = validDescription(input.description);
      const url = validUrl(input.url);
      const username = validUsername(input.username);
      const password = validPassword(input.password);
      const accounts = [...(await this.read())];
      if (accounts.some((account) => account.name === name)) {
        throw new ConfigurationError('ACCOUNT_DUPLICATE', `an account named "${name}" already exists`);
      }
      if ((await this.baseTargetNames()).has(name)) {
        throw new ConfigurationError('ACCOUNT_DUPLICATE', `"${name}" is a configured target; choose another account name`);
      }
      const now = timestamp();
      const record: AccountRecord = {
        name,
        description,
        url,
        username,
        passwordRef: passwordRefFor(name),
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      const secrets = await this.readSecrets();
      secrets.set(record.passwordRef, password);
      await this.writeSecrets(secrets);
      accounts.push(record);
      await this.writeAccounts(accounts);
      return view(record);
    });
  }

  /** Changes a description, the enabled flag, a password, or any combination. */
  async update(name: string, patch: AccountPatch): Promise<AccountView> {
    return this.exclusive(async () => {
      const accounts = [...(await this.read())];
      const index = accounts.findIndex((account) => account.name === name);
      if (index === -1) throw notFound(name);
      const current = accounts[index]!;
      const description = patch.description === undefined ? current.description : validDescription(patch.description);
      const enabled = patch.enabled === undefined ? current.enabled : validEnabled(patch.enabled);
      const password = patch.password === undefined ? undefined : validPassword(patch.password);
      if (password !== undefined) {
        const secrets = await this.readSecrets();
        secrets.set(current.passwordRef, password);
        await this.writeSecrets(secrets);
      }
      const updated: AccountRecord = { ...current, description, enabled, updatedAt: timestamp() };
      accounts[index] = updated;
      await this.writeAccounts(accounts);
      return view(updated);
    });
  }

  /** Removes an account and the secret key that held its password. */
  async remove(name: string): Promise<void> {
    return this.exclusive(async () => {
      const accounts = [...(await this.read())];
      const record = accounts.find((account) => account.name === name);
      if (record === undefined) throw notFound(name);
      // The account goes first: a crash before the secret is dropped leaves an
      // unused key, while the reverse would leave an account without a password.
      await this.writeAccounts(accounts.filter((account) => account.name !== name));
      const secrets = await this.readSecrets();
      if (secrets.delete(record.passwordRef)) await this.writeSecrets(secrets);
    });
  }

  /**
   * The one enabled account whose description contains every keyword of
   * `description`, case-insensitively. Whitespace and punctuation split the
   * query into words and are ignored inside the stored description, so
   * `无权限PC` matches `无权限 PC`; matching never looks at names or URLs.
   */
  async resolve(description: string): Promise<AccountRecord> {
    return this.exclusive(async () => {
      const keywords = description.toLowerCase().split(KEYWORDS).filter((word) => word !== '');
      if (keywords.length === 0) {
        throw new ConfigurationError('ACCOUNT_INVALID', 'accountDescription must contain at least one word');
      }
      const matches = (await this.read()).filter((account) =>
        keywords.every((keyword) => account.description.toLowerCase().replace(KEYWORDS, '').includes(keyword)),
      );
      const enabled = matches.filter((account) => account.enabled);
      if (enabled.length === 1) return enabled[0]!;
      if (enabled.length > 1) {
        throw new ConfigurationError(
          'ACCOUNT_AMBIGUOUS',
          `accountDescription matches ${enabled.length} enabled accounts: ${enabled.map(label).join('; ')}; add a word that narrows it`,
        );
      }
      if (matches.length > 0) {
        throw new ConfigurationError(
          'ACCOUNT_DISABLED',
          `accountDescription matches a disabled account: ${matches.map(label).join('; ')}; enable it or choose another`,
        );
      }
      throw new ConfigurationError('ACCOUNT_NOT_FOUND', `no account description contains "${description}"`);
    });
  }

  /**
   * The environment every child of a run gets: the generated targets file and
   * one password variable per enabled account. Account passwords stay out of
   * the file; they travel only in the child environment.
   */
  async childEnvironment(): Promise<Record<string, string>> {
    return this.exclusive(async () => {
      const accounts = (await this.read()).filter((account) => account.enabled);
      // A gateway with no pool and no base file injects nothing, so a plain
      // `--http` server keeps working where neither exists.
      if (accounts.length === 0 && (await missing(this.options.baseTargetsFile))) return {};
      const base = await this.readBaseTargets(accounts.length > 0);
      const baseNames = new Set(base.flatMap((entry) => (typeof entry['name'] === 'string' ? [entry['name']] : [])));
      for (const account of accounts) {
        if (baseNames.has(account.name)) {
          throw new ConfigurationError(
            'ACCOUNT_STORE_INVALID',
            `account "${account.name}" collides with a configured target; rename one of them`,
          );
        }
      }
      const targets = [
        ...base,
        ...accounts.map((account) => ({
          name: account.name,
          url: account.url,
          username: account.username,
          password: `{{${account.passwordRef}}}`,
        })),
      ];
      const secrets = await this.readSecrets();
      const env: Record<string, string> = {};
      for (const account of accounts) {
        const password = secrets.get(account.passwordRef);
        if (password === undefined) {
          throw new ConfigurationError(
            'ACCOUNT_STORE_INVALID',
            `account "${account.name}" has no value for ${account.passwordRef} in ${this.secretsFile}`,
          );
        }
        env[account.passwordRef] = password;
      }
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFileAtomic(this.runtimeFile, `${JSON.stringify(targets, null, 2)}\n`, { mode: 0o600 });
      return { E2E_TARGETS_FILE: this.runtimeFile, ...env };
    });
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    // A failed write must not stop the writes queued behind it.
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async writeAccounts(accounts: readonly AccountRecord[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.accountsFile, `${JSON.stringify({ version: ACCOUNTS_VERSION, accounts }, null, 2)}\n`, {
      mode: 0o600,
    });
    // The next list must see what this write stored, not a stale stat.
    this.cache = undefined;
  }

  private async readSecrets(): Promise<Map<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.secretsFile, 'utf8');
    } catch (cause) {
      if (isMissing(cause)) return new Map();
      throw new ConfigurationError('ACCOUNT_STORE_INVALID', `cannot read ${this.secretsFile}: ${messageOf(cause)}`);
    }
    const secrets = new Map<string, string>();
    for (const [index, line] of raw.split('\n').entries()) {
      if (line.trim() === '' || line.startsWith('#')) continue;
      const equals = line.indexOf('=');
      const key = equals === -1 ? '' : line.slice(0, equals);
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
        throw new ConfigurationError('ACCOUNT_STORE_INVALID', `${this.secretsFile} line ${String(index + 1)} is not KEY=value`);
      }
      let value: unknown;
      try {
        value = JSON.parse(line.slice(equals + 1));
      } catch {
        // The line holds a password; the failure names the line, never its text.
        throw new ConfigurationError('ACCOUNT_STORE_INVALID', `${this.secretsFile} line ${String(index + 1)} is not a JSON string`);
      }
      if (typeof value !== 'string') {
        throw new ConfigurationError('ACCOUNT_STORE_INVALID', `${this.secretsFile} line ${String(index + 1)} is not a JSON string`);
      }
      secrets.set(key, value);
    }
    return secrets;
  }

  private async writeSecrets(secrets: Map<string, string>): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lines = [...secrets.entries()]
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
    await writeFileAtomic(this.secretsFile, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { mode: 0o600 });
  }

  private async baseTargetNames(): Promise<ReadonlySet<string>> {
    const base = await this.readBaseTargets();
    return new Set(base.flatMap((entry) => (typeof entry['name'] === 'string' ? [entry['name']] : [])));
  }

  /**
   * The read-only base targets. Admin writes tolerate a missing file (the
   * pool then has no base names to collide with); generating a run's targets
   * requires it, so a deployment that lost its mount fails loudly instead of
   * running the accounts alone.
   */
  private async readBaseTargets(required = false): Promise<readonly Record<string, unknown>[]> {
    let raw: string;
    try {
      raw = await readFile(this.options.baseTargetsFile, 'utf8');
    } catch (cause) {
      if (isMissing(cause)) {
        if (!required) return [];
        throw new ConfigurationError(
          'ACCOUNT_STORE_INVALID',
          `the base targets file ${this.options.baseTargetsFile} does not exist; mount it before running with accounts`,
        );
      }
      throw new ConfigurationError(
        'ACCOUNT_STORE_INVALID',
        `cannot read the base targets file ${this.options.baseTargetsFile}: ${messageOf(cause)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConfigurationError(
        'ACCOUNT_STORE_INVALID',
        `the base targets file ${this.options.baseTargetsFile} is not valid JSON`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ConfigurationError(
        'ACCOUNT_STORE_INVALID',
        `the base targets file ${this.options.baseTargetsFile} must be a JSON array`,
      );
    }
    return parsed.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
  }
}

function parseAccounts(parsed: unknown, file: string): readonly AccountRecord[] {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw storeInvalid(file, 'the document must be an object');
  }
  const document = parsed as Record<string, unknown>;
  if (document['version'] !== ACCOUNTS_VERSION) {
    throw storeInvalid(file, `version must be ${String(ACCOUNTS_VERSION)}`);
  }
  const entries = document['accounts'];
  if (!Array.isArray(entries)) throw storeInvalid(file, 'accounts must be an array');
  const seen = new Set<string>();
  return entries.map((entry, index): AccountRecord => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw storeInvalid(file, `accounts[${String(index)}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const name = record['name'];
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw storeInvalid(file, `accounts[${String(index)}].name is invalid`);
    }
    if (seen.has(name)) throw storeInvalid(file, `accounts[${String(index)}].name "${name}" is used twice`);
    seen.add(name);
    const description = record['description'];
    if (typeof description !== 'string' || description.length === 0 || description.length > MAX_DESCRIPTION_CHARS) {
      throw storeInvalid(file, `account "${name}" has an invalid description`);
    }
    if (typeof record['url'] !== 'string' || !isHttpUrl(record['url'])) {
      throw storeInvalid(file, `account "${name}" has an invalid url`);
    }
    if (typeof record['username'] !== 'string' || record['username'].trim() === '') {
      throw storeInvalid(file, `account "${name}" has an invalid username`);
    }
    if (record['passwordRef'] !== passwordRefFor(name)) {
      throw storeInvalid(file, `account "${name}" has an unexpected passwordRef`);
    }
    if (typeof record['enabled'] !== 'boolean') throw storeInvalid(file, `account "${name}" has no enabled flag`);
    for (const field of ['createdAt', 'updatedAt'] as const) {
      if (typeof record[field] !== 'string' || record[field] === '') {
        throw storeInvalid(file, `account "${name}" has no ${field}`);
      }
    }
    return {
      name,
      description,
      url: record['url'],
      username: record['username'],
      passwordRef: record['passwordRef'],
      enabled: record['enabled'],
      createdAt: record['createdAt'] as string,
      updatedAt: record['updatedAt'] as string,
    };
  });
}

function view(record: AccountRecord): AccountView {
  return {
    name: record.name,
    description: record.description,
    url: record.url,
    username: record.username,
    enabled: record.enabled,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function validName(value: unknown): string {
  if (typeof value !== 'string' || !NAME_PATTERN.test(value)) {
    throw invalid(
      `account name must be 1 to ${String(MAX_NAME_CHARS)} characters of lowercase letters, digits, and hyphens, and cannot start or end with a hyphen`,
    );
  }
  return value;
}

function validDescription(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > MAX_DESCRIPTION_CHARS) {
    throw invalid(`account description must be 1 to ${String(MAX_DESCRIPTION_CHARS)} characters`);
  }
  return text;
}

function validUrl(value: unknown): string {
  if (typeof value !== 'string' || !isHttpUrl(value.trim())) {
    throw invalid('account url must be an http or https URL');
  }
  return value.trim();
}

function validUsername(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') throw invalid('account username must be a non-empty string');
  return text;
}

function validPassword(value: unknown): string {
  // The same floor a configured credential has, so a pool password can never
  // pass the admin and then fail when the run resolves its credentials.
  if (typeof value !== 'string' || [...value].length < 6) {
    throw invalid('account password must be at least 6 characters (code points)');
  }
  return value;
}

function validEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw invalid('account enabled must be true or false');
  return value;
}

function invalid(message: string): ConfigurationError {
  return new ConfigurationError('ACCOUNT_INVALID', message);
}

function notFound(name: string): ConfigurationError {
  return new ConfigurationError('ACCOUNT_NOT_FOUND', `no account named "${name}"`);
}

function storeInvalid(file: string, reason: string): ConfigurationError {
  return new ConfigurationError('ACCOUNT_STORE_INVALID', `${file}: ${reason}`);
}

function label(account: AccountRecord): string {
  return `${account.name} ("${account.description}")`;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** True only for ENOENT; a permission failure is a store error, not absence. */
async function missing(file: string): Promise<boolean> {
  try {
    await stat(file);
    return false;
  } catch (cause) {
    if (isMissing(cause)) return true;
    throw new ConfigurationError('ACCOUNT_STORE_INVALID', `cannot read ${file}: ${messageOf(cause)}`);
  }
}

function isMissing(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && (cause as NodeJS.ErrnoException).code === 'ENOENT';
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
