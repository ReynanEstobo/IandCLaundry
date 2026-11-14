// Dry-run checks for the load-test SQL using an in-memory PostgreSQL (PGlite)
// with the parts of Supabase the scripts rely on stubbed in. Nothing here
// connects to any Supabase project.
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'

export const SUPABASE_STUB = `
  DO $$ BEGIN
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text,
    raw_user_meta_data jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), deleted_at timestamptz);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
    $$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
  DO $$ BEGIN CREATE PUBLICATION supabase_realtime; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
`

export async function stubbedDatabase() {
  const db = new PGlite({ extensions: { uuid_ossp, pg_trgm, pgcrypto } })
  await db.exec(SUPABASE_STUB)
  return db
}

export async function verifySetupSql(files, db = null) {
  const database = db || await stubbedDatabase()
  const results = []
  for (const file of files) {
    try { await database.exec(await readFile(file, 'utf8')); results.push({ file, ok: true }) }
    catch (error) { results.push({ file, ok: false, error: error.message.split('\n')[0] }); break }
  }
  if (!db) await database.close()
  return results
}
