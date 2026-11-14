-- Every order now records its own payment-ledger entry, even when several
-- orders are created in one database transaction.
--
-- refresh_order_payment_summary turns on app.payment_ledger_sync while it
-- updates an order's paid total, so record_order_payment does not record that
-- update as a second payment. The setting was never turned off again, so for
-- the rest of the transaction record_order_payment skipped every later order's
-- payment. The app creates one order per request, so day-to-day use was not
-- affected, but a script that created several paid orders at once recorded a
-- payment for the first order only. The setting is now restored after the
-- update.
--
-- Safe to run more than once.
BEGIN;

CREATE OR REPLACE FUNCTION public.refresh_order_payment_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order_id UUID := COALESCE(NEW.order_id, OLD.order_id);
  v_total NUMERIC(12,2);
  v_price NUMERIC(12,2);
  v_previous_sync TEXT := COALESCE(current_setting('app.payment_ledger_sync', true), '');
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
  -- Turn the setting back off so later orders in this transaction still record their payments.
  PERFORM set_config('app.payment_ledger_sync', v_previous_sync, true);
  RETURN COALESCE(NEW, OLD);
END $function$;

REVOKE ALL ON FUNCTION public.refresh_order_payment_summary() FROM PUBLIC, anon, authenticated;

COMMIT;
