import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../lib/config.js';
import { createRepair, errorFact } from '../lib/repair.js';
import { makeCtx, makeEntry, makeLoader, makeLog, makeManager } from './fakes.js';

const ROWS = { 'dsh-caveman': [{ id: 'dsh-caveman', name: 'dsh-caveman' }] };
const BUNDLES = [
  { name: 'dsh-caveman', version: '1.0.0', enabled: true, installed: true, official: false, availability: 'profile', removable: true },
  { name: 'dsh-market', version: '1.73.20', enabled: true, installed: true, official: false, availability: 'profile', removable: true },
];

const RUNTIME_OK = { ok: true, source: 'DSH_PRIMARY_RUNTIME', root: '/rt', pnpmPath: '/rt/dependencies/pnpm/bin/pnpm.mjs', runtimeJson: true, candidates: [] };
const RUNTIME_GONE = { ok: false, source: 'execPath', root: '/app/resources/runtime/primary-runtime', pnpmPath: '/app/resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs', runtimeJson: false, candidates: [] };

function setup({ entries = [], manager, config, runtime = RUNTIME_OK } = {}) {
  const log = makeLog();
  const resolvedConfig = normalizeConfig(config ?? {});
  const state = { healing: new Set(), inFlight: new Set(), attempts: new Map() };
  const ctx = makeCtx({
    pluginManager: manager,
    loader: makeLoader(entries),
    connection: { requestRejection: () => 0 },
  });
  const repair = createRepair({ ctx, config: resolvedConfig, state, log, probe: () => runtime });
  return { ctx, repair, log, state, config: resolvedConfig };
}

test('status names the bundles a removal would be blocked by', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ entries: [entry, makeEntry({ id: 'dsh-market', name: 'dsh-market' })], manager });

  const status = await repair.status();
  assert.equal(status.ok, true);
  assert.equal(status.counts.bundles, 2);
  assert.equal(status.counts.blocked, 1);
  assert.equal(status.blocked[0].name, 'dsh-caveman');
  assert.equal(status.blocked[0].entries, 1, 'a summary counts the entries instead of dumping them');
  assert.equal(status.services.pluginManager, true);
  assert.equal(status.services.tools, false);

  const detail = await repair.status({ name: 'dsh-caveman' });
  assert.equal(detail.bundles[0].blockedBy[0].id, 'dsh-caveman', 'asking by name still gives the entries');
});

test('status reports a missing pluginManager instead of throwing', async () => {
  const { repair } = setup({ entries: [], manager: null });
  const status = await repair.status();
  assert.equal(status.ok, false);
  assert.match(status.reason, /pluginManager/);
});

test('release disposes exactly the blocking fibers and proves the block is gone', async () => {
  const blocked = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const untouched = makeEntry({ id: 'dsh-market', name: 'dsh-market' });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair, log } = setup({ entries: [blocked, untouched], manager });

  const result = await repair.release('dsh-caveman');
  assert.equal(result.ok, true);
  assert.equal(blocked.fiber.uid, null, 'the blocking fiber is disposed');
  assert.equal(untouched.fiber.uid, 1, 'an unrelated plugin keeps running');
  assert.deepEqual(result.released[0].remaining, []);
  assert.equal(result.released[0].steps[0].released, true);
  assert.equal(log.events.at(-1).event, 'release');
});

test('release reports a fiber it could not dispose and refuses to claim success', async () => {
  const stubborn = makeEntry({
    id: 'dsh-caveman',
    name: 'dsh-caveman',
    dispose: async () => {
      throw new Error('teardown refused');
    },
  });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ entries: [stubborn], manager });

  const result = await repair.release('dsh-caveman');
  assert.equal(result.ok, false);
  assert.equal(result.released[0].ok, false);
  assert.equal(result.released[0].steps[0].error.message, 'teardown refused');
  assert.equal(result.released[0].remaining.length, 1);
});

test('release without a name clears every blocked bundle', async () => {
  const first = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const rows = { ...ROWS, 'dsh-market': [{ id: 'dsh-market', name: 'dsh-market' }] };
  const second = makeEntry({ id: 'dsh-market', name: 'dsh-market' });
  const manager = makeManager({ bundles: BUNDLES, rows });
  const { repair } = setup({ entries: [first, second], manager });

  const result = await repair.release();
  assert.equal(result.ok, true);
  assert.equal(result.released.length, 2);
  assert.equal(first.fiber.uid, null);
  assert.equal(second.fiber.uid, null);
});

test('update releases first, then hands the newest version to the manager', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({
    bundles: BUNDLES,
    rows: ROWS,
    versions: { 'dsh-caveman': { status: 'listed', installed: '1.0.0', registry: 'https://registry.npmjs.org/', attempts: [], versions: [{ version: '1.4.2' }, { version: '1.3.0' }], omitted: 0 } },
  });
  const { repair } = setup({ entries: [entry], manager });

  const result = await repair.update('dsh-caveman');
  assert.equal(result.ok, true);
  assert.equal(result.step, 'update');
  assert.equal(result.to, '1.4.2');
  assert.equal(result.versionSource, 'registry');
  assert.deepEqual(manager.calls.updateBundle.map((call) => [call.name, call.version]), [['dsh-caveman', '1.4.2']]);
  assert.match(manager.calls.updateBundle[0].options.requestId, /^[0-9a-f-]{36}$/, 'the update carries a request id 0.2.2-rc.5 streams progress under');
  assert.equal(result.requestId, manager.calls.updateBundle[0].options.requestId);
});

test('an explicit version wins over the registry list', async () => {
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });

  const result = await repair.update('dsh-caveman', { version: '1.9.9' });
  assert.equal(result.ok, true);
  assert.equal(result.versionSource, 'request');
  assert.equal(manager.calls.listVersions.length, 0, 'no registry round trip for an explicit version');
});

test('a bundle the registry cannot list is released but not updated', async () => {
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });

  const result = await repair.update('dsh-caveman');
  assert.equal(result.ok, false);
  assert.equal(result.step, 'list-versions');
  assert.equal(result.retryInMarket, true);
  assert.equal(manager.calls.updateBundle.length, 0);
});

test('a manager that fails the update is reported with its own code', async () => {
  const manager = makeManager({
    bundles: BUNDLES,
    rows: ROWS,
    updateResult: () => ({ from: '1.0.0', to: '2.0.0', step: 'install', result: { application: 'failed', stage: 'install', target: 'dsh-caveman', error: { code: 'bundle-in-use' } } }),
  });
  const { repair } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });

  const result = await repair.update('dsh-caveman', { version: '2.0.0' });
  assert.equal(result.ok, false);
  assert.equal(result.result.result.error.code, 'bundle-in-use');
});

test('a manager that throws is reported, never propagated', async () => {
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  manager.updateBundle = async () => {
    const error = new Error('lock timeout');
    error.code = 'lock-timeout';
    throw error;
  };
  const { repair } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });

  const result = await repair.update('dsh-caveman', { version: '2.0.0' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'lock-timeout');
});

test('remove releases then calls the manager, so the profile bookkeeping stays the manager\'s', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ entries: [entry], manager });

  const result = await repair.remove('dsh-caveman');
  assert.equal(result.ok, true);
  assert.equal(result.step, 'remove');
  assert.deepEqual(manager.calls.removeBundle, ['dsh-caveman']);
  assert.equal(entry.fiber.uid, null);
});

test('remove does not touch a package the manager refuses', async () => {
  const manager = makeManager({
    bundles: BUNDLES,
    rows: ROWS,
    removeResult: () => ({ application: 'failed', stage: 'remove', target: 'dsh-caveman', error: { code: 'not-removable' } }),
  });
  const { repair } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });

  const result = await repair.remove('dsh-caveman');
  assert.equal(result.ok, false);
  assert.equal(result.result.error.code, 'not-removable');
});

test('heal releases and finishes the update when the config allows it', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({
    bundles: BUNDLES,
    rows: ROWS,
    versions: { 'dsh-caveman': { status: 'listed', installed: '1.0.0', registry: 'registry', attempts: [], versions: [{ version: '1.1.0' }], omitted: 0 } },
  });
  const { repair, state } = setup({ entries: [entry], manager });

  const result = await repair.heal('dsh-caveman');
  assert.equal(result.ok, true);
  assert.equal(result.to, '1.1.0');
  assert.equal(entry.fiber.uid, null);
  assert.equal(typeof state.attempts.get('dsh-caveman'), 'number');
  assert.equal(state.inFlight.size, 0, 'the in-flight mark is always released');
});

test('heal with update:false stops after the release and says so', async () => {
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });

  const result = await repair.heal('dsh-caveman', { update: false });
  assert.equal(result.ok, true);
  assert.equal(result.step, 'release');
  assert.equal(manager.calls.updateBundle.length, 0);
});

test('heal refuses a second concurrent repair of the same bundle', async () => {
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair, state } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });
  state.inFlight.add('dsh-caveman');

  const result = await repair.heal('dsh-caveman');
  assert.equal(result.busy, true);
});

test('heal asks for a restart when the release cannot free the bundle', async () => {
  const stubborn = makeEntry({
    id: 'dsh-caveman',
    name: 'dsh-caveman',
    dispose: async () => {
      throw new Error('teardown refused');
    },
  });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ entries: [stubborn], manager });

  const result = await repair.heal('dsh-caveman');
  assert.equal(result.ok, false);
  assert.equal(result.needsRestart, true);
  assert.equal(manager.calls.updateBundle.length, 0);
});

test('the cooldown window is measured from the last attempt', async () => {
  const { repair, state } = setup({ entries: [], manager: makeManager({ bundles: BUNDLES, rows: ROWS }), config: { cooldownMs: 1000 } });
  state.attempts.set('dsh-caveman', Date.now());
  assert.equal(repair.inCooldown('dsh-caveman'), true);
  state.attempts.set('dsh-caveman', Date.now() - 5000);
  assert.equal(repair.inCooldown('dsh-caveman'), false);
  assert.equal(repair.inCooldown('never-seen'), false);
});

test('errorFact keeps the manager code and the message', () => {
  const error = new Error('bundle-in-use');
  error.code = 'bundle-in-use';
  assert.deepEqual(errorFact(error), { code: 'bundle-in-use', message: 'bundle-in-use' });
  assert.deepEqual(errorFact('plain'), { code: null, message: 'plain' });
});

test('config normalisation repairs a malformed patch config', () => {
  const config = normalizeConfig({ autoFix: 'yes', cooldownMs: -5, route: 'dsh-plugin-unlock/', maxLogEvents: 0 });
  assert.equal(config.autoFix, true, 'a non-boolean falls back to the default');
  assert.equal(config.cooldownMs, 600000);
  assert.equal(config.route, '/dsh-plugin-unlock');
  assert.equal(config.maxLogEvents, 1);
});

test('status reports the pnpm payload the Host installs through', async () => {
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ manager });
  const status = await repair.status();
  assert.equal(status.runtime.ok, true);
  assert.equal(status.runtime.pnpmPath, RUNTIME_OK.pnpmPath);
  assert.equal(status.runtime.hint, null);
});

test('update releases the lock but refuses to fake an install it cannot run', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS, versions: ['1.4.2'] });
  const { repair } = setup({ entries: [entry], manager, runtime: RUNTIME_GONE });

  const result = await repair.update('dsh-caveman');
  assert.equal(result.ok, false);
  assert.equal(result.step, 'runtime');
  assert.equal(result.needsRuntimeRepair, true);
  assert.match(result.runtime.hint, /runtime payload/);
  assert.equal(entry.fiber.uid, null, 'the lock is still cleared first');
  assert.equal(manager.calls.updateBundle.length, 0, 'the manager is not asked to install what cannot install');
});

test('remove is held back the same way when pnpm is missing', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const { repair } = setup({ entries: [entry], manager, runtime: RUNTIME_GONE });

  const result = await repair.remove('dsh-caveman');
  assert.equal(result.step, 'runtime');
  assert.equal(manager.calls.removeBundle.length, 0);
  assert.equal(entry.fiber.uid, null);
});

test('a manager failure that names pnpm is reported as a runtime problem', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS, versions: ['1.4.2'] });
  manager.updateBundle = async () => {
    const error = new Error("Cannot find module '...\\resources\\runtime\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.mjs'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  };
  const { repair } = setup({ entries: [entry], manager });

  const result = await repair.update('dsh-caveman', { version: '1.4.2' });
  assert.equal(result.step, 'runtime');
  assert.equal(result.needsRuntimeRepair, true);
  assert.equal(result.error.code, 'MODULE_NOT_FOUND');
});

// ── core bundles are reported, never released ────────────────────────────────
// The running Host is made of these fibers. Reporting them as "blocked" would
// invite a release that disposes the Host itself.

const CORE_ROWS = {
  '@deepseek-ai/dsh-base': [{ id: 'timer', name: '@deepseek-ai/dsh-base' }],
  '@deepseek-ai/dsh-web-app': [{ id: 'web', name: '@deepseek-ai/dsh-web-app' }],
  'dsh-caveman': [{ id: 'dsh-caveman', name: 'dsh-caveman' }],
};
const CORE_BUNDLES = [
  { name: '@deepseek-ai/dsh-base', version: '1.0.0', enabled: true, installed: true, official: true, availability: 'installation', removable: false },
  { name: '@deepseek-ai/dsh-web-app', version: '1.0.0', enabled: true, installed: true, official: true, availability: 'installation', removable: false },
  { name: 'dsh-caveman', version: '1.0.0', enabled: true, installed: true, official: false, availability: 'profile', removable: true },
];

test('core bundles with live fibers are not counted as blocked', async () => {
  const manager = makeManager({ bundles: CORE_BUNDLES, rows: CORE_ROWS });
  const { repair } = setup({
    entries: [makeEntry({ id: 'timer', name: '@deepseek-ai/dsh-base' }), makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })],
    manager,
  });

  const status = await repair.status();
  assert.equal(status.counts.bundles, 3);
  assert.equal(status.counts.blocked, 1, 'only the profile bundle the marketplace could refuse');
  assert.equal(status.blocked[0].name, 'dsh-caveman');
  const core = status.bundles.find((bundle) => bundle.name === '@deepseek-ai/dsh-base');
  assert.equal(core.blocked, false);
  assert.equal(core.repairable, false);

  const single = await repair.status({ name: '@deepseek-ai/dsh-base' });
  assert.equal(single.bundles[0].blockedBy.length, 1, 'asked by name, the raw entry is still visible');
});

test('release without a name never touches a core bundle', async () => {
  const manager = makeManager({ bundles: CORE_BUNDLES, rows: CORE_ROWS });
  const core = makeEntry({ id: 'timer', name: '@deepseek-ai/dsh-base' });
  const plugin = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const { repair } = setup({ entries: [core, plugin], manager });

  const result = await repair.release();
  assert.equal(result.ok, true);
  assert.deepEqual(result.released.map((row) => row.bundle), ['dsh-caveman']);
  assert.notEqual(core.fiber.uid, null, 'the Host fiber is untouched');
  assert.equal(plugin.fiber.uid, null);
});

test('release by name refuses a bundle the manager calls not-removable', async () => {
  const manager = makeManager({ bundles: CORE_BUNDLES, rows: CORE_ROWS });
  const core = makeEntry({ id: 'timer', name: '@deepseek-ai/dsh-base' });
  const { repair } = setup({ entries: [core], manager });

  const result = await repair.release('@deepseek-ai/dsh-base');
  assert.equal(result.ok, false);
  assert.match(result.reason, /official/);
  assert.match(result.reason, /not-removable/);
  assert.notEqual(core.fiber.uid, null);
  assert.equal(manager.calls.removeBundle.length, 0);
  assert.equal(manager.calls.updateBundle.length, 0);
});

test('heal on a core bundle stops at the refusal instead of asking for a restart', async () => {
  const manager = makeManager({ bundles: CORE_BUNDLES, rows: CORE_ROWS });
  const { repair } = setup({ entries: [makeEntry({ id: 'timer', name: '@deepseek-ai/dsh-base' })], manager });

  const result = await repair.heal('@deepseek-ai/dsh-base');
  assert.equal(result.ok, false);
  assert.equal(result.step, 'release');
  assert.equal(result.needsRestart, undefined);
  assert.equal(manager.calls.updateBundle.length, 0);
  assert.equal(manager.calls.removeBundle.length, 0);
});

test('a manager call that never answers becomes a timeout, not a hang', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  // A registry fetch (or the pnpm install behind updateBundle) can stall on a
  // flaky network; the repair must report that instead of waiting forever.
  manager.listVersions = () => new Promise(() => {});
  const { repair, log } = setup({ entries: [entry], manager, config: { deadlineMs: 20 } });

  const result = await repair.update('dsh-caveman');
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.refusal.reason.code, 'unlock-timeout');
  assert.equal(entry.fiber.uid, null, 'the release still happened first');
  assert.equal(log.events.some((event) => event.event === 'update-timeout'), true);
});

test('a version this Harness refuses is skipped, not aimed at', async () => {
  const manager = makeManager({
    bundles: BUNDLES,
    rows: ROWS,
    versions: {
      'dsh-caveman': {
        status: 'listed',
        installed: '1.0.0',
        registry: 'https://registry.npmjs.org/',
        attempts: [],
        versions: [
          { version: '1.9.0', incompatible: { name: 'dsh-caveman', version: '1.9.0', runtimeVersion: '0.2.2-rc.5', requirements: { 'engines.dsh': '>=0.3.0' }, exempted: false } },
          { version: '1.4.2' },
        ],
        omitted: 0,
      },
    },
  });
  const { repair } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });

  const result = await repair.update('dsh-caveman');
  assert.equal(result.ok, true);
  assert.equal(result.to, '1.4.2', 'the newest version 0.2.2-rc.5 accepts wins');
  assert.deepEqual(result.skippedIncompatible.map((item) => item.version), ['1.9.0']);
});

test('an update the Harness refuses as incompatible is named, not blamed on the lock', async () => {
  const manager = makeManager({
    bundles: BUNDLES,
    rows: ROWS,
    versions: { 'dsh-caveman': { status: 'listed', installed: '1.0.0', registry: null, attempts: [], versions: [{ version: '1.4.2' }], omitted: 0 } },
    updateResult: () => ({
      from: '1.0.0',
      to: '1.4.2',
      step: 'check',
      result: { changed: false, application: 'failed', stage: 'install', target: 'dsh-caveman@1.4.2', error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-caveman', version: '1.4.2' }] } },
    }),
  });
  const { repair, log } = setup({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager });

  const result = await repair.update('dsh-caveman');
  assert.equal(result.ok, false);
  assert.equal(result.step, 'compatible-version');
  assert.equal(result.needsCompatibleVersion, true);
  assert.match(result.reason, /incompatible/);
  assert.equal(log.events.at(-1).event, 'update');
});

test('when every newer version is incompatible the release still happens and the reason says so', async () => {
  const manager = makeManager({
    bundles: BUNDLES,
    rows: ROWS,
    versions: {
      'dsh-caveman': {
        status: 'listed',
        installed: '1.0.0',
        registry: null,
        attempts: [],
        versions: [{ version: '1.9.0', incompatible: { name: 'dsh-caveman' } }],
        omitted: 0,
      },
    },
  });
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const { repair, log } = setup({ entries: [entry], manager });

  const result = await repair.update('dsh-caveman');
  assert.equal(result.ok, false);
  assert.equal(result.step, 'compatible-version');
  assert.equal(result.needsCompatibleVersion, true);
  assert.equal(manager.calls.updateBundle.length, 0, 'nothing is installed that the Host would refuse');
  assert.equal(entry.fiber.uid, null, 'the fiber was freed anyway, so the marketplace can proceed');
  assert.equal(log.events.some((event) => event.event === 'update-incompatible'), true);
});

test('status reports the DeepSeek Harness version the compatibility check uses', async () => {
  const manager = makeManager({ bundles: BUNDLES, rows: ROWS });
  const log = makeLog();
  const ctx = makeCtx({ pluginManager: manager, loader: makeLoader([]) });
  const repair = createRepair({
    ctx,
    config: normalizeConfig({}),
    state: { healing: new Set(), inFlight: new Set(), attempts: new Map() },
    log,
    probe: () => RUNTIME_OK,
    hostProbe: () => ({ dshVersion: '0.2.2-rc.5', manifestPath: '/app/resources/app/dsh/package.json' }),
  });

  const status = await repair.status();
  assert.equal(status.runtime.dshVersion, '0.2.2-rc.5');
  assert.equal(status.runtime.ok, true);
});
