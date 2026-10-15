-- Prevent a newly written or changed payment from exceeding its final total.
-- Legacy rows are not scanned or blocked from unrelated status updates.
BEGIN;

CREATE OR REPLACE FUNCTION public.reject_order_overpayment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.amount_paid IS DISTINCT FROM OLD.amount_paid
     OR NEW.total_price IS DISTINCT FROM OLD.total_price THEN
    IF COALESCE(NEW.amount_paid, 0) > COALESCE(NEW.total_price, 0) THEN
      RAISE EXCEPTION 'Payment cannot be greater than the full order total.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_reject_order_overpayment ON public.orders;
CREATE TRIGGER tr_reject_order_overpayment
BEFORE INSERT OR UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.reject_order_overpayment();

COMMIT;
