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

function setup({ entries = [], manager, config } = {}) {
  const log = makeLog();
  const resolvedConfig = normalizeConfig(config ?? {});
  const state = { healing: new Set(), inFlight: new Set(), attempts: new Map() };
  const ctx = makeCtx({
    pluginManager: manager,
    loader: makeLoader(entries),
    connection: { requestRejection: () => 0 },
  });
  const repair = createRepair({ ctx, config: resolvedConfig, state, log });
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
  assert.equal(status.blocked[0].entries[0].id, 'dsh-caveman');
  assert.equal(status.services.pluginManager, true);
  assert.equal(status.services.tools, false);
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
  assert.equal(manager.calls.updateBundle[0].options.requestId, undefined);
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
