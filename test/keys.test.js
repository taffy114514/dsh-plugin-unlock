import assert from 'node:assert/strict';
import test from 'node:test';

import { bundleRows, describeEntry, entriesOf, inUseEntries, isLiveFiber, summarize } from '../lib/keys.js';
import { makeEntry, makeLoader, makeManager } from './fakes.js';

test('a fiber whose uid is set counts as live, a disposed one does not', () => {
  assert.equal(isLiveFiber(makeEntry({ id: 'a' })), true);
  assert.equal(isLiveFiber(makeEntry({ id: 'a', uid: null })), false);
  assert.equal(isLiveFiber(undefined), false);
});

test('matching mirrors the manager: only the exact (id, name) pair of a bundle row blocks it', () => {
  const rows = { 'dsh-caveman': [{ id: 'dsh-caveman', name: 'dsh-caveman' }] };
  const mine = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const other = makeEntry({ id: 'dsh-caveman', name: 'dsh-other' });
  const unrelated = makeEntry({ id: 'dsh-grill-first', name: 'dsh-grill-first' });
  const manager = makeManager({ rows });
  const loader = makeLoader([mine, other, unrelated]);

  const matched = inUseEntries({ loader, manager, name: 'dsh-caveman' });
  assert.equal(matched.length, 1);
  assert.equal(matched[0], mine);
});

test('a disposed entry no longer blocks the bundle', () => {
  const rows = { 'dsh-caveman': [{ id: 'dsh-caveman', name: 'dsh-caveman' }] };
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman', uid: null });
  const matched = inUseEntries({ loader: makeLoader([entry]), manager: makeManager({ rows }), name: 'dsh-caveman' });
  assert.deepEqual(matched, []);
});

test('nested plugin names are matched when the manager cannot list the rows', () => {
  const nested = makeEntry({ id: 'dsh-caveman/ui', name: 'dsh-caveman' });
  const deepNested = makeEntry({ id: 'x', name: 'dsh-caveman/panel' });
  const sameName = makeEntry({ id: 'entry-7', name: 'dsh-caveman' });
  const unrelated = makeEntry({ id: 'y', name: 'dsh-caveman-tools' });

  const manager = makeManager({ throwFor: ['dsh-caveman'] });
  const matched = inUseEntries({ loader: makeLoader([nested, deepNested, sameName, unrelated]), manager, name: 'dsh-caveman' });
  assert.deepEqual(matched, [nested, deepNested, sameName]);
  assert.equal(matched.includes(unrelated), false);
});

test('a bundle that contributes no plugin rows is not reported as blocked', () => {
  const entry = makeEntry({ id: 'dsh-flat', name: 'dsh-flat' });
  const manager = makeManager({ rows: {} });
  assert.deepEqual(inUseEntries({ loader: makeLoader([entry]), manager, name: 'dsh-flat' }), []);
});

test('no rows and no name match means nothing is reported', () => {
  const entry = makeEntry({ id: 'unrelated', name: 'unrelated' });
  const matched = inUseEntries({ loader: makeLoader([entry]), manager: makeManager({ rows: {} }), name: 'dsh-caveman' });
  assert.deepEqual(matched, []);
});

test('the loader and the manager are optional: a missing service yields no entries', () => {
  assert.deepEqual(inUseEntries({ loader: undefined, manager: undefined, name: 'x' }), []);
  assert.deepEqual(entriesOf(null), []);
  assert.deepEqual(bundleRows(null, 'x'), []);
  assert.deepEqual(bundleRows({ bundleRows: () => { throw new Error('boom'); } }, 'x'), []);
});

test('entries() throwing is tolerated', () => {
  const loader = { entries() { throw new Error('not mounted'); } };
  assert.deepEqual(entriesOf(loader), []);
});

test('describeEntry is JSON safe and carries the source when one is exposed', () => {
  const entry = makeEntry({ id: 'dsh-caveman', name: 'dsh-caveman' });
  const described = describeEntry(entry);
  assert.deepEqual(described, {
    id: 'dsh-caveman',
    name: 'dsh-caveman',
    uid: 1,
    state: 2,
    source: 'file:///profile/node_modules/dsh-caveman/index.js',
  });
  assert.equal(JSON.parse(JSON.stringify(described)).id, 'dsh-caveman');
});

test('summarize names the blocking entries', () => {
  assert.equal(summarize('a', []), 'a：没有存活条目挡着');
  const summary = summarize('dsh-caveman', [makeEntry({ id: 'dsh-caveman' }), makeEntry({ id: 'dsh-caveman/ui', name: 'dsh-caveman' })]);
  assert.match(summary, /2 个存活条目/);
  assert.match(summary, /dsh-caveman, dsh-caveman\/ui/);
});
