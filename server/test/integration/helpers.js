/**
 * Shared set-up for tests that need a real Postgres.
 *
 * They run only when TEST_DATABASE_URL is set, and skip cleanly otherwise. The
 * database it names is treated as disposable: tests create and drop their own
 * databases next to it, and the HTTP tests truncate its tables.
 */
import pg from 'pg';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
export const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL is not set';

/** The same server and credentials, a different database name. */
export function urlForDatabase(name) {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Create a throwaway database; returns its URL and a drop() function. */
export async function createScratchDatabase(prefix) {
  const name = `${prefix}_${process.pid}_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  return {
    name,
    url: urlForDatabase(name),
    async drop() {
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
}
