import assert from 'node:assert/strict';
import test from 'node:test';

import { createUnlockTool } from '../lib/tool.js';

function fakeRepair(overrides = {}) {
  const calls = [];
  const repair = {
    calls,
    async status(options) {
      calls.push(['status', options]);
      return {
        ok: true,
        generatedAt: '2026-01-01T00:00:00.000Z',
        counts: { bundles: 2, blocked: 1 },
        blocked: [{ name: 'dsh-caveman', entries: [{ id: 'dsh-caveman', name: 'dsh-caveman' }] }],
        bundles: [{ name: 'dsh-caveman', blocked: true, blockedBy: [{ id: 'dsh-caveman' }] }, { name: 'dsh-market', blocked: false, blockedBy: [] }],
        services: { pluginManager: true },
      };
    },
    async release(name) {
      calls.push(['release', name]);
      return { ok: true, released: [{ bundle: name, ok: true, steps: [{ released: true }], remaining: [] }] };
    },
    async update(name, options) {
      calls.push(['update', name, options]);
      return { ok: true, step: 'update', bundle: name, to: options.version ?? '1.4.2', versionSource: 'registry' };
    },
    async remove(name) {
      calls.push(['remove', name]);
      return { ok: true, step: 'remove', bundle: name };
    },
    async heal(name, options) {
      calls.push(['heal', name, options]);
      return { ok: true, step: 'update', bundle: name };
    },
    runtime() {
      calls.push(['runtime']);
      return { ok: true, source: 'DSH_PRIMARY_RUNTIME', root: '/rt', pnpmPath: '/rt/dependencies/pnpm/bin/pnpm.mjs', runtimeJson: true, candidates: [], hint: null };
    },
    ...overrides,
  };
  return repair;
}

test('the tool definition is what the Host expects', () => {
  const tool = createUnlockTool(fakeRepair());
  assert.equal(tool.name, 'plugin_unlock');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['action']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.action.enum, ['status', 'in_use', 'runtime', 'release', 'update', 'remove', 'heal']);
  assert.equal(tool.output.schema.type, 'object');
  const rendered = tool.output.render({}, { ok: true });
  assert.deepEqual(rendered, [{ type: 'text', text: '{\n  "ok": true\n}' }]);
  assert.equal(tool.isConcurrencySafe(), false);
});

test('each action reaches the matching engine call', async () => {
  const repair = fakeRepair();
  const tool = createUnlockTool(repair);

  const status = await tool.execute({ action: 'status', name: 'dsh-caveman' });
  assert.equal(status.ok, true);
  assert.equal(status.action, 'status');
  assert.match(status.hint, /blocked by 1 live loader entry/);

  const inUse = await tool.execute({ action: 'in_use' });
  assert.deepEqual(inUse.blocked.length, 1);

  const release = await tool.execute({ action: 'release', name: 'dsh-caveman' });
  assert.equal(release.ok, true);

  const update = await tool.execute({ action: 'update', name: 'dsh-caveman', version: '2.0.0' });
  assert.equal(update.to, '2.0.0');

  const remove = await tool.execute({ action: 'remove', name: 'dsh-caveman' });
  assert.equal(remove.step, 'remove');

  const heal = await tool.execute({ action: 'heal', name: 'dsh-caveman', update: false });
  assert.equal(heal.ok, true);

  assert.deepEqual(repair.calls.map((call) => call[0]), ['status', 'status', 'release', 'update', 'remove', 'heal']);
  assert.deepEqual(repair.calls.at(-1), ['heal', 'dsh-caveman', { version: undefined, update: false }]);
});

test('an unknown or missing action is answered, not thrown', async () => {
  const tool = createUnlockTool(fakeRepair());
  const unknown = await tool.execute({ action: 'explode' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /unknown action/);
  const none = await tool.execute({});
  assert.equal(none.action, 'status');
  const nothing = await tool.execute(undefined);
  assert.equal(nothing.action, 'status');
});

test('an engine failure becomes a tool result with its code', async () => {
  const repair = fakeRepair({
    async heal() {
      const error = new Error('bundle-in-use');
      error.code = 'bundle-in-use';
      throw error;
    },
  });
  const result = await createUnlockTool(repair).execute({ action: 'heal', name: 'dsh-caveman' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bundle-in-use');
});

test('a status result without a blocked bundle gets a matching hint', async () => {
  const repair = fakeRepair({
    async status() {
      return { ok: true, counts: { bundles: 2, blocked: 0 }, blocked: [], bundles: [{ name: 'x', blocked: false, blockedBy: [] }] };
    },
  });
  const tool = createUnlockTool(repair);
  assert.match((await tool.execute({ action: 'status' })).hint, /No bundle is blocked/);
  assert.match((await tool.execute({ action: 'status', name: 'x' })).hint, /not blocked/);
  assert.match((await tool.execute({ action: 'status', name: 'y' })).hint, /not a bundle this profile lists/);
});

test('every action returns lossless JSON, with no undefined values', async () => {
  const tool = createUnlockTool(fakeRepair());
  const cases = [{ action: 'runtime' }, { action: 'status' }, { action: 'in_use' }, { action: 'release', name: 'dsh-caveman' }];
  for (const args of cases) {
    const result = await tool.execute(args);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result, `action ${args.action} must survive JSON`);
    assert.doesNotThrow(() => JSON.stringify(result, (_key, value) => {
      if (value === undefined) throw new Error('undefined value');
      return value;
    }));
  }
});
