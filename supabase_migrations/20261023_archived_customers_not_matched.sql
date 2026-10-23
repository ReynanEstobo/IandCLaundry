-- Archived customers are no longer matched when an order is created.
-- Entering an archived customer's phone number on a new order now registers a
-- new customer instead of reusing the archived record, which keeps its own
-- order history in the Recycle Bin. Phone numbers stay unique among active
-- customers. Pricing, loyalty, inventory and payment rules in the order RPC
-- are unchanged; only its customer lookup gains the archived filter.
BEGIN;

DROP INDEX IF EXISTS public.customers_normalized_phone_unique;
CREATE UNIQUE INDEX IF NOT EXISTS customers_active_phone_unique
ON public.customers ((regexp_replace(phone, '[^0-9]', '', 'g')))
WHERE deleted_at IS NULL;

DO $$
DECLARE
  v_definition TEXT;
  v_order_lookup TEXT := '= regexp_replace(trim(p_customer->>''phone''), ''[^0-9]'', '''', ''g'')';
  v_register_lookup TEXT := '= regexp_replace(p_phone, ''[^0-9]'', '''', ''g'')';
  v_active_only TEXT := ' AND deleted_at IS NULL';
BEGIN
  SELECT pg_get_functiondef('public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)'::regprocedure)
  INTO v_definition;
  IF v_definition IS NULL OR position(v_order_lookup IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Archived customer migration stopped because the expected create_branch_order customer lookup was not found.';
  END IF;
  IF position(v_order_lookup || v_active_only IN v_definition) = 0 THEN
    EXECUTE replace(v_definition, v_order_lookup, v_order_lookup || v_active_only);
  END IF;

  IF to_regprocedure('public.register_branch_customer(uuid,uuid,text,text,text)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.register_branch_customer(uuid,uuid,text,text,text)'::regprocedure)
    INTO v_definition;
    IF position(v_register_lookup IN v_definition) > 0
      AND position(v_register_lookup || v_active_only IN v_definition) = 0 THEN
      EXECUTE replace(v_definition, v_register_lookup, v_register_lookup || v_active_only);
    END IF;
  END IF;
END;
$$;

COMMIT;
