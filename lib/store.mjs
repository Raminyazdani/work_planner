import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const KEYS = new Set(['state', 'calendar-settings', 'calendar-cache', 'calendar-snapshot', 'auth-rate-limits', 'auth-sessions']);
const MAX_BYTES = 32 * 1024 * 1024;
const queues = new Map();

export class ConflictError extends Error {
  constructor() { super('The saved data changed. Reload before saving again.'); this.name = 'ConflictError'; }
}
export class StoreCorruptionError extends Error {
  constructor() { super('Stored data is unreadable. It has not been replaced. Restore a valid backup.'); this.name = 'StoreCorruptionError'; }
}
export class StorageError extends Error {
  constructor(message = 'Private storage is unavailable. No local fallback was used.') { super(message); this.name = 'StorageError'; }
}
function checkKey(key) { if (!KEYS.has(key)) throw new TypeError('Invalid storage key'); }
function checkETag(etag) { if (etag !== null && (typeof etag !== 'string' || !etag)) throw new TypeError('An explicit prior ETag or null is required'); }
function encode(value) {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) throw new TypeError('Stored value is invalid or too large');
  const text = serialized + '\n';
  if (Buffer.byteLength(text) > MAX_BYTES) throw new TypeError('Stored value is invalid or too large');
  return text;
}
function decode(text) {
  try { if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(); return JSON.parse(text); }
  catch { throw new StoreCorruptionError(); }
}
function digest(text) { return '"' + createHash('sha256').update(text).digest('hex') + '"'; }

/** JSON persistence with mandatory compare-and-swap writes. No data is stored in public files. */
export async function createStore({
  mode = 'local', dataDir = process.env.WORK_PLANNER_DATA_DIR || path.resolve('.data'),
  blobToken = process.env.BLOB_READ_WRITE_TOKEN, prefix = 'work-planner', blobSdk,
  lockTimeoutMs = 10000,
} = {}) {
  let read, write, localUpdate;
  if (mode === 'local') {
    const dir = path.resolve(dataDir);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filename = key => path.join(dir, key + '.json');
    async function readLocal(key, fallback) {
      checkKey(key);
      let text;
      try {
        const stat = await fs.stat(filename(key));
        if (stat.size > MAX_BYTES) throw new StoreCorruptionError();
        text = await fs.readFile(filename(key), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return { value: structuredClone(fallback), etag: null };
        throw error;
      }
      return { value: decode(text), etag: digest(text) };
    }
    async function withLock(key, task) {
      checkKey(key);
      const file = filename(key), previous = queues.get(file) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        const lock = file + '.lock';
        const deadline = Date.now() + lockTimeoutMs;
        let handle;
        while (!handle) {
          try { handle = await fs.open(lock, 'wx', 0o600); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (Date.now() >= deadline) throw new StorageError('Local storage is locked by another process. If all planner processes have stopped, remove the stale .lock file and retry.');
            await delay(25);
          }
        }
        try { await handle.writeFile(String(process.pid)); return await task(); }
        finally { await handle.close(); await fs.unlink(lock); }
      });
      queues.set(file, operation);
      try { return await operation; }
      finally { if (queues.get(file) === operation) queues.delete(file); }
    }
    async function replaceLocal(key, value, etag) {
      checkETag(etag);
      const current = await readLocal(key, null);
      if (current.etag !== etag) throw new ConflictError();
      const text = encode(value), temp = filename(key) + '.' + randomUUID() + '.tmp';
      let handle;
      try {
        handle = await fs.open(temp, 'wx', 0o600);
        await handle.writeFile(text, 'utf8'); await handle.sync(); await handle.close(); handle = null;
        await fs.rename(temp, filename(key));
      } finally {
        if (handle) await handle.close();
        await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      return digest(text);
    }
    read = readLocal;
    write = (key, value, etag) => withLock(key, () => replaceLocal(key, value, etag));
    localUpdate = (key, fallback, mutate) => withLock(key, async () => {
      const current = await readLocal(key, fallback);
      const value = await mutate(structuredClone(current.value));
      if (value === undefined) return current;
      const etag = await replaceLocal(key, value, current.etag);
      return { value, etag };
    });
  } else if (mode === 'cloud' || mode === 'blob') {
    if (!blobToken || typeof blobToken !== 'string') throw new StorageError('BLOB_READ_WRITE_TOKEN is required for private cloud storage.');
    if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix) || prefix.length > 200) throw new TypeError('Invalid private storage prefix');
    const sdk = blobSdk || await import('@vercel/blob');
    const pathname = key => { checkKey(key); return `${prefix}/${key}.json`; };
    read = async (key, fallback) => {
      const name = pathname(key);
      let result;
      // Brotli/gzip responses have weak representation ETags (W/...), which
      // Blob correctly rejects for conditional writes. Read the untransformed
      // bytes so the ETag identifies the stored object used by ifMatch.
      try { result = await sdk.get(name, { access: 'private', token: blobToken, useCache: false, headers: {'accept-encoding': 'identity'}, abortSignal: AbortSignal.timeout(20000) }); }
      catch { throw new StorageError(); }
      if (result === null) return { value: structuredClone(fallback), etag: null };
      if (result?.statusCode !== 200 || !result.stream || typeof result.blob?.etag !== 'string' || !result.blob.etag || result.blob.etag.startsWith('W/')) {
        await result?.stream?.cancel().catch(() => {});
        throw new StorageError();
      }
      if (result.blob.size > MAX_BYTES) { await result.stream.cancel().catch(() => {}); throw new StoreCorruptionError(); }
      let bytes = 0; const chunks = [];
      try {
        for await (const chunk of result.stream) {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) throw new StoreCorruptionError();
          chunks.push(Buffer.from(chunk));
        }
      } catch (error) { if (error instanceof StoreCorruptionError) throw error; throw new StorageError(); }
      return { value: decode(Buffer.concat(chunks).toString('utf8')), etag: result.blob.etag };
    };
    write = async (key, value, etag) => {
      const name = pathname(key); checkETag(etag); const text = encode(value);
      try {
        const result = await sdk.put(name, text, {
          access: 'private', token: blobToken, addRandomSuffix: false,
          allowOverwrite: etag !== null, ...(etag === null ? {} : { ifMatch: etag }),
          contentType: 'application/json', cacheControlMaxAge: 60,
          abortSignal: AbortSignal.timeout(20000),
        });
        if (!result?.etag) throw new StorageError();
        return result.etag;
      } catch (error) {
        if ((sdk.BlobPreconditionFailedError && error instanceof sdk.BlobPreconditionFailedError) ||
            // SDK 2.8 uses BlobError for create-only collisions; it has no AlreadyExists subclass.
            (etag === null && sdk.BlobError && error instanceof sdk.BlobError && /already exists/i.test(error.message))) throw new ConflictError();
        throw new StorageError();
      }
    };
  } else throw new TypeError('Storage mode must be local or cloud');

  async function update(key, fallback, mutate, { retries = 5 } = {}) {
    if (typeof mutate !== 'function') throw new TypeError('A mutation function is required');
    if (localUpdate) return localUpdate(key, fallback, mutate);
    for (let attempt = 0; ; attempt++) {
      const current = await read(key, fallback);
      const value = await mutate(structuredClone(current.value));
      if (value === undefined) return current;
      try { return { value, etag: await write(key, value, current.etag) }; }
      catch (error) {
        if (!(error instanceof ConflictError) || attempt >= retries) throw error;
        await delay(Math.min(20 * (attempt + 1), 100));
      }
    }
  }
  return { mode, read, write, update };
}
