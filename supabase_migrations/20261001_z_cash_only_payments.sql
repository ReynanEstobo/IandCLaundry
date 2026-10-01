-- Restrict every new payment to cash while preserving historical ledger rows.
-- Run after 20261001_remove_note_fields.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.enforce_cash_payment_method()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.payment_method := lower(COALESCE(NULLIF(trim(NEW.payment_method), ''), 'cash'));
  IF NEW.payment_method <> 'cash' THEN
    RAISE EXCEPTION 'Cash is the only accepted payment method';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_orders_cash_payment_only ON public.orders;
CREATE TRIGGER tr_orders_cash_payment_only
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.enforce_cash_payment_method();

DROP TRIGGER IF EXISTS tr_payments_cash_payment_only ON public.payments;
CREATE TRIGGER tr_payments_cash_payment_only
BEFORE INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.enforce_cash_payment_method();

CREATE OR REPLACE FUNCTION public.collect_order_payment(
  p_order_id UUID,
  p_staff_id UUID,
  p_amount NUMERIC,
  p_payment_method TEXT DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order public.orders;
  v_staff public.staff;
  v_result public.orders;
  v_remaining NUMERIC(12,2);
  v_method TEXT := lower(COALESCE(NULLIF(trim(p_payment_method), ''), 'cash'));
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a payment amount greater than zero';
  END IF;
  IF v_method <> 'cash' THEN
    RAISE EXCEPTION 'Cash is the only accepted payment method';
  END IF;

  SELECT * INTO v_staff FROM public.staff
  WHERE id = p_staff_id AND deleted_at IS NULL FOR UPDATE;
  IF v_staff.id IS NULL THEN
    RAISE EXCEPTION 'An active staff account is required to collect payment';
  END IF;

  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.status IN ('released', 'cancelled') THEN
    RAISE EXCEPTION 'Payments cannot be added to released or cancelled orders';
  END IF;
  IF lower(COALESCE(v_staff.role, 'staff')) <> 'admin'
     AND v_staff.branch_id IS DISTINCT FROM v_order.branch_id THEN
    RAISE EXCEPTION 'You can only collect payment for orders assigned to your branch';
  END IF;

  v_remaining := GREATEST(COALESCE(v_order.total_price, 0) - COALESCE(v_order.amount_paid, 0), 0);
  IF p_amount > v_remaining THEN
    RAISE EXCEPTION 'Payment exceeds the remaining balance of %', ROUND(v_remaining, 2);
  END IF;

  INSERT INTO public.payments(order_id, amount, payment_method, payment_status, paid_at,
    received_by_staff_id, source)
  VALUES (v_order.id, ROUND(p_amount, 2), 'cash',
    CASE WHEN p_amount >= v_remaining THEN 'paid' ELSE 'partial' END,
    now(), v_staff.id, 'additional_collection');

  SELECT * INTO v_result FROM public.orders WHERE id = v_order.id;
  RETURN v_result;
END $$;

CREATE OR REPLACE FUNCTION public.settle_and_release_order(p_order_id UUID, p_staff_id UUID)
RETURNS public.orders LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order public.orders; v_result public.orders; v_balance NUMERIC(12,2);
BEGIN
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.status <> 'ready' THEN RAISE EXCEPTION 'Only ready-for-pickup orders can be released'; END IF;
  v_balance := GREATEST(COALESCE(v_order.total_price, 0) - COALESCE(v_order.amount_paid, 0), 0);
  IF v_balance > 0 THEN
    INSERT INTO public.payments(order_id, amount, payment_method, payment_status, paid_at,
      received_by_staff_id, source)
    VALUES (v_order.id, v_balance, 'cash', 'paid', now(), p_staff_id, 'release_collection');
  END IF;
  SELECT * INTO v_result FROM public.transition_branch_order(p_order_id, p_staff_id, 'released', NULL);
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.collect_order_payment(UUID, UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collect_order_payment(UUID, UUID, NUMERIC, TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.settle_and_release_order(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.settle_and_release_order(UUID, UUID) TO service_role;

COMMIT;
