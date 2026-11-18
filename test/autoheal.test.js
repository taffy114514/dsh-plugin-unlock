import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../lib/config.js';
import { registerAutoHeal } from '../lib/autoheal.js';
import { makeCtx, makeLog } from './fakes.js';

const SETTLE_WAIT_MS = 650;

function wait(ms = SETTLE_WAIT_MS) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function setup({ config } = {}) {
  const log = makeLog();
  const resolvedConfig = normalizeConfig(config ?? {});
  const state = { healing: new Set(), inFlight: new Set(), attempts: new Map() };
  const calls = [];
  const repair = {
    inCooldown: () => false,
    async heal(name, options) {
      calls.push({ name, options });
      state.attempts.set(name, Date.now());
      return { ok: true, step: 'update', bundle: name };
    },
  };
  const ctx = makeCtx();
  const dispose = registerAutoHeal({ ctx, repair, config: resolvedConfig, state, log });
  return { ctx, log, state, calls, repair, dispose, config: resolvedConfig };
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
