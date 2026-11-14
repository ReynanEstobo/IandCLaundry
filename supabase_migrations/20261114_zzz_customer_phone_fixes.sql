-- Two fixes around customer phone numbers, found by testing many users at once.
--
-- 1. One new customer per phone, even when two orders arrive together.
--    When staff at two branches (or two staff at one branch) entered the same
--    new customer's phone number at the same moment, both looked the phone up,
--    found nobody, and both tried to create the customer. The second order
--    then failed with a database "duplicate key" error. Order creation and
--    customer registration now take a short lock on the phone number first, so
--    the second request waits a moment and attaches to the customer the first
--    one just created.
--
-- 2. The Orders list search also finds customer phone numbers.
--    It matched only order numbers and customer names. Typing at least four
--    digits now also matches the customer's phone, ignoring spaces and dashes.
--
-- Nothing else in these functions changes. Safe to run more than once.
BEGIN;

DO $$
DECLARE
  v_definition TEXT;
  v_order_lookup TEXT := 'SELECT id, email INTO v_customer_id, v_customer_email FROM public.customers';
  v_order_lock TEXT := 'PERFORM pg_advisory_xact_lock(hashtextextended(''customer-phone:'' || regexp_replace(trim(p_customer->>''phone''), ''[^0-9]'', '''', ''g''), 0));';
  v_register_lookup TEXT := 'SELECT * INTO v_customer FROM public.customers';
  v_register_lock TEXT := 'PERFORM pg_advisory_xact_lock(hashtextextended(''customer-phone:'' || regexp_replace(p_phone, ''[^0-9]'', '''', ''g''), 0));';
  v_name_search TEXT := 'OR lower(c.name) LIKE ''%'' || lower(btrim(p_search)) || ''%''';
  v_phone_search TEXT := 'OR (length(regexp_replace(p_search, ''[^0-9]'', '''', ''g'')) >= 4 AND regexp_replace(COALESCE(c.phone, ''''), ''[^0-9]'', '''', ''g'') LIKE ''%'' || regexp_replace(p_search, ''[^0-9]'', '''', ''g'') || ''%'')';
BEGIN
  -- 1. Order creation.
  IF to_regprocedure('public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)'::regprocedure)
    INTO v_definition;
    IF position(v_order_lock IN v_definition) = 0 THEN
      IF position(v_order_lookup IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Stopped: the expected customer lookup in create_branch_order was not found. Nothing was changed.';
      END IF;
      EXECUTE replace(v_definition, v_order_lookup, v_order_lock || E'\n  ' || v_order_lookup);
    END IF;
  END IF;

  -- 1. Customer registration.
  IF to_regprocedure('public.register_branch_customer(uuid,uuid,text,text,text)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.register_branch_customer(uuid,uuid,text,text,text)'::regprocedure)
    INTO v_definition;
    IF position(v_register_lock IN v_definition) = 0 AND position(v_register_lookup IN v_definition) > 0 THEN
      EXECUTE replace(v_definition, v_register_lookup, v_register_lock || E'\n  ' || v_register_lookup);
    END IF;
  END IF;

  -- 2. Orders list search.
  IF to_regprocedure('public.list_orders_page(uuid,text,text,integer,integer)') IS NOT NULL THEN
    SELECT pg_get_functiondef('public.list_orders_page(uuid,text,text,integer,integer)'::regprocedure)
    INTO v_definition;
    IF position(v_phone_search IN v_definition) = 0 THEN
      IF position(v_name_search IN v_definition) = 0 THEN
        RAISE EXCEPTION 'Stopped: the expected name search in list_orders_page was not found. Nothing was changed.';
      END IF;
      EXECUTE replace(v_definition, v_name_search, v_name_search || E'\n        ' || v_phone_search);
    END IF;
  END IF;
END;
$$;

COMMIT;
