import { randomUUID } from 'node:crypto';
import { ConflictError, StorageError, StoreCorruptionError } from './store.mjs';

// No runtime request creates or alters tables. Run initializePostgresStorage
// once when provisioning a dedicated database, before switching the backend.
const SCHEMA = `CREATE TABLE IF NOT EXISTS public.work_planner_documents (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL CHECK (octet_length(body) <= 33554432),
  etag TEXT NOT NULL,
  PRIMARY KEY (namespace, key)
)`;

function createQuery({ databaseUrl, sql }) {
  if (!sql && (typeof databaseUrl !== 'string' || !databaseUrl.trim())) {
    throw new StorageError('WORK_PLANNER_DATABASE_URL is required for private Postgres storage.');
  }
  if (sql && typeof sql.query !== 'function') throw new TypeError('A SQL query client is required');
  let clientPromise;
  return async (text, params = []) => {
    try {
      // The driver and connection are initialized only when storage is used.
      // Health checks and build-time imports do not open database connections.
      const client = sql || await (clientPromise ||= import('@neondatabase/serverless').then(({ neon }) => neon(databaseUrl)));
      const rows = await client.query(text, params, {
        arrayMode: false, fullResults: false,
        fetchOptions: { signal: AbortSignal.timeout(20000) },
      });
      if (!Array.isArray(rows)) throw new Error('Unexpected query result');
      return rows;
    } catch {
      // Provider errors can include connection strings, SQL or private bodies.
      // Never expose them or fall back to empty/local data after an outage.
      clientPromise = undefined;
      throw new StorageError();
    }
  };
}

/** Explicit, idempotent schema setup for a newly provisioned private database. */
export async function initializePostgresStorage(options = {}) {
  await createQuery(options)(SCHEMA);
}

/** Low-level text adapter; createStore owns the shared key and JSON validation. */
export function createPostgresAdapter({ databaseUrl, prefix, sql } = {}) {
  if (typeof prefix !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix) || prefix.length > 200) {
    throw new TypeError('Invalid private storage prefix');
  }
  const query = createQuery({ databaseUrl, sql });
  return {
    async read(key) {
      const rows = await query(
        'SELECT body, etag FROM public.work_planner_documents WHERE namespace = $1 AND key = $2',
        [prefix, key],
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      if (rows.length !== 1 || typeof row?.body !== 'string' || typeof row.etag !== 'string' || !row.etag || row.etag.startsWith('W/')) {
        throw new StoreCorruptionError();
      }
      return { text: row.body, etag: row.etag };
    },
    async write(key, text, priorETag) {
      // A new token for every write prevents a stale client from succeeding
      // after another client changes a document and then restores its content.
      const etag = '"' + randomUUID() + '"';
      const rows = priorETag === null
        ? await query(
          `INSERT INTO public.work_planner_documents (namespace, key, body, etag)
           VALUES ($1, $2, $3, $4) ON CONFLICT (namespace, key) DO NOTHING RETURNING etag`,
          [prefix, key, text, etag],
        )
        : await query(
          `UPDATE public.work_planner_documents SET body = $3, etag = $4
           WHERE namespace = $1 AND key = $2 AND etag = $5 RETURNING etag`,
          [prefix, key, text, etag, priorETag],
        );
      if (rows.length === 0) throw new ConflictError();
      if (rows.length !== 1 || rows[0]?.etag !== etag) throw new StorageError();
      return etag;
    },
  };
}
