/**
 * Test doubles: a cordis-shaped context, a loader with fibers, and a plugin
 * manager that records what the repair engine asked it to do.
 */

export function makeEntry({ id, name = id, uid = 1, state = 2, dispose } = {}) {
  const entry = {
    id,
    options: { id, name },
    parent: { tree: { ctx: { baseUrl: `file:///profile/node_modules/${name}/index.js` } } },
    fiber: {
      uid,
      state,
      dispose: dispose ?? (async () => {
        entry.fiber.uid = null;
      }),
    },
  };
  return entry;
}

export function makeLoader(entries = []) {
  return {
    entries() {
      return entries[Symbol.iterator]();
    },
  };
}

export function makeManager({
  bundles = [],
  rows = {},
  versions = {},
  throwFor = [],
  updateResult = () => ({ from: '1.0.0', to: '2.0.0', step: 'install', result: { application: 'applied', changed: true } }),
  removeResult = () => ({ application: 'applied', changed: true }),
} = {}) {
  const calls = { bundleRows: [], listBundles: 0, listVersions: [], updateBundle: [], removeBundle: [] };
  return {
    calls,
    bundleRows(name) {
      calls.bundleRows.push(name);
      if (throwFor.includes(name)) throw new Error(`cannot read the manifest of ${name}`);
      // A real manager answers [] for a bundle that declares no plugin rows.
      return rows[name] ?? [];
    },
    async listBundles() {
      calls.listBundles += 1;
      return bundles;
    },
    async listVersions(name, options) {
      calls.listVersions.push({ name, options });
      return versions[name] ?? { status: 'refused', problem: 'not-updatable', reason: 'not from a registry', attempts: [] };
    },
    async updateBundle(name, version, options) {
      calls.updateBundle.push({ name, version, options });
      return updateResult(name, version);
    },
    async removeBundle(name) {
      calls.removeBundle.push(name);
      return removeResult(name);
    },
  };
}

export function makeCtx(services = {}) {
  const listeners = new Map();
  const effects = [];
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    get(name) {
      return services[name] ?? null;
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    effect(run, label) {
      const dispose = run();
      effects.push({ label, dispose });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
    emit(event, payload) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    effects,
  };
  return ctx;
}

export function makeLog() {
  const events = [];
  const log = (event, detail) => {
    events.push({ event, ...(detail ?? {}) });
    return events[events.length - 1];
  };
  log.events = events;
  log.file = null;
  return log;
}

/** A manager whose update/remove fail with the desktop's own refusal code. */
export function bundleInUseError() {
  const error = new Error('bundle-in-use');
  error.code = 'bundle-in-use';
  return error;
}
