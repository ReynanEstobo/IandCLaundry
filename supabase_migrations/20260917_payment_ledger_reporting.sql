-- Run after 20260916_strict_validation_and_audit_trail.sql.
-- Makes the existing payments table the authoritative, append-only cash
-- ledger. Orders retain amount_paid/payment_status as fast summary fields.
BEGIN;

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS public.payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  payment_status TEXT NOT NULL DEFAULT 'paid',
  payment_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS branch TEXT,
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES public.branches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS received_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'payment_ledger',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Older payment rows only have payment_date. Preserve their original timing.
UPDATE public.payments SET paid_at = COALESCE(paid_at, payment_date, created_at, now()) WHERE paid_at IS NULL;
ALTER TABLE public.payments ALTER COLUMN paid_at SET NOT NULL;
UPDATE public.payments p SET branch = o.branch, branch_id = o.branch_id
FROM public.orders o WHERE o.id = p.order_id AND p.branch_id IS NULL;

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_positive_amount_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_positive_amount_check CHECK (amount > 0) NOT VALID;
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_method_check
  CHECK (payment_method IN ('cash', 'gcash', 'bank_transfer', 'card', 'other')) NOT VALID;

-- Stamp every payment from its order so staff scope and branch reporting do
-- not depend on user-supplied values.
CREATE OR REPLACE FUNCTION public.stamp_payment_ledger_fields()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  SELECT branch, branch_id INTO NEW.branch, NEW.branch_id FROM public.orders WHERE id = NEW.order_id;
  IF NEW.branch_id IS NULL THEN RAISE EXCEPTION 'Payment order does not have a branch'; END IF;
  NEW.paid_at := COALESCE(NEW.paid_at, NEW.payment_date, now());
  NEW.payment_date := COALESCE(NEW.payment_date, NEW.paid_at);
  NEW.amount := ROUND(NEW.amount, 2);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tr_stamp_payment_ledger_fields ON public.payments;
CREATE TRIGGER tr_stamp_payment_ledger_fields
BEFORE INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION public.stamp_payment_ledger_fields();

-- Backfill only any amount not already represented by an existing ledger row.
-- The historical date is the best available operational timestamp and is
-- explicitly labelled as a backfill source.
INSERT INTO public.payments(order_id, amount, payment_method, payment_status, payment_date, paid_at,
  received_by_staff_id, source)
SELECT o.id,
       ROUND(o.amount_paid - COALESCE(existing.total_paid, 0), 2),
       COALESCE(o.payment_method, 'cash'),
       CASE WHEN o.amount_paid >= o.total_price THEN 'paid' ELSE 'partial' END,
       COALESCE(o.picked_up_at, o.updated_at, o.created_at, now()),
       COALESCE(o.picked_up_at, o.updated_at, o.created_at, now()),
       COALESCE(o.last_updated_by_staff_id, o.created_by_staff_id),
       'legacy_backfill'
FROM public.orders o
LEFT JOIN (
  SELECT order_id, SUM(amount) AS total_paid FROM public.payments GROUP BY order_id
) existing ON existing.order_id = o.id
WHERE o.status <> 'cancelled'
  AND o.amount_paid > COALESCE(existing.total_paid, 0);

CREATE INDEX IF NOT EXISTS idx_payments_branch_paid_at ON public.payments(branch_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_paid_at ON public.payments(paid_at DESC);

-- An order summary can be changed only by appending a payment. This supports
-- deposits and final collections while keeping every collection traceable.
CREATE OR REPLACE FUNCTION public.record_order_payment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_previous_paid NUMERIC(12,2) := CASE WHEN TG_OP = 'INSERT' THEN 0 ELSE COALESCE(OLD.amount_paid, 0) END;
BEGIN
  IF current_setting('app.payment_ledger_sync', true) = 'true' THEN RETURN NEW; END IF;
  IF COALESCE(NEW.amount_paid, 0) > v_previous_paid THEN
    INSERT INTO public.payments(order_id, amount, payment_method, payment_status, payment_date, paid_at,
      received_by_staff_id, source)
    VALUES (NEW.id, NEW.amount_paid - v_previous_paid, COALESCE(NEW.payment_method, 'cash'),
      CASE WHEN NEW.amount_paid >= NEW.total_price THEN 'paid' ELSE 'partial' END,
      now(), now(), COALESCE(NEW.last_updated_by_staff_id, NEW.created_by_staff_id), 'order_summary_sync');
  ELSIF COALESCE(NEW.amount_paid, 0) < v_previous_paid THEN
    RAISE EXCEPTION 'Order payment totals cannot be reduced. Record a separate approved refund workflow.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tr_record_order_payment ON public.orders;
CREATE TRIGGER tr_record_order_payment
AFTER INSERT OR UPDATE OF amount_paid ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.record_order_payment();

CREATE OR REPLACE FUNCTION public.refresh_order_payment_summary()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order_id UUID := COALESCE(NEW.order_id, OLD.order_id); v_total NUMERIC(12,2); v_price NUMERIC(12,2);
BEGIN
  SELECT COALESCE(SUM(amount), 0) INTO v_total FROM public.payments WHERE order_id = v_order_id;
  SELECT total_price INTO v_price FROM public.orders WHERE id = v_order_id FOR UPDATE;
  PERFORM set_config('app.payment_ledger_sync', 'true', true);
  UPDATE public.orders SET amount_paid = v_total,
    payment_status = CASE WHEN v_total <= 0 THEN 'unpaid' WHEN v_total >= v_price THEN 'paid' ELSE 'partial' END,
    last_updated_by_staff_id = COALESCE(NEW.received_by_staff_id, last_updated_by_staff_id)
  WHERE id = v_order_id
    AND (amount_paid IS DISTINCT FROM v_total
      OR payment_status IS DISTINCT FROM CASE WHEN v_total <= 0 THEN 'unpaid' WHEN v_total >= v_price THEN 'paid' ELSE 'partial' END);
  RETURN COALESCE(NEW, OLD);
END $$;
DROP TRIGGER IF EXISTS tr_refresh_order_payment_summary ON public.payments;
CREATE TRIGGER tr_refresh_order_payment_summary
AFTER INSERT ON public.payments FOR EACH ROW EXECUTE FUNCTION public.refresh_order_payment_summary();

CREATE OR REPLACE FUNCTION public.prevent_payment_ledger_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'Payment ledger entries are append-only. Use an approved refund workflow for corrections.'; END $$;
DROP TRIGGER IF EXISTS tr_payments_append_only ON public.payments;
CREATE TRIGGER tr_payments_append_only BEFORE UPDATE OR DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.prevent_payment_ledger_mutation();

-- Collect any remaining balance and release in one transaction. No browser can
-- alter payment totals directly.
CREATE OR REPLACE FUNCTION public.settle_and_release_order(p_order_id UUID, p_staff_id UUID)
RETURNS public.orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order public.orders; v_result public.orders; v_balance NUMERIC(12,2);
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.status <> 'ready' THEN RAISE EXCEPTION 'Only ready-for-pickup orders can be released'; END IF;
  v_balance := GREATEST(COALESCE(v_order.total_price, 0) - COALESCE(v_order.amount_paid, 0), 0);
  IF v_balance > 0 THEN
    INSERT INTO public.payments(order_id, amount, payment_method, payment_status, paid_at, received_by_staff_id, source)
    VALUES (v_order.id, v_balance, COALESCE(v_order.payment_method, 'cash'), 'paid', now(), p_staff_id, 'release_collection');
  END IF;
  SELECT * INTO v_result FROM public.transition_branch_order(p_order_id, p_staff_id, 'released', NULL);
  RETURN v_result;
END $$;
REVOKE EXECUTE ON FUNCTION public.settle_and_release_order(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_and_release_order(UUID, UUID) TO service_role;

COMMIT;
