import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, ConflictError, StorageError, StoreCorruptionError } from '../lib/store.mjs';
import { initializePostgresStorage } from '../lib/postgres-store.mjs';

const id = (namespace, key) => namespace + '\0' + key;
function database() {
  const values = new Map(), calls = [];
  return { values, calls, fail: false,
    async query(text, params = [], options) {
      calls.push({ text, params, options });
      assert.equal(options.arrayMode, false);
      assert.equal(options.fullResults, false);
      assert.ok(options.fetchOptions.signal instanceof AbortSignal);
      if (this.fail) throw new Error('postgresql://private-password@private-host/private-data');
      if (text.startsWith('CREATE TABLE')) return [];
      const [namespace, key, body, etag, prior] = params;
      const entryId = id(namespace, key), current = values.get(entryId);
      if (text.startsWith('SELECT')) return current ? [structuredClone(current)] : [];
      if (text.startsWith('INSERT')) {
        assert.match(text, /ON CONFLICT \(namespace, key\) DO NOTHING RETURNING etag/);
        if (current) return [];
      } else if (text.startsWith('UPDATE')) {
        assert.match(text, /WHERE namespace = \$1 AND key = \$2 AND etag = \$5 RETURNING etag/);
        if (!current || current.etag !== prior) return [];
      } else throw new Error('Unexpected SQL');
      values.set(entryId, { body, etag });
      return [{ etag }];
    },
  };
}
const storeFor = (sql, prefix = 'test/production') => createStore({ mode: 'cloud', storage: 'postgres', postgresSql: sql, prefix });

test('Postgres setup is explicit; creating a cloud store performs no database requests', async () => {
  const sql = database();
  const store = await storeFor(sql);
  assert.equal(store.mode, 'cloud');
  assert.equal(sql.calls.length, 0);
  await initializePostgresStorage({ sql });
  assert.equal(sql.calls.length, 1);
  assert.match(sql.calls[0].text, /CREATE TABLE IF NOT EXISTS public\.work_planner_documents/);
  assert.match(sql.calls[0].text, /PRIMARY KEY \(namespace, key\)/);
  assert.match(sql.calls[0].text, /octet_length\(body\) <= 33554432/);
  await store.read('state', {});
  assert.equal(sql.calls.filter(call => call.text.startsWith('CREATE')).length, 1);
});

test('Postgres requires a configured database, validates namespaces and rejects unknown cloud storage', async () => {
  await assert.rejects(createStore({ mode: 'cloud', storage: 'postgres', databaseUrl: '' }), /WORK_PLANNER_DATABASE_URL/);
  await assert.rejects(storeFor(database(), '../production'), /Invalid private storage prefix/);
  await assert.rejects(storeFor(database(), 'x'.repeat(201)), /Invalid private storage prefix/);
  await assert.rejects(storeFor(database(), "production'; DROP TABLE documents; --"), /Invalid private storage prefix/);
  await assert.rejects(createStore({ mode: 'cloud', storage: 'unknown' }), /Cloud storage must be/);
});

test('missing documents return an independent fallback; only the requested namespace is readable', async () => {
  const sql = database(), production = await storeFor(sql), preview = await storeFor(sql, 'test/preview');
  const fallback = { entries: [] };
  const blank = await production.read('state', fallback);
  assert.deepEqual(blank, { value: fallback, etag: null });
  blank.value.entries.push('draft');
  assert.deepEqual(fallback, { entries: [] });
  const productionETag = await production.write('state', { entries: ['private'] }, null);
  const previewETag = await preview.write('state', { entries: ['preview'] }, null);
  assert.notEqual(productionETag, previewETag);
  assert.deepEqual((await production.read('state')).value, { entries: ['private'] });
  assert.deepEqual((await preview.read('state')).value, { entries: ['preview'] });
});

test('atomic Postgres writes reject create collisions, stale ETags, absent updates and content-restoration races', async () => {
  const sql = database(), store = await storeFor(sql);
  const first = await store.write('state', { count: 1 }, null);
  assert.match(first, /^"[0-9a-f-]{36}"$/);
  await assert.rejects(store.write('state', { count: 2 }, null), ConflictError);
  await assert.rejects(store.write('calendar-cache', {}, first), ConflictError);
  const second = await store.write('state', { count: 2 }, first);
  assert.notEqual(first, second);
  await assert.rejects(store.write('state', { count: 3 }, first), ConflictError);
  const restored = await store.write('state', { count: 1 }, second);
  assert.notEqual(restored, first);
  await assert.rejects(store.write('state', { count: 3 }, first), ConflictError);
  assert.deepEqual(await store.read('state'), { value: { count: 1 }, etag: restored });
});

test('two clients saving the same version have exactly one winner', async () => {
  const sql = database(), first = await storeFor(sql), second = await storeFor(sql);
  const etag = await first.write('state', { count: 0 }, null);
  const results = await Promise.allSettled([
    first.write('state', { count: 1 }, etag),
    second.write('state', { count: 2 }, etag),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason instanceof ConflictError).length, 1);
});

test('shared validation rejects invalid keys, missing write conditions and oversized UTF-8 before querying', async () => {
  const sql = database(), store = await storeFor(sql);
  for (const key of ['../state', 'state.json', '__proto__', '', 'other']) {
    await assert.rejects(store.read(key, {}), /Invalid storage key/);
    await assert.rejects(store.write(key, {}, null), /Invalid storage key/);
  }
  for (const etag of [undefined, '', 0, false]) await assert.rejects(store.write('state', {}, etag), /explicit prior ETag/);
  await assert.rejects(store.write('state', undefined, null), /invalid or too large/);
  await assert.rejects(store.write('state', '字'.repeat(Math.ceil(32 * 1024 * 1024 / 3)), null), /invalid or too large/);
  assert.equal(sql.calls.length, 0);
});

test('descriptions and SQL-looking content are bound parameters and round-trip unchanged', async () => {
  const sql = database(), store = await storeFor(sql);
  const value = { entries: [{ id: 'one', tasks: "شرح کار\nDatenprüfung '); DROP TABLE work_planner_documents; --", date: '2026-09-15' }] };
  await store.write('state', value, null);
  assert.deepEqual((await store.read('state')).value, value);
  const write = sql.calls.find(call => call.text.startsWith('INSERT'));
  assert.equal(write.params[2], JSON.stringify(value, null, 2) + '\n');
  assert.ok(!write.text.includes('Datenprüfung'));
});

test('corrupted or oversized stored data fails closed and updates leave it untouched', async () => {
  const sql = database(), store = await storeFor(sql), key = id('test/production', 'state');
  for (const record of [
    { body: 'broken {', etag: '"corrupt"' },
    { body: '{}', etag: '' },
    { body: null, etag: '"corrupt"' },
    { body: '{}', etag: 'W/"invalid"' },
    { body: ' '.repeat(32 * 1024 * 1024 + 1), etag: '"huge"' },
  ]) {
    sql.values.set(key, record);
    await assert.rejects(store.read('state', { entries: [] }), StoreCorruptionError);
    await assert.rejects(store.update('state', {}, () => ({ overwritten: true })), StoreCorruptionError);
    assert.deepEqual(sql.values.get(key), record);
  }
  assert.equal(sql.calls.filter(call => !call.text.startsWith('SELECT')).length, 0);
});

test('database outages fail closed without leaking private provider errors or retrying writes', async () => {
  const sql = database(), store = await storeFor(sql);
  sql.fail = true;
  const isSafe = error => error instanceof StorageError && !/private-password|private-host|postgresql:/.test(error.message);
  await assert.rejects(store.read('state', {}), isSafe);
  await assert.rejects(store.write('state', {}, null), isSafe);
  await assert.rejects(store.update('state', {}, () => ({})), isSafe);
  await assert.rejects(initializePostgresStorage({ sql }), isSafe);
  assert.equal(sql.calls.length, 4);
  sql.fail = false;
  assert.deepEqual(await store.read('state', {}), { value: {}, etag: null });
});

test('invalid driver responses never become missing records or a successful save', async () => {
  for (const result of [null, {}, [{ body: '{}', etag: '"one"' }, { body: '{}', etag: '"two"' }]]) {
    const store = await storeFor({ query: async () => result });
    await assert.rejects(store.read('state', {}), error => error instanceof StorageError || error instanceof StoreCorruptionError);
    await assert.rejects(store.write('state', {}, null), StorageError);
  }
  const store = await storeFor({ query: async () => [{ etag: '"different-than-written"' }] });
  await assert.rejects(store.write('state', {}, null), StorageError);
});

test('CAS update retries concurrent changes and preserves every successful mutation', async () => {
  const sql = database(), stores = await Promise.all([storeFor(sql), storeFor(sql)]);
  await Promise.all(Array.from({ length: 5 }, (_, index) => stores[index % 2].update('auth-sessions', { count: 0 }, value => ({ count: value.count + 1 }))));
  assert.equal((await stores[0].read('auth-sessions')).value.count, 5);
});

test('an undefined updater makes no write; exhausted conflicts retain the other writer’s record', async () => {
  const sql = database(), store = await storeFor(sql);
  await store.write('state', { count: 1 }, null);
  const before = await store.read('state');
  assert.deepEqual(await store.update('state', {}, value => { value.count = 99; }), before);
  let attempts = 0;
  await assert.rejects(store.update('state', {}, async value => {
    attempts++;
    const current = await store.read('state');
    await store.write('state', { count: current.value.count + 1 }, current.etag);
    return { count: value.count + 10 };
  }, { retries: 1 }), ConflictError);
  assert.equal(attempts, 2);
  assert.equal((await store.read('state')).value.count, 3);
});
