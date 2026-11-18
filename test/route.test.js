import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from '../lib/route.js';
import { normalizeConfig } from '../lib/config.js';

function setup({ reject = 0, repair } = {}) {
  const config = normalizeConfig({});
  const ctx = { get: (name) => (name === 'connection' ? { requestRejection: () => reject } : null) };
  const calls = [];
  const engine = repair ?? {
    async status(options) {
      calls.push(['status', options]);
      return { ok: true, blocked: [{ name: 'dsh-caveman' }], counts: { bundles: 2, blocked: 1 } };
    },
    async release(name) {
      calls.push(['release', name]);
      return { ok: true, released: [] };
    },
    async update(name, options) {
      calls.push(['update', name, options]);
      return { ok: true, step: 'update', bundle: name };
    },
    async remove(name) {
      calls.push(['remove', name]);
      return { ok: true, step: 'remove', bundle: name };
    },
    async heal(name, options) {
      calls.push(['heal', name, options]);
      return { ok: true, step: 'update', bundle: name };
    },
  };
  return { handler: createHandler({ ctx, repair: engine, config }), calls, config };
}

function request({ method = 'GET', url = '/dsh-plugin-unlock/status', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

function response() {
  const res = {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(text) {
      res.body = text ?? '';
      return res;
    },
    json() {
      return JSON.parse(res.body);
    },
  };
  return res;
}

test('the index describes the surface', async () => {
  const { handler } = setup();
  const res = response();
  await handler(request({ url: '/dsh-plugin-unlock' }), res);
  assert.equal(res.status, 200);
  assert.equal(res.json().plugin, 'dsh-plugin-unlock');
  assert.equal(res.json().actions.length, 8);
});

test('status answers with what blocks which bundle', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler(request({ url: '/dsh-plugin-unlock/status?name=dsh-caveman' }), res);
  assert.equal(res.status, 200);
  assert.equal(res.json().blocked.length, 1);
  assert.deepEqual(calls, [['status', { name: 'dsh-caveman' }]]);
});

test('the actions drive the engine and return JSON', async () => {
  const { handler, calls } = setup();

  const release = response();
  await handler(request({ method: 'POST', url: '/dsh-plugin-unlock/release', body: { name: 'dsh-caveman' } }), release);
  assert.equal(release.json().action, 'release');

  const update = response();
  await handler(request({ method: 'POST', url: '/dsh-plugin-unlock/update', body: { name: 'dsh-caveman', version: '2.0.0' } }), update);
  assert.equal(update.json().step, 'update');

  const heal = response();
  await handler(request({ method: 'POST', url: '/dsh-plugin-unlock/heal', body: { name: 'dsh-caveman', update: false } }), heal);
  assert.equal(heal.json().action, 'heal');

  const remove = response();
  await handler(request({ method: 'POST', url: '/dsh-plugin-unlock/remove', body: { name: 'dsh-caveman' } }), remove);
  assert.equal(remove.json().step, 'remove');

  assert.deepEqual(calls, [
    ['release', 'dsh-caveman'],
    ['update', 'dsh-caveman', { version: '2.0.0' }],
    ['heal', 'dsh-caveman', { version: undefined, update: false }],
    ['remove', 'dsh-caveman'],
  ]);
});

test('a POST without a body releases every blocked bundle', async () => {
  const { handler, calls } = setup();
  const res = response();
  await handler(request({ method: 'POST', url: '/dsh-plugin-unlock/release' }), res);
  assert.equal(res.status, 200);
  assert.deepEqual(calls, [['release', undefined]]);
});

test('heal-all repairs every blocked bundle', async () => {
  const repair = {
    async status() {
      return { ok: true, blocked: [{ name: 'a' }, { name: 'b' }] };
    },
    async heal(name) {
      return { ok: true, bundle: name };
    },
  };
  const { handler } = setup({ repair });
  const res = response();
  await handler(request({ method: 'POST', url: '/dsh-plugin-unlock/heal-all', body: {} }), res);
  const body = res.json();
  assert.equal(body.repaired.length, 2);
  assert.equal(body.ok, true);
});

test('a rejected connection is answered without touching the engine', async () => {
  const { handler, calls } = setup({ reject: 401 });
  const res = response();
  await handler(request({ url: '/dsh-plugin-unlock/status' }), res);
  assert.equal(res.status, 401);
  assert.deepEqual(calls, []);
});

test('wrong method, unknown route and bad JSON are answered, never thrown', async () => {
  const { handler } = setup();

  const wrongMethod = response();
  await handler(request({ method: 'GET', url: '/dsh-plugin-unlock/release' }), wrongMethod);
  assert.equal(wrongMethod.status, 405);

  const unknown = response();
  await handler(request({ method: 'POST', url: '/dsh-plugin-unlock/nope', body: {} }), unknown);
  assert.equal(unknown.status, 404);

  const badJson = response();
  await handler(request({ method: 'POST', url: '/dsh-plugin-unlock/heal', body: '{oops' }), badJson);
  assert.equal(badJson.status, 500);
  assert.match(badJson.json().error, /不是合法的 JSON/);
});

test('an engine failure becomes a 500 with the message', async () => {
  const { handler } = setup({
    repair: {
      async status() {
        throw new Error('listBundles exploded');
      },
    },
  });
  const res = response();
  await handler(request({ url: '/dsh-plugin-unlock/status' }), res);
  assert.equal(res.status, 500);
  assert.equal(res.json().error, 'listBundles exploded');
});
