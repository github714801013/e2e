/**
 * Target resolution: each target's name, platform, engine, and app, resolved
 * once without the run's ports; `bindTargets` puts a run's assigned ports in
 * afterwards, and nothing else.
 */

import { isEngineHandle, type EngineHandle } from '../engine/index.ts';
import { ConfigurationError } from '../internal/errors.ts';
import { canonicalDigest } from '../internal/ids.ts';
import type { ResolvedRecording } from '../internal/recording-modes.ts';
import { credentialHandle } from '../secrets.ts';
import type { Credential, Target, TargetSessionConfig } from '../types.ts';
import { checkTargetApp, digestTargetApp, resolveTargetApp, TARGET_KEYS, unknownTargetKey, type ResolvedApp, type TargetAppDeclaration } from './app.ts';
import { isRecord } from './command.ts';
import type { ResolvedCredential } from './resolve.ts';
import { describeValue } from './validate.ts';

/** The free port the run assigned to each target whose URL asked for one, by target name. */
export type PortAssignments = Readonly<Record<string, number>>;

/** The declared shared login with its resolved account and stable store key. */
export interface ResolvedTargetSession extends TargetSessionConfig {
  /** The account's handle; the password stays opaque. */
  readonly credential: Credential;
  /** Stable store key: the app's identity and the account, never a run's port. */
  readonly key: string;
}

export interface ResolvedTarget {
  readonly name: string;
  readonly index: number;
  readonly platform: string;
  /** Validated engine; undefined for an agent-tools-only target. */
  readonly engine: EngineHandle | undefined;
  /** The app under test, on the run's port once it was assigned. */
  readonly app: ResolvedApp;
  /** The app as declared and checked: what `bindTargets` resolves again on the run's port, and what the digest reads. */
  readonly declaredApp: TargetAppDeclaration;
  /** The shared login every test on the target restores, when it declares one. */
  readonly session?: ResolvedTargetSession;
  /** Which attempts on the target record a trace: `--trace`, else the target's `trace`, else the config's, else `on` (`on-first-retry` in CI). A test's own `trace` wins over it. */
  readonly trace: ResolvedRecording;
  /** Which attempts on the target record a video: `--video`, else the target's `video`, else the config's, else `off`. A test's own `video` wins over it. */
  readonly video: ResolvedRecording;
}

/** A safe artifact path segment: the filename alphabet, and never `.` or `..`, which would name a directory's self or parent. */
export const TARGET_NAME_PATTERN = /^(?!\.+$)[A-Za-z0-9_.-]+$/;

/** Resolves `targets`: each target's name, platform, engine, recordings, and app, without the run's ports. */
export function resolveTargets(
  declared: unknown,
  projectRoot: string,
  recordings: (target: Target, where: string) => Pick<ResolvedTarget, 'trace' | 'video'>,
  credentials: ReadonlyMap<string, ResolvedCredential>,
): readonly ResolvedTarget[] {
  if (declared === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      'targets is required: declare at least one target and the engine that drives it, e.g. targets: [{ engine }]',
    );
  }
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new ConfigurationError('INVALID_CONFIG', 'targets must be a non-empty array');
  }
  const seen = new Set<string>();
  const defaulted = new Set<string>();
  return (declared as readonly unknown[]).map((entry, index): ResolvedTarget => {
    if (!isRecord(entry)) throw new ConfigurationError('INVALID_CONFIG', `targets[${index}] must be an object, got ${describeValue(entry)}`);
    const target = entry as Target;
    // Errors raised before the name settles point at the entry itself.
    const where = typeof target.name === 'string' ? `target "${target.name}"` : `targets[${index}]`;
    for (const key of Object.keys(target)) {
      if (!TARGET_KEYS.has(key)) throw unknownTargetKey(where, key);
    }
    if (target.engine !== undefined && !isEngineHandle(target.engine)) {
      const got = typeof target.engine === 'string' ? `the string ${JSON.stringify(target.engine)}` : `a ${typeof target.engine}`;
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where} engine must be an engine handle, got ${got}; call the engine's factory: web() from @e2e-dev/web, mobile({ platform }) from @e2e-dev/mobile, or your own defineEngine(...)`,
      );
    }
    const platform = resolvePlatform(target, where);
    const name = target.name === undefined ? platform : target.name;
    if (typeof name !== 'string' || !TARGET_NAME_PATTERN.test(name)) {
      const source = target.name === undefined ? ' (defaulted from the platform)' : '';
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `invalid target name ${JSON.stringify(name)}${source}; target names are limited to ASCII letters, numbers, "_", "-", and ".", and cannot be only dots`,
      );
    }
    if (seen.has(name)) {
      const hint =
        target.name === undefined || defaulted.has(name)
          ? '; a target without a name is named after its platform, so name one of them'
          : '';
      throw new ConfigurationError('INVALID_CONFIG', `duplicate target name "${name}"${hint}`);
    }
    seen.add(name);
    if (target.name === undefined) defaulted.add(name);
    const declaredApp = checkTargetApp(name, target.engine, target.app);
    const app = resolveTargetApp(name, declaredApp, projectRoot);
    const session = resolveSession(where, target.session, app, target.engine, credentials);
    return {
      name,
      index,
      platform,
      engine: target.engine,
      app,
      declaredApp,
      ...(session === undefined ? {} : { session }),
      ...recordings(target, where),
    };
  });
}

/** Keys a target's `session` takes; anything else is refused rather than ignored. */
const SESSION_KEYS: ReadonlySet<string> = new Set(['account', 'login', 'check']);

/**
 * Resolves the shared login a target declares. The app must be addressable
 * and the engine must capture and restore state; the account must name a
 * configured credential. The store key is the app's identity and the
 * account, so a port a run assigned never changes it.
 */
function resolveSession(
  where: string,
  declared: unknown,
  app: ResolvedApp,
  engine: EngineHandle | undefined,
  credentials: ReadonlyMap<string, ResolvedCredential>,
): ResolvedTargetSession | undefined {
  if (declared === undefined) return undefined;
  if (!isRecord(declared)) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} session must be an object, got ${describeValue(declared)}`);
  }
  for (const key of Object.keys(declared)) {
    if (!SESSION_KEYS.has(key)) {
      throw new ConfigurationError(
        'INVALID_CONFIG',
        `${where} session has unknown key "${key}"; a session is { account, login, check }`,
      );
    }
  }
  const account = declared['account'];
  const login = declared['login'];
  const check = declared['check'];
  if (typeof account !== 'string' || account.trim() === '') {
    throw new ConfigurationError('INVALID_CONFIG', `${where} session account must be a non-empty string`);
  }
  if (typeof login !== 'function' || typeof check !== 'function') {
    throw new ConfigurationError('INVALID_CONFIG', `${where} session login and check must be functions`);
  }
  if (app.base === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} declares session but its app has no url; a shared login needs an addressable app`,
    );
  }
  if (engine?.state?.capture === undefined || engine.state.restore === undefined) {
    throw new ConfigurationError(
      'UNSUPPORTED_CAPABILITY',
      `${where} declares session, but engine ${engine?.name ?? 'none'} has no state capability to save and restore a login`,
    );
  }
  const credential = credentials.get(account);
  if (credential === undefined) {
    const known = [...credentials.keys()];
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} session account "${account}" is not configured in credentials${known.length === 0 ? '' : `; configured: ${known.join(', ')}`}`,
    );
  }
  return {
    account,
    login: login as TargetSessionConfig['login'],
    check: check as TargetSessionConfig['check'],
    credential: credentialHandle(credential),
    key: canonicalDigest({ app: app.identity ?? app.base.origin, environment: app.environment, account }),
  };
}

/**
 * The targets on the run's `ports`: each target's app resolved again on the
 * port assigned to it. Identities, digests, and every check were settled
 * without them.
 */
export function bindTargets(targets: readonly ResolvedTarget[], projectRoot: string, ports: PortAssignments): readonly ResolvedTarget[] {
  return targets.map((target) => ({ ...target, app: resolveTargetApp(target.name, target.declaredApp, projectRoot, Object.hasOwn(ports, target.name) ? ports[target.name] : undefined) }));
}

/**
 * Whether `app.open()` on the target launches a pinned app instead of
 * opening a URL: the target has no app URL, and its engine has no `open` but
 * relaunches an app in `restart`, as a device does. Explore and an MCP
 * session launch it before their first observation, the way a test does.
 */
export function launchesPinnedApp(target: ResolvedTarget): boolean {
  const session = target.engine?.session;
  return target.app.base === undefined && session?.open === undefined && session?.restart !== undefined;
}

/**
 * The targets as they enter the config digest. An engine handle holds live
 * functions; its digest identity is the declaration - name, version,
 * contract version, the platform it drives (a named target inherits it, so
 * two workers whose engines declare different platforms must not agree on
 * the digest), and capability set. The app enters as declared, env values
 * reduced to their names and the run's port never.
 */
export function digestTargets(targets: readonly ResolvedTarget[]) {
  return targets.map(({ name, platform, engine, declaredApp }) => ({
    name,
    platform,
    app: digestTargetApp(declaredApp),
    ...(engine === undefined
      ? {}
      : {
          engine: {
            name: engine.name,
            ...(engine.version === undefined ? {} : { version: engine.version }),
            spiVersion: engine.spiVersion,
            ...(engine.platform === undefined ? {} : { platform: engine.platform }),
            ...(engine.workers === undefined ? {} : { workers: engine.workers }),
            capabilities: [...engine.capabilities].toSorted(),
          },
        }),
  }));
}

/**
 * The target's platform: its own label, else the engine's declaration. Tool
 * packs are offered by the engine's platform while tests filter by the
 * target's, so a target that names one while its engine declares another is a
 * mistake, not an override.
 */
function resolvePlatform(target: Target, where: string): string {
  const declared = target.platform;
  if (declared !== undefined && (typeof declared !== 'string' || declared.trim() === '')) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} platform must be a non-empty string`);
  }
  const inherited = target.engine?.platform;
  if (declared !== undefined && inherited !== undefined && declared !== inherited) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} declares platform "${declared}" but its engine ${target.engine?.name} drives "${inherited}"; drop the target's platform or make them agree`,
    );
  }
  const platform = declared ?? inherited;
  if (platform === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} needs a platform: ${
        target.engine === undefined ? 'it has no engine to inherit one from' : `engine ${target.engine.name} declares none`
      }; set platform on the target`,
    );
  }
  return platform;
}
