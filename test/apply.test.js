import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, name, version } from '../index.js';
import { makeCtx, makeEntry, makeLoader, makeManager } from './fakes.js';

const ROWS = { 'dsh-caveman': [{ id: 'dsh-caveman', name: 'dsh-caveman' }] };
const BUNDLES = [{ name: 'dsh-caveman', version: '1.0.0', enabled: true, installed: true, official: false, availability: 'profile', removable: true }];

function fullCtx({ entries = [], manager, hmr = {} } = {}) {
  const registered = { tools: [], routes: [] };
  const ctx = makeCtx({
    pluginManager: manager,
    loader: makeLoader(entries),
    connection: { requestRejection: () => 0 },
    tools: {
      register(definition) {
        registered.tools.push(definition);
        return () => {};
      },
    },
    webServer: {
      register(options) {
        registered.routes.push(options);
        return () => {};
      },
    },
    hmr,
  });
  return { ctx, registered };
}

test('the plugin exports the identity the bundle patch declares', () => {
  assert.equal(name, 'dsh-plugin-unlock');
  assert.equal(version, '0.1.0');
});

test('apply registers the tool, the routes and the automatic repair', () => {
  const { ctx, registered } = fullCtx({ entries: [makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' })], manager: makeManager({ bundles: BUNDLES, rows: ROWS }) });
  apply(ctx, {});

  assert.deepEqual(registered.tools.map((tool) => tool.name), ['plugin_unlock']);
  assert.equal(registered.routes.length, 1);
  assert.equal(registered.routes[0].kind, 'prefix');
  assert.equal(registered.routes[0].path, '/dsh-plugin-unlock');
  assert.equal(ctx.listenerCount('plugin-manager/operation'), 1);
});

test('apply survives a Host without tools, webServer or the manager', () => {
  const ctx = makeCtx({});
  assert.doesNotThrow(() => apply(ctx, {}));
  assert.equal(ctx.effects.length, 3);
});

test('an unusable tool definition is logged, not thrown', () => {
  const ctx = makeCtx({
    tools: {
      register() {
        throw new Error('duplicate tool name');
      },
    },
  });
  assert.doesNotThrow(() => apply(ctx, {}));
});

test('autoFix:false keeps the automatic repair off', () => {
  const { ctx } = fullCtx({ manager: makeManager({ bundles: BUNDLES, rows: ROWS }) });
  apply(ctx, { autoFix: false });
  assert.equal(ctx.listenerCount('plugin-manager/operation'), 0);
});

test('the registered tool reports the block through the live services', async () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const manager = makeManager({
    bundles: BUNDLES,
    rows: ROWS,
    versions: { 'dsh-caveman': { status: 'listed', installed: '1.0.0', registry: 'registry', attempts: [], versions: [{ version: '1.2.0' }], omitted: 0 } },
  });
  const { ctx, registered } = fullCtx({ entries: [entry], manager });
  apply(ctx, {});
  const tool = registered.tools[0];

  const status = await tool.execute({ action: 'status', name: 'dsh-caveman' });
  assert.equal(status.ok, true);
  assert.equal(status.bundles[0].blocked, true);

  const heal = await tool.execute({ action: 'heal', name: 'dsh-caveman' });
  assert.equal(heal.ok, true);
  assert.equal(heal.to, '1.2.0');
  assert.equal(entry.fiber.uid, null);
});
