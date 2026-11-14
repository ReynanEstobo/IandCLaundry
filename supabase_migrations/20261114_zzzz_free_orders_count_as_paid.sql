-- A loyalty free load can cover a whole order (one service of up to one load,
-- no add-ons), leaving nothing to pay. Such an order stayed "unpaid", and an
-- order can be released only when it is "paid", so the customer's free laundry
-- could never be released: both Release buttons refused it.
--
-- An order with nothing to pay now always counts as paid. Orders with a
-- balance are unchanged. Safe to run more than once.
BEGIN;

CREATE OR REPLACE FUNCTION public.mark_zero_total_orders_paid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.total_price, 0) <= 0 AND COALESCE(NEW.amount_paid, 0) <= 0 THEN
    NEW.payment_status := 'paid';
  END IF;
  RETURN NEW;
END $function$;

REVOKE ALL ON FUNCTION public.mark_zero_total_orders_paid() FROM PUBLIC, anon, authenticated;

-- Named to run after the other checks on orders, so nothing resets it afterwards.
DROP TRIGGER IF EXISTS zz_zero_total_orders_are_paid ON public.orders;
CREATE TRIGGER zz_zero_total_orders_are_paid
BEFORE INSERT OR UPDATE OF total_price, amount_paid, payment_status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.mark_zero_total_orders_paid();

-- Free orders already waiting for release.
UPDATE public.orders SET payment_status = 'paid'
WHERE COALESCE(total_price, 0) <= 0 AND COALESCE(amount_paid, 0) <= 0
  AND payment_status IS DISTINCT FROM 'paid' AND status <> 'cancelled';

COMMIT;
