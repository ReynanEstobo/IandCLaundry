import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const MIGRATION = 'supabase_migrations/20261114_zzz_customer_phone_fixes.sql'

test('the migration patches text that exists in the real order, registration and search functions', async () => {
  const migration = await read(MIGRATION)
  const orderSource = await read('supabase_migrations/20261001_remove_note_fields.sql')
  const searchSource = await read('supabase_migrations/20261010_paginated_order_queue.sql')
  const files = (await readdir(new URL('../supabase_migrations/', import.meta.url))).filter(file => file.endsWith('.sql'))
  const registerSources = await Promise.all(files.map(file => read(`supabase_migrations/${file}`)))
  assert.ok(orderSource.includes('SELECT id, email INTO v_customer_id, v_customer_email FROM public.customers'))
  assert.ok(searchSource.includes("OR lower(c.name) LIKE '%' || lower(btrim(p_search)) || '%'"))
  assert.ok(registerSources.some(source => source.includes('FUNCTION public.register_branch_customer') && source.includes('SELECT * INTO v_customer FROM public.customers')))
  assert.match(migration, /v_order_lookup TEXT := 'SELECT id, email INTO v_customer_id, v_customer_email FROM public\.customers'/)
})

async function databaseWithOrdersAndSearch(t) {
  const db = new PGlite({ extensions: { pg_trgm } })
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE public.customers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, phone text, email text, deleted_at timestamptz);
    CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_number text, status text DEFAULT 'received',
      branch_id uuid, customer_id uuid, priority_order int DEFAULT 0, created_at timestamptz DEFAULT now());
    CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_id uuid, created_at timestamptz DEFAULT now());
    CREATE TABLE public.order_item_addons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), order_item_id uuid, created_at timestamptz DEFAULT now());
    -- Same customer lookup as the real create_branch_order, reduced to the customer step.
    CREATE FUNCTION public.create_branch_order(p_branch_id uuid, p_staff_id uuid, p_customer jsonb, p_order jsonb, p_addons jsonb, p_loads integer, p_loyalty_reward_id uuid)
    RETURNS uuid LANGUAGE plpgsql AS $fn$
    DECLARE v_customer_id UUID; v_customer_email TEXT;
    BEGIN
      SELECT id, email INTO v_customer_id, v_customer_email FROM public.customers
      WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(trim(p_customer->>'phone'), '[^0-9]', '', 'g') AND deleted_at IS NULL
      LIMIT 1 FOR UPDATE;
      IF v_customer_id IS NULL THEN
        INSERT INTO public.customers(name, phone) VALUES (p_customer->>'name', p_customer->>'phone') RETURNING id INTO v_customer_id;
      END IF;
      RETURN v_customer_id;
    END $fn$;
  `)
  await db.exec(await read('supabase_migrations/20261010_paginated_order_queue.sql'))
  await db.exec(`
    INSERT INTO public.customers(id, name, phone) VALUES
      ('00000000-0000-0000-0000-000000000001', 'Maria Santos', '09171234567'),
      ('00000000-0000-0000-0000-000000000002', 'Jose Rizal', '0918-765-4321');
    INSERT INTO public.orders(order_number, customer_id) VALUES
      ('IC-20261114-00000001', '00000000-0000-0000-0000-000000000001'),
      ('IC-20261114-00000002', '00000000-0000-0000-0000-000000000002');
  `)
  return db
}
const search = async (db, text) => (await db.query(`SELECT public.list_orders_page(NULL, NULL, $1, 10, 0) AS page`, [text])).rows[0].page.data.map(order => order.order_number)

test('the Orders list search finds customer phone numbers, with or without spaces and dashes', async t => {
  const db = await databaseWithOrdersAndSearch(t)
  assert.deepEqual(await search(db, '0917 123'), [], 'before the fix a phone number finds nothing')

  const migration = await read(MIGRATION)
  await db.exec(migration)
  await db.exec(migration)

  assert.deepEqual(await search(db, '0917 123'), ['IC-20261114-00000001'])
  assert.deepEqual(await search(db, '09187654321'), ['IC-20261114-00000002'], 'a stored phone with dashes still matches')
  assert.deepEqual(await search(db, '4321'), ['IC-20261114-00000002'])
  assert.deepEqual((await search(db, '123')).length, 0, 'fewer than four digits do not search phones')
  assert.deepEqual(await search(db, 'maria'), ['IC-20261114-00000001'])
  assert.deepEqual(await search(db, '00000002'), ['IC-20261114-00000002'])
  const definition = (await db.query(`SELECT pg_get_functiondef('public.list_orders_page(uuid,text,text,integer,integer)'::regprocedure) AS d`)).rows[0].d
  assert.equal(definition.split('regexp_replace(COALESCE(c.phone').length - 1, 1, 'running the migration twice adds the phone search once')
})

test('order creation locks the phone number before looking the customer up, once, and still works', async t => {
  const db = await databaseWithOrdersAndSearch(t)
  const migration = await read(MIGRATION)
  await db.exec(migration)
  await db.exec(migration)
  const definition = (await db.query(`SELECT pg_get_functiondef('public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)'::regprocedure) AS d`)).rows[0].d
  assert.equal(definition.split("hashtextextended('customer-phone:'").length - 1, 1)
  assert.ok(definition.indexOf('pg_advisory_xact_lock') < definition.indexOf('SELECT id, email INTO v_customer_id'))
  const order = (phone, name) => db.query(`SELECT public.create_branch_order(NULL, NULL, $1::jsonb, '{}'::jsonb, '{}'::jsonb, 0, NULL) AS id`, [JSON.stringify({ name, phone })])
  const first = (await order('09991234567', 'New Customer')).rows[0].id
  const again = (await order('0999-123-4567', 'New Customer')).rows[0].id
  assert.equal(first, again, 'the same phone reaches the same customer')
})
