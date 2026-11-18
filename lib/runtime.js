/**
 * The package manager the Host actually runs installs and removals through.
 *
 * Releasing a stuck fiber is only half of an update. The second half is the
 * Host's own `pnpm remove` / `pnpm add`, and the desktop runs that from the
 * runtime payload it ships next to the application:
 *
 *   <resources>/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs
 *
 * The Host exports that root as `DSH_PRIMARY_RUNTIME` before it spawns pnpm, so
 * the same path can be resolved here and checked. When the payload is missing
 * (an interrupted update, a cleaner that emptied `resources/runtime`, a copied
 * or partially unpacked installation) every plugin operation fails *after* the
 * lock is cleared, with a `MODULE_NOT_FOUND` for that exact file — which reads
 * like a plugin bug but is not one. Reporting it plainly is the point of this
 * module: `bundle-in-use` and `pnpm.mjs is missing` are different problems and
 * only the first one is a lock.
 *
 * Nothing here writes, spawns or installs anything. It stats two paths.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The entry point inside the payload, as the desktop host builds it. */
export const PNPM_ENTRY = ['dependencies', 'pnpm', 'bin', 'pnpm.mjs'];

/** The manifest that proves the whole payload (node, python, pnpm) is installed. */
export const RUNTIME_MANIFEST = 'runtime.json';

function isFile(path) {
  if (typeof path !== 'string' || path === '') return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Every place the payload could be, most authoritative first.
 * @param {{env?: Record<string, string | undefined>, execPath?: string}} [options]
 */
export function runtimeRoots(options = {}) {
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const roots = [];
  const fromEnv = typeof env?.DSH_PRIMARY_RUNTIME === 'string' ? env.DSH_PRIMARY_RUNTIME.trim() : '';
  if (fromEnv) roots.push({ root: fromEnv, source: 'DSH_PRIMARY_RUNTIME' });
  if (typeof execPath === 'string' && execPath !== '') {
    // <install>/DeepSeek Harness.exe → <install>/resources/runtime/primary-runtime
    roots.push({ root: join(dirname(execPath), 'resources', 'runtime', 'primary-runtime'), source: 'execPath' });
  }
  return roots;
}

/**
 * Resolve and stat the package manager the Host would run.
 * `ok` is true only when the exact file the Host spawns exists.
 * @param {{env?: Record<string, string | undefined>, execPath?: string}} [options]
 */
export function probeRuntime(options = {}) {
  const candidates = runtimeRoots(options).map(({ root, source }) => {
    const pnpmPath = join(root, ...PNPM_ENTRY);
    return {
      source,
      root,
      pnpmPath,
      present: isFile(pnpmPath),
      runtimeJson: isFile(join(root, RUNTIME_MANIFEST)),
    };
  });
  // A payload that exists wins over an environment variable pointing at nothing.
  const found = candidates.find((candidate) => candidate.present) ?? candidates[0] ?? null;
  return {
    ok: found?.present === true,
    source: found?.source ?? 'none',
    root: found?.root ?? null,
    pnpmPath: found?.pnpmPath ?? null,
    runtimeJson: found?.runtimeJson === true,
    candidates: candidates.map(({ source, pnpmPath, present, runtimeJson }) => ({ source, pnpmPath, present, runtimeJson })),
  };
}

/**
 * The running DeepSeek Harness version, read from the application manifest.
 *
 * Since 0.2.2-rc.5 the plugin manager refuses an install or an update with
 * `incompatible-version` when the target's `engines.dsh` / `peerDependencies`
 * do not accept this Host, and `listVersions()` marks every such version with
 * `incompatible`. Reporting the exact runtime version next to that decision is
 * what lets a user tell "the plugin is broken" from "this version predates my
 * Harness". Read-only, and null when the manifest cannot be found.
 *
 * @param {{execPath?: string, readFile?: (path: string) => string}} [options]
 */
export function probeHost(options = {}) {
  const execPath = options.execPath ?? process.execPath;
  const readFile = options.readFile ?? ((path) => readFileSync(path, 'utf8'));
  if (typeof execPath !== 'string' || execPath === '') return { dshVersion: null, manifestPath: null };
  // <install>/DeepSeek Harness.exe → <install>/resources/app/dsh/package.json
  const manifestPath = join(dirname(execPath), 'resources', 'app', 'dsh', 'package.json');
  try {
    const manifest = JSON.parse(readFile(manifestPath));
    const version = typeof manifest?.version === 'string' ? manifest.version : null;
    return { dshVersion: version, manifestPath };
  } catch {
    return { dshVersion: null, manifestPath };
  }
}

/** What to tell a user whose payload is missing, or null when it is fine. */
export function runtimeHint(probe) {
  if (probe?.ok === true) return null;
  const where = probe?.pnpmPath ?? '<resources>/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs';
  return `the desktop application is missing the runtime payload it runs pnpm from (${where}). Releasing the lock does not help while it is gone: repair or reinstall DeepSeek Harness so resources/runtime/primary-runtime is restored, then retry.`;
}

const RUNTIME_CODES = /ERR_PNPM_UNEXPECTED_STORE|ERR_PNPM_NO_STORE|ERR_PNPM_META_FETCH_FAIL|MODULE_NOT_FOUND|ENOENT/;

/**
 * Whether a thrown value is the payload talking, not the lock.
 * Kept deliberately narrow: a missing *package* also throws ENOENT, so the
 * message has to mention the payload path or the package manager itself.
 * @param {unknown} error
 */
export function looksLikeRuntimeFailure(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (message === '') return false;
  if (/pnpm\.mjs|primary-runtime/i.test(message)) return true;
  return RUNTIME_CODES.test(message) && /pnpm|runtime|DSH_PRIMARY_RUNTIME/i.test(message);
}
