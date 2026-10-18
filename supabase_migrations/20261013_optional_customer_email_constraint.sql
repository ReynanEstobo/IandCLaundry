-- Run after 20261012_optional_order_email_and_payment_followup.sql.
-- The previous RPC change left the older required-email table constraint active.
BEGIN;

ALTER TABLE public.customers ALTER COLUMN email DROP NOT NULL;
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_email_format_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_email_format_check
  CHECK (email IS NULL OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') NOT VALID;

-- All customer write paths store an absent email consistently as NULL.
CREATE OR REPLACE FUNCTION public.normalize_customer_optional_email()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.email := NULLIF(lower(btrim(NEW.email)), '');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tr_normalize_customer_optional_email ON public.customers;
CREATE TRIGGER tr_normalize_customer_optional_email
BEFORE INSERT OR UPDATE OF email ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.normalize_customer_optional_email();

COMMIT;
