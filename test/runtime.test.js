import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { PNPM_ENTRY, looksLikeRuntimeFailure, probeHost, probeRuntime, runtimeHint, runtimeRoots } from '../lib/runtime.js';

/** Build a fake installation with (or without) the payload inside it. */
function fakeInstall({ payload = true, manifest = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-unlock-runtime-'));
  const install = join(root, 'DeepSeek Harness');
  const runtimeRoot = join(install, 'resources', 'runtime', 'primary-runtime');
  mkdirSync(runtimeRoot, { recursive: true });
  if (payload) {
    const entry = join(runtimeRoot, ...PNPM_ENTRY);
    mkdirSync(dirname(entry), { recursive: true });
    writeFileSync(entry, '// pnpm\n');
  }
  if (manifest) writeFileSync(join(runtimeRoot, 'runtime.json'), '{}\n');
  return { root, execPath: join(install, 'DeepSeek Harness.exe'), runtimeRoot };
}

test('the payload is resolved from the environment the Host exports', () => {
  const { runtimeRoot, execPath } = fakeInstall();
  const roots = runtimeRoots({ env: { DSH_PRIMARY_RUNTIME: runtimeRoot }, execPath });
  assert.equal(roots[0].source, 'DSH_PRIMARY_RUNTIME');
  assert.equal(roots[0].root, runtimeRoot);
  assert.equal(roots[1].source, 'execPath');
});

test('a real payload is reported present', () => {
  const { runtimeRoot, execPath } = fakeInstall();
  const probe = probeRuntime({ env: {}, execPath });
  assert.equal(probe.ok, true);
  assert.equal(probe.source, 'execPath');
  assert.equal(probe.pnpmPath, join(runtimeRoot, ...PNPM_ENTRY));
  assert.equal(probe.runtimeJson, true);
  assert.equal(runtimeHint(probe), null);
});

test('a missing payload is reported with the path that was checked', () => {
  const { execPath, runtimeRoot } = fakeInstall({ payload: false, manifest: false });
  const probe = probeRuntime({ env: {}, execPath });
  assert.equal(probe.ok, false);
  assert.equal(probe.pnpmPath, join(runtimeRoot, ...PNPM_ENTRY));
  assert.equal(probe.runtimeJson, false);
  assert.match(runtimeHint(probe), /运行时 payload/);
  assert.match(runtimeHint(probe), /重装/);
});

test('an env var pointing at nothing does not hide a working payload', () => {
  const { execPath, runtimeRoot } = fakeInstall();
  const probe = probeRuntime({ env: { DSH_PRIMARY_RUNTIME: join(tmpdir(), 'nowhere-at-all') }, execPath });
  assert.equal(probe.ok, true);
  assert.equal(probe.pnpmPath, join(runtimeRoot, ...PNPM_ENTRY));
  assert.equal(probe.candidates[0].present, false);
});

test('a runtime failure is told apart from a manager refusal', () => {
  assert.equal(looksLikeRuntimeFailure(new Error("Cannot find module '...\\primary-runtime\\dependencies\\pnpm\\bin\\pnpm.mjs'")), true);
  assert.equal(looksLikeRuntimeFailure('ERR_PNPM_UNEXPECTED_STORE Unexpected store location for pnpm'), true);
  assert.equal(looksLikeRuntimeFailure(new Error('bundle-in-use')), false);
  assert.equal(looksLikeRuntimeFailure(new Error('not-removable')), false);
  assert.equal(looksLikeRuntimeFailure('ENOENT: no such file, open package.json'), false);
  assert.equal(looksLikeRuntimeFailure(undefined), false);
});

test('probeHost reads the running Harness version from the application manifest', () => {
  const host = probeHost({
    execPath: '/apps/DeepSeek Harness/DeepSeek Harness.exe',
    readFile: (path) => {
      assert.equal(path, join('/apps/DeepSeek Harness', 'resources', 'app', 'dsh', 'package.json'));
      return JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.2-rc.5' });
    },
  });
  assert.equal(host.dshVersion, '0.2.2-rc.5');
});

test('probeHost answers null instead of throwing when the manifest is gone', () => {
  const host = probeHost({ execPath: '/apps/x.exe', readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(host.dshVersion, null);
  assert.equal(probeHost({ execPath: '' }).dshVersion, null);
});
