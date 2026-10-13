import {initializePostgresStorage} from '../lib/postgres-store.mjs';

try {
  const databaseUrl=process.env.WORK_PLANNER_DATABASE_URL||process.env.DATABASE_URL;
  if(!databaseUrl)throw Error('missing configuration');
  await initializePostgresStorage({databaseUrl});
  console.log('Database schema ready. Existing documents were preserved; no planner data was imported.');
} catch {
  console.error('Database setup failed. Check the server-only DATABASE_URL and database availability.');
  process.exitCode=1;
}
