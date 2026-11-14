import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

// The ledger tables and triggers as they were before the fix
// (from 20260917_payment_ledger_reporting.sql), reduced to the columns they use.
const LEDGER_BEFORE_FIX = `
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE public.orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), seq serial, total_price numeric(12,2), amount_paid numeric(12,2) DEFAULT 0,
    payment_status text, payment_method text DEFAULT 'cash', created_by_staff_id uuid, last_updated_by_staff_id uuid);
  CREATE TABLE public.payments (id serial PRIMARY KEY, order_id uuid, amount numeric(12,2), payment_method text,
    payment_status text, payment_date timestamptz, paid_at timestamptz, received_by_staff_id uuid, source text);
  CREATE FUNCTION public.record_order_payment() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_previous_paid NUMERIC(12,2) := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.amount_paid, 0) END;
  BEGIN
    IF current_setting('app.payment_ledger_sync', true) = 'true' THEN RETURN NEW; END IF;
    IF COALESCE(NEW.amount_paid, 0) > v_previous_paid THEN
      INSERT INTO public.payments(order_id, amount, payment_method, payment_status, payment_date, paid_at, received_by_staff_id, source)
      VALUES (NEW.id, NEW.amount_paid - v_previous_paid, COALESCE(NEW.payment_method, 'cash'),
        CASE WHEN NEW.amount_paid >= NEW.total_price THEN 'paid' ELSE 'partial' END,
        now(), now(), COALESCE(NEW.last_updated_by_staff_id, NEW.created_by_staff_id), 'order_summary_sync');
    ELSIF COALESCE(NEW.amount_paid, 0) < v_previous_paid THEN
      RAISE EXCEPTION 'Order payment totals cannot be reduced.';
    END IF;
    RETURN NEW;
  END $$;
  CREATE FUNCTION public.refresh_order_payment_summary() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_order_id UUID := COALESCE(NEW.order_id, OLD.order_id); v_total NUMERIC(12,2); v_price NUMERIC(12,2);
  BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO v_total FROM public.payments WHERE order_id = v_order_id;
    SELECT total_price INTO v_price FROM public.orders WHERE id = v_order_id FOR UPDATE;
    PERFORM set_config('app.payment_ledger_sync', 'true', true);
    UPDATE public.orders SET amount_paid = v_total,
      payment_status = CASE WHEN v_total <= 0 THEN 'unpaid' WHEN v_total >= v_price THEN 'paid' ELSE 'partial' END
    WHERE id = v_order_id AND amount_paid IS DISTINCT FROM v_total;
    RETURN COALESCE(NEW, OLD);
  END $$;
  CREATE TRIGGER tr_record_order_payment AFTER INSERT OR UPDATE OF amount_paid ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.record_order_payment();
  CREATE TRIGGER tr_refresh_order_payment_summary AFTER INSERT ON public.payments
    FOR EACH ROW EXECUTE FUNCTION public.refresh_order_payment_summary();`

// Three paid orders created in one transaction, as a seed script or batch would.
const THREE_ORDERS_IN_ONE_TRANSACTION = `
  BEGIN;
  INSERT INTO public.orders(total_price, amount_paid, payment_status) VALUES (300, 300, 'paid');
  INSERT INTO public.orders(total_price, amount_paid, payment_status) VALUES (200, 75, 'partial');
  INSERT INTO public.orders(total_price, amount_paid, payment_status) VALUES (450, 450, 'paid');
  COMMIT;`

async function ledger(db) {
  const { rows } = await db.query(`SELECT o.id, o.amount_paid::float AS paid, COALESCE(sum(p.amount), 0)::float AS ledger
    FROM public.orders o LEFT JOIN public.payments p ON p.order_id = o.id GROUP BY o.id ORDER BY o.seq`)
  return rows.map(row => [row.paid, row.ledger])
}

test('every order created in one transaction records its own payment', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(LEDGER_BEFORE_FIX)

  await db.exec(THREE_ORDERS_IN_ONE_TRANSACTION)
  assert.deepEqual(await ledger(db), [[300, 300], [75, 0], [450, 0]], 'before the fix only the first payment is recorded')

  await db.exec('TRUNCATE public.orders, public.payments RESTART IDENTITY')
  await db.exec(await readFile(new URL('../supabase_migrations/20261114_zz_payment_ledger_per_order.sql', import.meta.url), 'utf8'))
  await db.exec(THREE_ORDERS_IN_ONE_TRANSACTION)
  assert.deepEqual(await ledger(db), [[300, 300], [75, 75], [450, 450]])

  // A later balance payment still updates the order once, without a duplicate ledger row.
  await db.exec(`BEGIN; INSERT INTO public.payments(order_id, amount, payment_method, payment_status, source) SELECT id, 125, 'cash', 'paid', 'additional_collection' FROM public.orders WHERE seq = 2; COMMIT;`)
  const { rows } = await db.query(`SELECT amount_paid::float AS paid, payment_status, (SELECT count(*)::int FROM public.payments p WHERE p.order_id = o.id) AS entries FROM public.orders o WHERE o.seq = 2`)
  assert.deepEqual(rows[0], { paid: 200, payment_status: 'paid', entries: 2 })
})
