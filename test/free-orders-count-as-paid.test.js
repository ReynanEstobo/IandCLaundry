import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = () => readFile(new URL('../supabase_migrations/20261114_zzzz_free_orders_count_as_paid.sql', import.meta.url), 'utf8')

test('an order with nothing to pay counts as paid, so a free load can be released', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE public.orders (id serial PRIMARY KEY, status text DEFAULT 'ready', total_price numeric(12,2),
      amount_paid numeric(12,2) DEFAULT 0, payment_status text DEFAULT 'unpaid');
    INSERT INTO public.orders(total_price, amount_paid, payment_status, status) VALUES
      (0, 0, 'unpaid', 'ready'),        -- a free load already waiting before the fix
      (0, 0, 'unpaid', 'cancelled'),    -- cancelled orders are left alone
      (300, 100, 'partial', 'ready');   -- an order with a balance is unchanged
  `)
  await db.exec(await migration())
  await db.exec(await migration())
  const status = async id => (await db.query('SELECT payment_status FROM public.orders WHERE id = $1', [id])).rows[0].payment_status
  assert.equal(await status(1), 'paid')
  assert.equal(await status(2), 'unpaid')
  assert.equal(await status(3), 'partial')

  const { rows } = await db.query(`INSERT INTO public.orders(total_price, amount_paid, payment_status) VALUES (0, 0, 'unpaid') RETURNING id, payment_status`)
  assert.equal(rows[0].payment_status, 'paid', 'a new free order is paid from the start')
  await db.query(`UPDATE public.orders SET payment_status = 'unpaid' WHERE id = $1`, [rows[0].id])
  assert.equal(await status(rows[0].id), 'paid', 'nothing can mark it unpaid again')

  const due = (await db.query(`INSERT INTO public.orders(total_price, amount_paid, payment_status) VALUES (450, 0, 'unpaid') RETURNING payment_status`)).rows[0]
  assert.equal(due.payment_status, 'unpaid', 'orders with a balance still need payment')
})
