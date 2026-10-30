import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const read = path => readFile(new URL(path, import.meta.url), 'utf8')

const ORIGINAL_POLICIES = [
  'Authenticated full access',
  'Public read orders for tracking',
  'Public read customers for tracking',
  'Public read service_types for tracking',
]

// A Supabase project grants anon and authenticated their own privileges on
// everything created in public, on top of PostgreSQL's PUBLIC defaults. The
// database here reproduces those grants so the test checks the privileges
// production really has.
async function supabaseLikeDatabase() {
  const db = new PGlite()
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE sql STABLE
      AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
  `)
  const schema = (await read('../supabase_schema.sql')).replace(
    'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
    () => 'CREATE FUNCTION uuid_generate_v4() RETURNS UUID LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;',
  )
  await db.exec(schema)
  // Tables later migrations created without row-level security, and an
  // operation function revoked only from PUBLIC, as the order RPCs were.
  await db.exec(`
    CREATE TABLE public.branches (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL);
    CREATE TABLE public.payments (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), amount NUMERIC(10,2) NOT NULL);
    CREATE TABLE public.settings (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), bundleprice NUMERIC DEFAULT 200);
    CREATE TABLE public.counters (id SERIAL PRIMARY KEY);
    CREATE FUNCTION public.record_operation(p_staff_id UUID) RETURNS TEXT
      LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$ SELECT 'recorded' $$;
    REVOKE EXECUTE ON FUNCTION public.record_operation(UUID) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.record_operation(UUID) TO service_role;
    INSERT INTO public.customers (name, phone) VALUES ('Juan Dela Cruz', '09171234567');
    INSERT INTO public.settings DEFAULT VALUES;
  `)
  return db
}

async function as(db, role, sql, params) {
  await db.exec(`SET ROLE ${role}`)
  try {
    return await db.query(sql, params)
  } finally {
    await db.exec('RESET ROLE')
  }
}

const denied = error => /permission denied/i.test(error.message)

test('public API roles reach the database before the lock-down migration', async t => {
  const db = await supabaseLikeDatabase()
  t.after(() => db.close())
  // These are the exposures the migration closes.
  assert.equal((await as(db, 'anon', 'SELECT name, phone FROM public.customers')).rows.length, 1)
  await as(db, 'anon', 'INSERT INTO public.payments (amount) VALUES (999)')
  assert.equal((await as(db, 'anon', "SELECT public.record_operation(gen_random_uuid()) AS result")).rows[0].result, 'recorded')
})

test('lock-down migration removes every anon and authenticated path and keeps service_role working', async t => {
  const db = await supabaseLikeDatabase()
  t.after(() => db.close())
  const migration = await read('../supabase_migrations/20261030_lock_down_public_api.sql')
  await db.exec(migration)
  await db.exec(migration) // Safe to rerun.

  const { rows: policies } = await db.query(
    "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND policyname = ANY($1)",
    [ORIGINAL_POLICIES],
  )
  assert.deepEqual(policies, [])

  const { rows: withoutRls } = await db.query(`
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity`)
  assert.deepEqual(withoutRls, [])

  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(as(db, role, 'SELECT name, phone FROM public.customers'), denied)
    await assert.rejects(as(db, role, 'SELECT order_number FROM public.orders'), denied)
    await assert.rejects(as(db, role, 'INSERT INTO public.payments (amount) VALUES (999)'), denied)
    await assert.rejects(as(db, role, 'UPDATE public.settings SET bundleprice = 1'), denied)
    await assert.rejects(as(db, role, 'DELETE FROM public.branches'), denied)
    await assert.rejects(as(db, role, "SELECT nextval('public.counters_id_seq')"), denied)
    await assert.rejects(as(db, role, 'SELECT public.record_operation(gen_random_uuid())'), denied)
  }

  // The Worker's own role still reads, writes, fires triggers and calls functions.
  assert.equal((await as(db, 'service_role', 'SELECT name FROM public.customers')).rows.length, 1)
  const { rows: [order] } = await as(db, 'service_role',
    'INSERT INTO public.orders (weight_kg) VALUES (8) RETURNING order_number')
  assert.match(order.order_number, /^IC-\d{8}-\d{4}$/)
  await as(db, 'service_role', 'UPDATE public.orders SET weight_kg = 9')
  await as(db, 'service_role', 'INSERT INTO public.payments (amount) VALUES (200)')
  await as(db, 'service_role', 'INSERT INTO public.counters DEFAULT VALUES')
  assert.equal((await as(db, 'service_role', 'SELECT public.record_operation(gen_random_uuid()) AS result')).rows[0].result, 'recorded')

  // Objects created by later migrations are not granted to the public API roles.
  await db.exec(`
    CREATE TABLE public.later_table (id INTEGER);
    CREATE FUNCTION public.later_function() RETURNS INTEGER LANGUAGE sql AS $$ SELECT 1 $$;
    REVOKE ALL ON FUNCTION public.later_function() FROM PUBLIC, anon, authenticated;
  `)
  const { rows: [later] } = await db.query(`SELECT
    has_table_privilege('anon', 'public.later_table', 'SELECT') AS anon_table,
    has_table_privilege('authenticated', 'public.later_table', 'INSERT') AS authenticated_table,
    has_table_privilege('service_role', 'public.later_table', 'SELECT') AS service_table,
    has_function_privilege('anon', 'public.later_function()', 'EXECUTE') AS anon_function,
    has_function_privilege('service_role', 'public.later_function()', 'EXECUTE') AS service_function`)
  assert.deepEqual(later, {
    anon_table: false, authenticated_table: false, service_table: true,
    anon_function: false, service_function: true,
  })
})
