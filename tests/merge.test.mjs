import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeEntries} from '../public/merge.mjs';
import {analyze, normalizeState} from '../public/core.mjs';

const row = (id = 'entry-1', changes = {}) => ({
  id, jobId: 'jena', date: '2026-09-15', start: '09:00', end: '12:00',
  endNextDay: false, tasks: 'Activity description', ...changes,
});
const copy = value => structuredClone(value);

test('a stale tab can delete its old draft without losing records migrated remotely', () => {
  const draft = row('draft', {date: '2026-10-08', start: '', end: '', tasks: ''});
  const migrated = [row('jena-hours'), row('seewiesen-hours', {jobId: 'seewiesen', start: '13:00', end: '17:00', tasks: 'Remote work\nشرح فعالیت'})];
  const result = mergeEntries([draft], [], [...migrated, draft]);
  assert.deepEqual(result, {entries: migrated, conflicts: []});
  assert.deepEqual(analyze(result.entries, '2026-09').totals, {jena: 180, seewiesen: 240});
});

test('remote additions retain remote order, followed by independent local additions', () => {
  const b = row('existing'), remoteFirst = row('remote-first'), remoteLast = row('remote-last');
  const localFirst = row('local-first'), localLast = row('local-last');
  assert.deepEqual(mergeEntries([b], [localFirst, b, localLast], [remoteFirst, b, remoteLast]), {
    entries: [remoteFirst, b, remoteLast, localFirst, localLast], conflicts: [],
  });
});

test('deletions of unchanged records and identical concurrent deletions succeed', () => {
  const a = row('a'), b = row('b'), c = row('c'), d = row('d');
  assert.deepEqual(mergeEntries([a, b, c, d], [b, d], [a, d]), {entries: [d], conflicts: []});
});

test('independent edits to descriptions, work identity and time merge without changing hours', () => {
  const b = row(), l = row('entry-1', {tasks: '\nفارسی & English\n分析 😀\tcontinued'});
  const r = row('entry-1', {jobId: 'seewiesen', start: '23:00', end: '02:00', endNextDay: true});
  const result = mergeEntries([b], [l], [r]);
  assert.deepEqual(result, {entries: [{...r, tasks: l.tasks}], conflicts: []});
  assert.deepEqual(analyze(result.entries, '2026-09').totals, {jena: 0, seewiesen: 180});
});

test('unchanged and identical concurrent edits are retained once', () => {
  const a = row('a'), b = row('b'), changed = {...b, tasks: 'Identical update', end: '13:00'};
  assert.deepEqual(mergeEntries([a, b], [a, changed], [a, changed]), {entries: [a, changed], conflicts: []});
});

test('start and end edits on separate sides conflict instead of inventing an interval', () => {
  const b = row(), l = {...b, start: '08:00'}, r = {...b, end: '13:00', tasks: 'Remote description'};
  assert.deepEqual(mergeEntries([b], [l], [r]), {
    entries: [l], conflicts: [{id: b.id, kind: 'edit-edit', fields: ['time'], base: b, local: l, remote: r}],
  });
});

test('date and overnight changes are part of the same atomic time value', () => {
  const b = row(), l = {...b, date: '2026-09-16'}, r = {...b, endNextDay: true};
  const result = mergeEntries([b], [l], [r]);
  assert.deepEqual(result.entries, [l]);
  assert.deepEqual(result.conflicts[0].fields, ['time']);
});

test('different descriptions conflict and retain complete local record for explicit resolution', () => {
  const b = row(), l = {...b, tasks: 'Local activity'}, r = {...b, tasks: 'Remote activity', jobId: 'seewiesen'};
  assert.deepEqual(mergeEntries([b], [l], [r]), {
    entries: [l], conflicts: [{id: b.id, kind: 'edit-edit', fields: ['tasks'], base: b, local: l, remote: r}],
  });
});

test('local deletion versus remote edits conflicts and remains locally absent', () => {
  const b = row(), r = {...b, end: '12:30', tasks: 'Edited remotely'};
  assert.deepEqual(mergeEntries([b], [], [r]), {
    entries: [], conflicts: [{id: b.id, kind: 'delete-edit', fields: ['time', 'tasks'], base: b, local: null, remote: r}],
  });
});

test('local edits versus remote deletion conflict and preserve the complete local record', () => {
  const b = row(), l = {...b, jobId: 'seewiesen', tasks: ''};
  assert.deepEqual(mergeEntries([b], [l], []), {
    entries: [l], conflicts: [{id: b.id, kind: 'edit-delete', fields: ['tasks', 'jobId'], base: b, local: l, remote: null}],
  });
});

test('identical additions with the same ID deduplicate while differing ones conflict', () => {
  const a = row('a'), l = row('b'), r = {...l, jobId: 'seewiesen', start: '08:00', tasks: ''};
  assert.deepEqual(mergeEntries([], [a, l], [a, r]), {
    entries: [a, l], conflicts: [{id: 'b', kind: 'add-add', fields: ['time', 'tasks', 'jobId'], base: null, local: l, remote: r}],
  });
});

test('draft inputs, empty descriptions, Unicode and long descriptions remain exact', () => {
  const drafts = normalizeState({entries: [
    row('partial', {date: '', start: '1', end: '12:', tasks: '\n研究\nفعالیت 🧠\t'}),
    row('blank', {start: '', end: '', tasks: ''}),
    row('long', {tasks: 'د'.repeat(2000)}),
  ]}).entries;
  assert.deepEqual(mergeEntries([], drafts, []), {entries: drafts, conflicts: []});
  assert.deepEqual(mergeEntries(drafts, drafts, drafts), {entries: drafts, conflicts: []});
});

test('inputs are not mutated and output records share no mutable references with inputs', () => {
  const b = row('conflict'), l = {...b, tasks: 'Local'}, r = {...b, tasks: 'Remote'};
  const common = row('unchanged'), localAdd = row('local-add'), remoteAdd = row('remote-add');
  const inputs = [[b, common], [l, common, localAdd], [r, common, remoteAdd]];
  const before = copy(inputs);
  inputs.forEach(rows => {rows.forEach(Object.freeze); Object.freeze(rows);});
  const result = mergeEntries(...inputs);
  assert.deepEqual(inputs, before);
  result.entries.forEach(entry => {entry.tasks = 'Changed output';});
  for (const field of ['base', 'local', 'remote']) result.conflicts[0][field].tasks = 'Changed conflict';
  assert.deepEqual(inputs, before);
});

test('changing a returned entry does not alter the corresponding conflict choices', () => {
  const b = row(), l = {...b, tasks: 'Local'}, r = {...b, tasks: 'Remote'};
  const result = mergeEntries([b], [l], [r]);
  result.entries[0].tasks = 'Output edit';
  assert.equal(result.conflicts[0].local.tasks, 'Local');
});

test('an empty merge has no records or conflicts', () => {
  assert.deepEqual(mergeEntries([], [], []), {entries: [], conflicts: []});
});
