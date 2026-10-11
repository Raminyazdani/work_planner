import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../lib/app.mjs';
import {createStore} from '../lib/store.mjs';
import {PlannerSync} from '../public/sync.mjs';
import {analyze} from '../public/core.mjs';

const copy = value => structuredClone(value);
const row = (id, changes = {}) => ({
  id, jobId: 'jena', date: '2030-06-12', start: '09:00', end: '11:30',
  endNextDay: false, tasks: 'Synthetic activity', ...changes,
});

async function setup(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-sync-http-test-'));
  let app, server, origin;
  async function stop() {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (app) await app.close();
    server = app = null;
  }
  async function start() {
    const store = await createStore({mode: 'local', dataDir});
    app = await createApp({
      store, config: {mode: 'local', cloud: false, accessKeyHash: '', dataDir},
      calendarOptions: {autoSync: false, fetch: () => {throw Error('External network forbidden in synthetic tests');}},
    });
    server = http.createServer(app);
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    await fs.rm(dataDir, {recursive: true, force: true});
  });
  await start();
  async function request(route, options = {}) {
    const method = options.method || 'GET';
    return fetch(`${origin}${route}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: {...(!['GET', 'HEAD'].includes(method) ? {Origin: origin, 'Sec-Fetch-Site': 'same-origin'} : {}), ...options.headers},
    });
  }
  const read = async () => {const response = await request('/api/state'); assert.equal(response.status, 200); return response.json();};
  const put = state => request('/api/state', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(state)});
  return {request, read, put, restart: async () => {await stop(); await start();}};
}

function client(state, request) {
  const value = {entries: copy(state.entries), statuses: [], responses: []};
  value.sync = new PlannerSync({
    request: async (route, options) => {
      const response = await request(route, options);
      value.responses.push({method: options?.method || 'GET', status: response.status});
      return response;
    },
    getEntries: () => value.entries,
    setEntries: entries => {value.entries = copy(entries);},
    onStatus: status => value.statuses.push(status),
  });
  value.sync.initialize(state);
  return value;
}

test('real HTTP stale-tab deletion preserves migrated hours and descriptions across a server restart', async t => {
  const service = await setup(t);
  const draft = row('draft', {date: '2030-07-08', start: '', end: '', tasks: ''});
  assert.equal((await service.put({revision: 0, entries: [draft]})).status, 200);
  const baseline = await service.read(), importer = client(baseline, service.request), stale = client(baseline, service.request);
  const migrated = [
    row('imported-jena', {tasks: '\nشرح فعالیت\nSynthetic imported work 😀'}),
    row('imported-seewiesen', {jobId: 'seewiesen', start: '13:00', end: '17:00', tasks: 'Second job\nDetailed activity'}),
  ];
  importer.entries.push(...migrated);
  assert.equal(await importer.sync.save(), true);
  stale.entries = [];
  assert.equal(await stale.sync.save(), true);
  assert.ok(stale.responses.some(response => response.status === 409));
  assert.deepEqual(stale.entries, migrated);
  assert.equal(stale.sync.dirty, false);
  assert.equal(stale.sync.conflicts.length, 0);
  const saved = await service.read();
  assert.deepEqual(saved.entries, migrated);
  assert.deepEqual(analyze(saved.entries, '2030-06').totals, {jena: 150, seewiesen: 240});
  assert.equal(saved.revision, 3);

  // A new app and store instance must recover the exact committed state from disk.
  await service.restart();
  assert.deepEqual(await service.read(), saved);
  const reloaded = client(await service.read(), service.request);
  assert.equal(reloaded.sync.dirty, false);
  assert.equal(await reloaded.sync.save(), true);
  assert.deepEqual(await service.read(), saved);
});

test('two real HTTP clients repeatedly add, edit descriptions and times, and delete without stale-save lockout', async t => {
  const service = await setup(t), initial = await service.read();
  const a = client(initial, service.request), b = client(initial, service.request);
  for (let cycle = 0; cycle < 5; cycle++) {
    const left = row(`left-${cycle}`, {tasks: `Left ${cycle}`});
    const right = row(`right-${cycle}`, {jobId: 'seewiesen', start: '14:00', end: '16:00', tasks: `Right ${cycle}`});
    a.entries.push(left);
    b.entries.push(right);
    assert.deepEqual(await Promise.all([a.sync.save(), b.sync.save()]), [true, true]);
    assert.deepEqual(await Promise.all([a.sync.refresh(), b.sync.refresh()]), [true, true]);
    assert.equal((await service.read()).entries.length, 2);

    const description = `\nCycle ${cycle}\nشرح دقیق فعالیت\t😀`;
    a.entries = a.entries.map(entry => entry.id === right.id ? {...entry, tasks: description} : entry);
    b.entries = b.entries.map(entry => entry.id === right.id ? {...entry, start: '23:00', end: '01:30', endNextDay: true} : entry);
    assert.deepEqual(await Promise.all([a.sync.save(), b.sync.save()]), [true, true]);
    assert.deepEqual(await Promise.all([a.sync.refresh(), b.sync.refresh()]), [true, true]);
    const updated = (await service.read()).entries.find(entry => entry.id === right.id);
    assert.deepEqual(updated, {...right, tasks: description, start: '23:00', end: '01:30', endNextDay: true});
    assert.deepEqual(analyze([updated], '2030-06').totals, {jena: 0, seewiesen: 150});

    a.entries = a.entries.filter(entry => entry.id !== left.id);
    b.entries = b.entries.filter(entry => entry.id !== right.id);
    assert.deepEqual(await Promise.all([a.sync.save(), b.sync.save()]), [true, true]);
    assert.deepEqual(await Promise.all([a.sync.refresh(), b.sync.refresh()]), [true, true]);
    assert.deepEqual((await service.read()).entries, []);
    for (const tab of [a, b]) {
      assert.equal(tab.sync.dirty, false);
      assert.equal(tab.sync.conflicts.length, 0);
      assert.equal(tab.statuses.at(-1).state, 'saved');
    }
  }
  assert.ok([...a.responses, ...b.responses].some(response => response.status === 409));
  assert.equal((await service.read()).revision, 30);
});

test('real HTTP conflicting descriptions require an explicit choice while direct stale PUTs still receive 409', async t => {
  const service = await setup(t), original = row('shared');
  assert.equal((await service.put({revision: 0, entries: [original]})).status, 200);
  const baseline = await service.read(), a = client(baseline, service.request), b = client(baseline, service.request);
  a.entries[0].tasks = 'Activity written in the first tab';
  b.entries[0].tasks = 'فعالیت نوشته‌شده در تب دوم';
  assert.equal(await a.sync.save(), true);
  assert.equal(await b.sync.save(), false);
  assert.equal(b.sync.conflicts.length, 1);
  assert.equal(b.sync.conflicts[0].kind, 'edit-edit');
  assert.equal(b.sync.conflicts[0].local.tasks, b.entries[0].tasks);
  assert.equal(b.sync.conflicts[0].remote.tasks, a.entries[0].tasks);
  const committed = await service.read();
  assert.equal(committed.entries[0].tasks, a.entries[0].tasks);

  const staleWrite = await service.put({revision: baseline.revision, entries: []});
  assert.equal(staleWrite.status, 409);
  assert.deepEqual(await service.read(), committed);

  b.sync.resolve('shared', 'local');
  assert.equal(await b.sync.save(), true);
  assert.equal((await service.read()).entries[0].tasks, b.entries[0].tasks);
  assert.equal(b.sync.conflicts.length, 0);
  assert.equal(b.sync.dirty, false);
  assert.equal(await a.sync.refresh(), true);
  assert.deepEqual(a.entries, b.entries);
});
