/**
 * The target's shared login: one encrypted state under the project root,
 * restored and checked before every test, logged in for under an exclusive
 * lock when the saved state no longer checks out.
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineEngine, LOCATOR_ACTION_KINDS, type EngineHandle } from '../../src/engine/index.ts';
import type { E2EConfig, SessionFixtures } from '../../src/index.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createProject, runExisting, runProjectWithConfigFile, type FixtureProject } from '../helpers/run-project.ts';
import { snapshot } from '../helpers/snapshot.ts';

const APP_URL = 'http://127.0.0.1:4611';

/** What the fixture app's session holds; a run's engine restores it from the envelope. */
interface LoginState {
  signedIn: boolean;
  logins: number;
  checks: number;
}

/** An engine whose app session lives in `state`, so restoring it is observable. */
function loginEngine(state: LoginState, version = '1.0.0'): EngineHandle {
  return defineEngine({
    name: 'fake',
    version,
    spiVersion: 1,
    observe: async () => snapshot([{ ref: { id: 'status', revision: '' }, role: 'status', text: '' }]),
    locate: async () => [],
    actions: LOCATOR_ACTION_KINDS,
    perform: async () => undefined,
    state: {
      capture: async () => ({ format: 'fake-login', version: 1, data: { signedIn: state.signedIn } }),
      restore: async (saved) => {
        state.signedIn = (saved.data as { signedIn: boolean }).signedIn;
      },
    },
  });
}

const files = {
  'tests/uses-login.e2e.ts': `import { test } from 'e2e';
test('runs under the shared login', async () => {});`,
};

type Target = NonNullable<E2EConfig['targets']>[number];

interface SessionOverrides {
  /** Replaces the whole `login`. */
  login?: (fixtures: SessionFixtures) => Promise<void>;
  /** Replaces the whole `check`. */
  check?: (fixtures: SessionFixtures) => Promise<boolean>;
  account?: string;
  /** The engine version the target runs, which is part of the envelope's identity. */
  engineVersion?: string;
}

function target(state: LoginState, session: SessionOverrides = {}): Target {
  return {
    name: 'fake',
    platform: 'custom',
    engine: loginEngine(state, session.engineVersion),
    app: { url: APP_URL },
    session: {
      account: session.account ?? 'tester',
      login:
        session.login ??
        (async () => {
          state.logins += 1;
          state.signedIn = true;
        }),
      check:
        session.check ??
        (async () => {
          state.checks += 1;
          return state.signedIn;
        }),
    },
  };
}

function sharedConfig(state: LoginState, session: SessionOverrides = {}): Partial<E2EConfig> {
  return {
    targets: [target(state, session)],
    credentials: { tester: { username: 'tester@example.test', password: 'pw-shared-login' } },
    cache: 'off',
  };
}

/** The shared envelopes a project holds, which an empty run leaves behind. */
function envelopes(project: FixtureProject): string[] {
  const directory = path.join(project.dir, '.e2e', 'sessions', 'shared');
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith('.json'));
}

/** The one shared envelope file a project holds. */
function envelopeFile(project: FixtureProject): string {
  const [name] = envelopes(project);
  if (name === undefined) throw new Error('the project holds no shared session envelope');
  return path.join(project.dir, '.e2e', 'sessions', 'shared', name);
}

/** Runs one fixture project with a fresh login state, cleaning up afterwards. */
async function withProject(
  run: (project: FixtureProject) => Promise<void>,
  projectFiles: Readonly<Record<string, string>> = files,
): Promise<void> {
  const project = createProject(projectFiles);
  try {
    await run(project);
  } finally {
    project.cleanup();
  }
}

/** The run errors' codes, in order. */
function runErrorCodes(outcome: Awaited<ReturnType<typeof runExisting>>): string[] {
  return outcome.report.run.errors.map((error) => error.code);
}

describe('shared login session', () => {
  it('logs in once and reuses the saved session in the next run', async () => {
    await withProject(async (project) => {
      const first: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const one = await runExisting(project, { config: sharedConfig(first) });
      assertValidReport(one.report);
      expect(one.exitCode, JSON.stringify(one.report.run.errors)).toBe(0);
      expect(first).toEqual({ signedIn: true, logins: 1, checks: 1 });
      expect(envelopes(project)).toHaveLength(1);

      // The run's own output is disposable — MCP deletes its job output — and
      // the shared login lives outside it, so a second run still finds it.
      rmSync(path.join(project.dir, '.e2e', 'results'), { recursive: true, force: true });

      // A second run starts signed out: only the envelope can sign it back in.
      const second: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const two = await runExisting(project, { config: sharedConfig(second) });
      assertValidReport(two.report);
      expect(two.exitCode).toBe(0);
      expect(second).toEqual({ signedIn: true, logins: 0, checks: 1 });
    });
  }, 120_000);

  it('signs in again when the restored state no longer checks out', async () => {
    await withProject(async (project) => {
      const first: LoginState = { signedIn: false, logins: 0, checks: 0 };
      expect((await runExisting(project, { config: sharedConfig(first) })).exitCode).toBe(0);

      // The saved state restores, but the server no longer accepts it: the
      // check fails outside the lock and again inside it, so the runner signs
      // in, and the check after signing in passes.
      let checks = 0;
      const expired: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const outcome = await runExisting(project, {
        config: sharedConfig(expired, {
          check: async () => {
            checks += 1;
            return checks > 2;
          },
        }),
      });
      expect(outcome.exitCode, JSON.stringify(outcome.report.run.errors)).toBe(0);
      expect(expired.logins).toBe(1);
      expect(checks).toBe(3);
      expect(envelopes(project)).toHaveLength(1);
    });
  }, 120_000);

  it('starts cold over a corrupt envelope, without failing the run', async () => {
    await withProject(async (project) => {
      const first: LoginState = { signedIn: false, logins: 0, checks: 0 };
      expect((await runExisting(project, { config: sharedConfig(first) })).exitCode).toBe(0);
      writeFileSync(envelopeFile(project), 'not a shared session envelope', 'utf8');

      const second: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const outcome = await runExisting(project, { config: sharedConfig(second) });
      expect(outcome.exitCode).toBe(0);
      expect(second).toEqual({ signedIn: true, logins: 1, checks: 1 });
    });
  }, 120_000);

  it('starts cold when the envelope was saved by another engine build', async () => {
    await withProject(async (project) => {
      const first: LoginState = { signedIn: false, logins: 0, checks: 0 };
      expect((await runExisting(project, { config: sharedConfig(first) })).exitCode).toBe(0);

      // Same app and account, so the same store key, but a different engine
      // identity: the envelope is not this run's to restore.
      const second: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const outcome = await runExisting(project, { config: sharedConfig(second, { engineVersion: '2.0.0' }) });
      expect(outcome.exitCode).toBe(0);
      expect(second).toEqual({ signedIn: true, logins: 1, checks: 1 });
    });
  }, 120_000);

  it('leaves a test that opts out signed out', async () => {
    await withProject(
      async (project) => {
        const state: LoginState = { signedIn: false, logins: 0, checks: 0 };
        const outcome = await runExisting(project, { config: sharedConfig(state) });
        expect(outcome.exitCode).toBe(0);
        expect(state).toEqual({ signedIn: false, logins: 0, checks: 0 });
      },
      {
        'tests/opt-out.e2e.ts': `import { test } from 'e2e';
test('signs in on its own', { sharedSession: false }, async () => {});`,
      },
    );
  }, 120_000);

  it('does not inject the shared login into a test with an explicit session', async () => {
    await withProject(
      async (project) => {
        const state: LoginState = { signedIn: false, logins: 0, checks: 0 };
        const outcome = await runExisting(project, { config: sharedConfig(state) });
        expect(outcome.exitCode).toBe(0);
        expect(state).toEqual({ signedIn: false, logins: 0, checks: 0 });
      },
      {
        'tests/login.setup.e2e.ts': `import { test } from 'e2e';
test.setup('saves its own session', { sessions: ['acct'] }, async ({ session }) => {
  await session.save('acct');
});`,
        'tests/own-session.e2e.ts': `import { test } from 'e2e';
test('restores its own session', { session: 'acct' }, async () => {});`,
      },
    );
  }, 120_000);

  it('retries a login that threw once', async () => {
    await withProject(async (project) => {
      const state: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const outcome = await runExisting(project, {
        config: sharedConfig(state, {
          login: async () => {
            state.logins += 1;
            if (state.logins === 1) throw new Error('the login page flickered');
            state.signedIn = true;
          },
        }),
      });
      expect(outcome.exitCode).toBe(0);
      expect(state).toEqual({ signedIn: true, logins: 2, checks: 1 });
      expect(envelopes(project)).toHaveLength(1);
    });
  }, 120_000);

  it('stops the run once when the login keeps failing, saving no state', async () => {
    await withProject(async (project) => {
      const state: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const outcome = await runExisting(project, {
        config: sharedConfig(state, {
          login: async () => {
            state.logins += 1;
            throw new Error('the password was refused');
          },
        }),
      });
      expect(outcome.exitCode).toBe(2);
      expect(runErrorCodes(outcome)).toEqual(['SESSION_LOGIN_FAILED']);
      expect(state.logins).toBe(2);
      expect(envelopes(project)).toHaveLength(0);
    });
  }, 120_000);

  it('stops the run when the login does not survive its own check, saving no state', async () => {
    await withProject(async (project) => {
      const state: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const outcome = await runExisting(project, {
        config: sharedConfig(state, {
          check: async () => {
            state.checks += 1;
            return false;
          },
        }),
      });
      expect(outcome.exitCode).toBe(2);
      expect(runErrorCodes(outcome)).toEqual(['SESSION_LOGIN_FAILED']);
      expect(state).toEqual({ signedIn: true, logins: 1, checks: 1 });
      expect(envelopes(project)).toHaveLength(0);
    });
  }, 120_000);

  it('stops the run once when the check throws, skipping the rest', async () => {
    const project = createProject({
      'tests/a.e2e.ts': `import { test } from 'e2e';
test('first', async () => {});`,
      'tests/b.e2e.ts': `import { test } from 'e2e';
test('second', async () => {});`,
    });
    try {
      const first: LoginState = { signedIn: false, logins: 0, checks: 0 };
      expect((await runExisting(project, { config: sharedConfig(first) })).exitCode).toBe(0);

      const second: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const outcome = await runExisting(project, {
        config: sharedConfig(second, {
          check: async () => {
            second.checks += 1;
            throw new Error('the account page broke');
          },
        }),
      });
      expect(outcome.exitCode).toBe(2);
      expect(runErrorCodes(outcome)).toEqual(['SESSION_CHECK_FAILED']);
      expect(second.logins).toBe(0);
      expect(outcome.results.filter((result) => result.status === 'failed')).toHaveLength(0);
    } finally {
      project.cleanup();
    }
  }, 120_000);

  it('keeps a state per account, restoring each without logging in again', async () => {
    await withProject(async (project) => {
      const alpha: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const beta: LoginState = { signedIn: false, logins: 0, checks: 0 };
      const config = (): Partial<E2EConfig> => ({
        targets: [
          { ...target(alpha), name: 'alpha' },
          { ...target(beta, { account: 'reviewer' }), name: 'beta' },
        ],
        credentials: {
          tester: { username: 'tester@example.test', password: 'pw-alpha' },
          reviewer: { username: 'reviewer@example.test', password: 'pw-beta' },
        },
        cache: 'off',
      });
      const one = await runExisting(project, { config: config() });
      expect(one.exitCode).toBe(0);
      expect(alpha.logins + beta.logins).toBe(2);
      expect(envelopes(project)).toHaveLength(2);

      expect(envelopes(project)).toHaveLength(2);
      alpha.signedIn = false;
      beta.signedIn = false;
      alpha.logins = 0;
      beta.logins = 0;
      alpha.checks = 0;
      beta.checks = 0;
      const two = await runExisting(project, { config: config() });
      expect(envelopes(project)).toHaveLength(2);
      expect(two.exitCode, JSON.stringify(two.report.run.errors)).toBe(0);
      expect([alpha.logins, beta.logins]).toEqual([0, 0]);
      expect([alpha.checks, beta.checks]).toEqual([1, 1]);
    });
  }, 120_000);

  it('logs in once when four workers start cold together', async () => {
    const configSource = `import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { E2EConfig } from 'e2e';
import { createFakeEngine, FAKE_APP } from '../../helpers/fake-engine.ts';

const signedIn = path.join(process.cwd(), '.e2e', 'signed-in');
const logins = path.join(process.cwd(), '.e2e', 'logins.txt');

export default {
  targets: [
    {
      name: 'fake',
      platform: 'fake',
      engine: createFakeEngine({ state: true }).engine,
      app: FAKE_APP,
      session: {
        account: 'tester',
        login: async () => {
          mkdirSync(signedIn, { recursive: true });
          appendFileSync(logins, 'login\\n');
        },
        check: async () => existsSync(signedIn),
      },
    },
  ],
  credentials: { tester: { username: 'tester@example.test', password: 'pw-shared-login' } },
  workers: 4,
  cache: 'off',
} satisfies E2EConfig;
`;
    const { outcome, project } = await runProjectWithConfigFile(
      {
        'tests/a.e2e.ts': `import { test } from 'e2e';\ntest('a', async () => {});`,
        'tests/b.e2e.ts': `import { test } from 'e2e';\ntest('b', async () => {});`,
        'tests/c.e2e.ts': `import { test } from 'e2e';\ntest('c', async () => {});`,
        'tests/d.e2e.ts': `import { test } from 'e2e';\ntest('d', async () => {});`,
      },
      { configSource },
    );
    try {
      expect(outcome.exitCode, JSON.stringify(outcome.report.run.errors)).toBe(0);
      const loginCount = readFileSync(path.join(project.dir, '.e2e', 'logins.txt'), 'utf8')
        .split('\n')
        .filter(Boolean).length;
      expect(loginCount).toBe(1);
      expect(envelopes(project)).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  }, 180_000);

  it('provisions a serial group once', async () => {
    await withProject(
      async (project) => {
        const state: LoginState = { signedIn: false, logins: 0, checks: 0 };
        const outcome = await runExisting(project, { config: sharedConfig(state) });
        expect(outcome.exitCode).toBe(0);
        expect(state).toEqual({ signedIn: true, logins: 1, checks: 1 });
      },
      {
        'tests/serial.e2e.ts': `import { test } from 'e2e';
test.describe('group', { serial: true }, () => {
  test('one', async () => {});
  test('two', async () => {});
  test('three', async () => {});
});`,
      },
    );
  }, 120_000);
});
