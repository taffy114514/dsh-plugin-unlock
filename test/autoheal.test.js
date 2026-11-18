import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../lib/config.js';
import { registerAutoHeal } from '../lib/autoheal.js';
import { makeCtx, makeEntry, makeLog } from './fakes.js';

const SETTLE_WAIT_MS = 650;

function wait(ms = SETTLE_WAIT_MS) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setup({ config, entries = [], repairable = () => true } = {}) {
  const log = makeLog();
  const resolvedConfig = normalizeConfig(config ?? {});
  const state = { healing: new Set(), inFlight: new Set(), attempts: new Map() };
  const calls = [];
  const released = [];
  const repair = {
    inCooldown: () => false,
    liveEntries() {
      return entries.filter((entry) => entry?.fiber?.uid != null);
    },
    async release(name) {
      if (!repairable(name)) return { ok: false, bundle: name, reason: `${name} is a protected bundle` };
      const live = entries.filter((entry) => entry?.fiber?.uid != null);
      for (const entry of live) await entry.fiber.dispose();
      released.push(name);
      return { ok: true, released: [{ bundle: name, ok: true, steps: [], remaining: [] }] };
    },
    async heal(name, options) {
      calls.push({ name, options });
      state.attempts.set(name, Date.now());
      return { ok: true, step: 'update', bundle: name };
    },
  };
  const ctx = makeCtx();
  const dispose = registerAutoHeal({ ctx, repair, config: resolvedConfig, state, log });
  return { ctx, log, state, calls, released, repair, dispose, config: resolvedConfig, entries };
}

const FAILED = Object.freeze({
  id: 'op-1',
  reason: 'remove',
  stage: 'remove',
  target: 'dsh-caveman',
  time: '2026-01-01T00:00:00.000Z',
  phase: 'settled',
  application: 'failed',
  changed: false,
  errorCode: 'bundle-in-use',
});

test('a settled bundle-in-use failure triggers a repair of that bundle', async () => {
  const { ctx, calls, log } = setup();
  ctx.emit('plugin-manager/operation', FAILED);
  await wait();

  assert.deepEqual(calls, [{ name: 'dsh-caveman', options: { update: true } }]);
  assert.equal(log.events.find((event) => event.event === 'autoheal-start').bundle, 'dsh-caveman');
  assert.equal(log.events.at(-1).event, 'autoheal-done');
});

test('autoUpdate:false only releases', async () => {
  const { ctx, calls } = setup({ config: { autoUpdate: false } });
  ctx.emit('plugin-manager/operation', FAILED);
  await wait();
  assert.deepEqual(calls, [{ name: 'dsh-caveman', options: { update: false } }]);
});

test('nothing else triggers a repair', async () => {
  const { ctx, calls } = setup();
  const variants = [
    { ...FAILED, phase: 'started' },
    { ...FAILED, phase: 'unknown' },
    { ...FAILED, application: 'applied' },
    { ...FAILED, application: 'restart-required' },
    { ...FAILED, errorCode: 'not-removable' },
    { ...FAILED, errorCode: undefined },
    { ...FAILED, target: '' },
    { ...FAILED, target: undefined },
    null,
    'not an object',
  ];
  for (const variant of variants) ctx.emit('plugin-manager/operation', variant);
  await wait(100);
  assert.deepEqual(calls, []);
});

test('a bundle inside its cooldown window is left alone', async () => {
  const { ctx, calls, repair } = setup();
  repair.inCooldown = (name) => name === 'dsh-caveman';
  ctx.emit('plugin-manager/operation', FAILED);
  await wait(100);
  assert.deepEqual(calls, []);
});

test('a bundle already being repaired is not repaired twice', async () => {
  const { ctx, calls, state } = setup();
  state.healing.add('dsh-caveman');
  ctx.emit('plugin-manager/operation', FAILED);
  await wait(100);
  assert.deepEqual(calls, []);
});

test('a repair that throws is logged and the event dispatch survives', async () => {
  const { ctx, log, repair, calls } = setup();
  repair.heal = async () => {
    throw new Error('lock timeout');
  };
  ctx.emit('plugin-manager/operation', FAILED);
  await wait();
  assert.equal(calls.length, 0);
  assert.equal(log.events.some((event) => event.event === 'autoheal-error'), true);
});

test('the disposer removes the listener', () => {
  const { ctx, dispose } = setup();
  assert.equal(ctx.listenerCount('plugin-manager/operation'), 1);
  dispose();
  assert.equal(ctx.listenerCount('plugin-manager/operation'), 0);
});

test('a context without an event channel is tolerated', () => {
  const log = makeLog();
  const dispose = registerAutoHeal({ ctx: {}, repair: {}, config: normalizeConfig({}), state: { healing: new Set(), inFlight: new Set(), attempts: new Map() }, log });
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(log.events.at(-1).event, 'autoheal-unavailable');
});


test('an operation that is starting frees the fiber before the manager tests it', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const { ctx, calls, log } = setup({ entries: [entry] });
  ctx.emit('plugin-manager/operation', { ...FAILED, id: 'op-start', phase: 'started' });
  await wait(100);

  assert.equal(entry.fiber.uid, null, 'the fiber must be gone before the manager checks');
  assert.deepEqual(calls, [], 'a preventive release never finishes the update on its own');
  assert.equal(log.events.some((event) => event.event === 'prevent-released'), true);
});

test('a protected bundle is refused before any fiber is touched', async () => {
  const entry = makeEntry({ id: 'web', name: 'web' });
  const { ctx, log } = setup({ entries: [entry], repairable: () => false });
  ctx.emit('plugin-manager/operation', { ...FAILED, id: 'op-core', phase: 'started', target: 'web' });
  await wait(100);

  assert.equal(entry.fiber.uid, 1, 'a core fiber is never disposed');
  assert.equal(log.events.some((event) => event.event === 'prevent-partial'), true);
});

test('this plugin never frees its own fibers mid-operation', async () => {
  const entry = makeEntry({ id: 'dsh-plugin-unlock', name: 'dsh-plugin-unlock' });
  const { ctx } = setup({ entries: [entry] });
  ctx.emit('plugin-manager/operation', { ...FAILED, id: 'op-self', phase: 'started', target: 'dsh-plugin-unlock' });
  await wait(100);
  assert.equal(entry.fiber.uid, 1);
});

test('an install that is starting is left alone', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const { ctx } = setup({ entries: [entry] });
  ctx.emit('plugin-manager/operation', { ...FAILED, id: 'op-install', phase: 'started', stage: 'install' });
  await wait(100);
  assert.equal(entry.fiber.uid, 1);
});
