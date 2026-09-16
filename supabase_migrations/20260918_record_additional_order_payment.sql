-- Run after 20260917_payment_ledger_reporting.sql.
-- Records an additional collection without overwriting the original payment.
-- The payments ledger stays append-only while orders retain a current summary.
BEGIN;

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
  v_method TEXT := COALESCE(NULLIF(trim(p_payment_method), ''), 'cash');
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Enter a payment amount greater than zero';
  END IF;
  IF v_method NOT IN ('cash', 'gcash', 'bank_transfer', 'card', 'other') THEN
    RAISE EXCEPTION 'Select a valid payment method';
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
  VALUES (v_order.id, ROUND(p_amount, 2), v_method,
    CASE WHEN p_amount >= v_remaining THEN 'paid' ELSE 'partial' END,
    now(), v_staff.id, 'additional_collection');

  SELECT * INTO v_result FROM public.orders WHERE id = v_order.id;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.collect_order_payment(UUID, UUID, NUMERIC, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collect_order_payment(UUID, UUID, NUMERIC, TEXT) TO service_role;

COMMIT;
