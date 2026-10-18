-- Allow orders to be created without an email or an initial payment.
-- The existing pricing, loyalty, inventory, payment-ledger, and release rules
-- remain in the current order RPC; only its email and deposit requirements are
-- adjusted here.
BEGIN;

CREATE OR REPLACE FUNCTION public.register_branch_customer(
  p_branch_id UUID, p_staff_id UUID, p_name TEXT, p_phone TEXT, p_email TEXT
) RETURNS public.customers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer public.customers; v_actor RECORD; v_branch_name TEXT;
BEGIN
  IF COALESCE(trim(p_name), '') = '' OR COALESCE(trim(p_phone), '') = '' THEN
    RAISE EXCEPTION 'Customer name and phone are required';
  END IF;
  IF NULLIF(trim(p_email), '') IS NOT NULL
    AND trim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter a valid customer email';
  END IF;
  SELECT id, role, branch_id INTO v_actor FROM public.staff
  WHERE id = p_staff_id AND deleted_at IS NULL;
  IF v_actor.id IS NULL THEN RAISE EXCEPTION 'A valid active staff account is required'; END IF;
  IF lower(COALESCE(v_actor.role, 'staff')) <> 'admin'
    AND v_actor.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'You can only register customers for your assigned branch';
  END IF;
  SELECT name INTO v_branch_name FROM public.branches
  WHERE id = p_branch_id AND is_active IS TRUE;
  IF v_branch_name IS NULL THEN RAISE EXCEPTION 'Selected branch does not exist or is inactive'; END IF;

  SELECT * INTO v_customer FROM public.customers
  WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(p_phone, '[^0-9]', '', 'g')
  LIMIT 1 FOR UPDATE;
  IF v_customer.id IS NULL THEN
    INSERT INTO public.customers(name, phone, email, branch, branch_id, created_by_staff_id)
    VALUES (trim(p_name), trim(p_phone), NULLIF(lower(trim(p_email)), ''),
      v_branch_name, p_branch_id, p_staff_id)
    RETURNING * INTO v_customer;
  ELSIF COALESCE(trim(v_customer.email), '') = '' AND NULLIF(trim(p_email), '') IS NOT NULL THEN
    UPDATE public.customers SET email = lower(trim(p_email))
    WHERE id = v_customer.id RETURNING * INTO v_customer;
  END IF;
  INSERT INTO public.customer_branches(customer_id, branch_id, first_served_at, last_served_at, order_count)
  VALUES (v_customer.id, p_branch_id, now(), now(), 0)
  ON CONFLICT (customer_id, branch_id) DO NOTHING;
  RETURN v_customer;
END $$;

DO $$
DECLARE
  v_definition TEXT;
  v_required_email TEXT := ' OR COALESCE(trim(p_customer->>''email''), '''') = ''''';
  v_email_check TEXT := 'IF trim(p_customer->>''email'') !~ ''^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'' THEN';
  v_missing_email_update TEXT := 'ELSIF COALESCE(trim(v_customer_email), '''') = '''' THEN';
  v_minimum_payment TEXT := 'IF v_amount_paid < v_final_total * 0.5 THEN RAISE EXCEPTION ''Minimum 50%% payment required: %'', ROUND(v_final_total * 0.5, 2); END IF;';
  v_payment_status TEXT := 'CASE WHEN v_amount_paid >= v_final_total THEN ''paid'' ELSE ''partial'' END';
BEGIN
  SELECT pg_get_functiondef('public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)'::regprocedure)
  INTO v_definition;

  IF v_definition IS NULL
    OR position(v_required_email IN v_definition) = 0
    OR position(v_email_check IN v_definition) = 0
    OR position(v_missing_email_update IN v_definition) = 0
    OR position(v_minimum_payment IN v_definition) = 0
    OR position(v_payment_status IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Order payment/email migration stopped because the expected current create_branch_order definition was not found.';
  END IF;

  v_definition := replace(v_definition, v_required_email, '');
  v_definition := replace(v_definition,
    'Customer name, phone, and email are required',
    'Customer name and phone are required');
  v_definition := replace(v_definition, v_email_check,
    'IF NULLIF(trim(p_customer->>''email''), '''') IS NOT NULL AND trim(p_customer->>''email'') !~ ''^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'' THEN');
  v_definition := replace(v_definition, v_missing_email_update,
    'ELSIF COALESCE(trim(v_customer_email), '''') = '''' AND NULLIF(trim(p_customer->>''email''), '''') IS NOT NULL THEN');
  v_definition := replace(v_definition, v_minimum_payment, '');
  v_definition := replace(v_definition, v_payment_status,
    'CASE WHEN v_amount_paid <= 0 THEN ''unpaid'' WHEN v_amount_paid >= v_final_total THEN ''paid'' ELSE ''partial'' END');

  EXECUTE v_definition;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
