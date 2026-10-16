-- Replace the four-digit random order number suffix with a database sequence.
-- Random values can collide whenever many orders are created on one day.
BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.order_number_sequence;

CREATE OR REPLACE FUNCTION public.generate_order_number()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_suffix BIGINT;
BEGIN
  -- Keep a manually supplied number untouched. The existing trigger calls this
  -- function only when order_number is NULL, but this also keeps the function
  -- safe if the trigger is later recreated without that condition.
  IF NEW.order_number IS NOT NULL AND btrim(NEW.order_number) <> '' THEN
    RETURN NEW;
  END IF;

  -- Serialise number allocation briefly so a manual historical import cannot
  -- race this trigger between the existence check and INSERT.
  PERFORM pg_advisory_xact_lock(731882307568459122);
  LOOP
    v_suffix := nextval('public.order_number_sequence');
    NEW.order_number := 'IC-'
      || to_char(now() AT TIME ZONE 'Asia/Manila', 'YYYYMMDD')
      || '-' || lpad(v_suffix::TEXT, 8, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.orders WHERE order_number = NEW.order_number
    );
  END LOOP;
  RETURN NEW;
END;
$$;

COMMIT;
