-- Remove generic customer/order note fields from the live schema and secure RPCs.
-- Cancellation reasons and stage-correction reasons are deliberately retained
-- because they are mandatory audit records, not optional form notes.

BEGIN;

DROP FUNCTION IF EXISTS public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.register_branch_customer(
  p_branch_id UUID, p_staff_id UUID, p_name TEXT, p_phone TEXT, p_email TEXT
) RETURNS public.customers
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_customer public.customers; v_actor RECORD; v_branch_name TEXT;
BEGIN
  IF COALESCE(trim(p_name), '') = '' OR COALESCE(trim(p_phone), '') = ''
    OR COALESCE(trim(p_email), '') = '' THEN
    RAISE EXCEPTION 'Customer name, phone, and email are required';
  END IF;
  IF trim(p_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
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
    VALUES (trim(p_name), trim(p_phone), lower(trim(p_email)),
      v_branch_name, p_branch_id, p_staff_id)
    RETURNING * INTO v_customer;
  ELSIF COALESCE(trim(v_customer.email), '') = '' THEN
    UPDATE public.customers SET email = lower(trim(p_email))
    WHERE id = v_customer.id RETURNING * INTO v_customer;
  END IF;
  INSERT INTO public.customer_branches(customer_id, branch_id, first_served_at, last_served_at, order_count)
  VALUES (v_customer.id, p_branch_id, now(), now(), 0)
  ON CONFLICT (customer_id, branch_id) DO NOTHING;
  RETURN v_customer;
END $$;

CREATE OR REPLACE FUNCTION public.create_branch_order(
  p_branch_id UUID, p_staff_id UUID, p_customer JSONB, p_order JSONB,
  p_addons JSONB, p_loads INTEGER, p_loyalty_reward_id UUID DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer_id UUID; v_customer_email TEXT; v_branch_name TEXT; v_order public.orders; v_service public.service_types; v_actor RECORD;
  v_entry JSONB; v_items JSONB; v_resolved JSONB := '[]'::JSONB; v_weight NUMERIC;
  v_subtotal NUMERIC; v_raw_total NUMERIC := 0; v_final_total NUMERIC; v_amount_paid NUMERIC;
  v_first_service UUID; v_first_bundle_price NUMERIC := 0; v_total_weight NUMERIC := 0;
  v_eta_minutes INTEGER := 0; v_item_eta INTEGER; v_item_eta_source TEXT; v_eta_source TEXT := 'branch_default_max';
  v_request_id UUID; v_order_item_id UUID; v_load_count INTEGER; v_requirement RECORD; v_addon RECORD; v_stock RECORD; v_required NUMERIC;
  v_loyalty_enabled BOOLEAN; v_discount_milestone INTEGER; v_free_load_milestone INTEGER;
  v_discount_percent INTEGER; v_expiry_days INTEGER; v_program_started_at TIMESTAMPTZ;
  v_completed_count INTEGER; v_next_position INTEGER; v_reward_type TEXT; v_reward_id UUID; v_discount NUMERIC := 0;
BEGIN
  IF p_branch_id IS NULL OR p_staff_id IS NULL THEN RAISE EXCEPTION 'A staff branch assignment is required'; END IF;
  v_request_id := NULLIF(p_order->>'client_request_id', '')::UUID;
  IF v_request_id IS NULL THEN RAISE EXCEPTION 'A unique order request ID is required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_request_id::TEXT, 0));
  SELECT * INTO v_order FROM public.orders WHERE client_request_id = v_request_id;
  IF v_order.id IS NOT NULL THEN
    IF v_order.branch_id IS DISTINCT FROM p_branch_id
      OR v_order.created_by_staff_id IS DISTINCT FROM p_staff_id THEN
      RAISE EXCEPTION 'This order request ID has already been used by another staff account or branch';
    END IF;
    RETURN v_order;
  END IF;

  SELECT name INTO v_branch_name FROM public.branches WHERE id = p_branch_id AND is_active IS TRUE;
  IF v_branch_name IS NULL THEN RAISE EXCEPTION 'Selected branch does not exist or is inactive'; END IF;
  SELECT id, role, branch_id INTO v_actor FROM public.staff
  WHERE id = p_staff_id AND deleted_at IS NULL;
  IF v_actor.id IS NULL THEN RAISE EXCEPTION 'A valid active staff account is required'; END IF;
  IF lower(COALESCE(v_actor.role, 'staff')) <> 'admin'
    AND v_actor.branch_id IS DISTINCT FROM p_branch_id THEN
    RAISE EXCEPTION 'You can only create orders for your assigned branch';
  END IF;
  IF COALESCE(trim(p_customer->>'phone'), '') = '' OR COALESCE(trim(p_customer->>'name'), '') = ''
    OR COALESCE(trim(p_customer->>'email'), '') = '' THEN
    RAISE EXCEPTION 'Customer name, phone, and email are required';
  END IF;
  IF trim(p_customer->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter a valid customer email';
  END IF;
  v_amount_paid := COALESCE(NULLIF(p_order->>'amount_paid', '')::NUMERIC, 0);
  IF v_amount_paid < 0 THEN RAISE EXCEPTION 'A valid payment amount is required'; END IF;
  IF lower(COALESCE(NULLIF(trim(p_order->>'payment_method'), ''), 'cash')) <> 'cash' THEN
    RAISE EXCEPTION 'Cash is the only accepted payment method';
  END IF;

  SELECT id, email INTO v_customer_id, v_customer_email FROM public.customers
  WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(trim(p_customer->>'phone'), '[^0-9]', '', 'g')
  LIMIT 1 FOR UPDATE;
  IF v_customer_id IS NULL THEN
    INSERT INTO public.customers(name, phone, email, branch, branch_id, created_by_staff_id)
    VALUES (trim(p_customer->>'name'), trim(p_customer->>'phone'), NULLIF(trim(p_customer->>'email'), ''),
      v_branch_name, p_branch_id, p_staff_id)
    RETURNING id INTO v_customer_id;
  ELSIF COALESCE(trim(v_customer_email), '') = '' THEN
    UPDATE public.customers SET email = lower(trim(p_customer->>'email'))
    WHERE id = v_customer_id;
  END IF;

  v_items := p_order->'items';
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' OR jsonb_array_length(v_items) = 0 THEN
    RAISE EXCEPTION 'Add at least one service to the order';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_service FROM public.service_types
    WHERE id = NULLIF(v_entry->>'service_type_id', '')::UUID AND is_active IS TRUE AND deleted_at IS NULL;
    IF v_service.id IS NULL THEN RAISE EXCEPTION 'Choose an active service for every service item'; END IF;
    v_weight := NULLIF(v_entry->>'weight_kg', '')::NUMERIC;
    IF COALESCE(v_weight, 0) <= 0 THEN RAISE EXCEPTION '% requires a weight greater than zero', v_service.name; END IF;
    v_load_count := GREATEST(1, CEIL(v_weight / v_service.bundle_kg)::INTEGER);
    v_subtotal := ROUND(v_service.bundle_price + CEIL(GREATEST(v_weight - v_service.bundle_kg, 0)) * v_service.excess_kg_price, 2);
    v_raw_total := v_raw_total + v_subtotal;
    v_total_weight := v_total_weight + v_weight;
    SELECT minutes, source INTO v_item_eta, v_item_eta_source
    FROM public.estimate_order_processing_minutes(p_branch_id, v_service.id, v_weight);
    v_eta_minutes := GREATEST(v_eta_minutes, COALESCE(v_item_eta, 1));
    IF v_item_eta_source = 'historical_service_branch' THEN v_eta_source := 'historical_service_branch_max'; END IF;
    IF v_first_service IS NULL THEN v_first_service := v_service.id; v_first_bundle_price := v_service.bundle_price; END IF;
    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'service_type_id', v_service.id, 'name', v_service.name, 'processing_type', v_service.processing_type,
      'weight_kg', v_weight, 'loads', v_load_count, 'bundle_kg', v_service.bundle_kg,
      'bundle_price', v_service.bundle_price, 'excess_kg_price', v_service.excess_kg_price,
      'subtotal', v_subtotal
    ));
  END LOOP;

  FOR v_addon IN
    SELECT a.id, a.service_type_id, a.inventory_item_id, a.unit_price, i.name, value::NUMERIC AS quantity
    FROM jsonb_each_text(COALESCE(p_addons, '{}'::JSONB)) selected
    JOIN public.service_addon_items a ON a.id = selected.key::UUID
    JOIN public.inventory_items i ON i.id = a.inventory_item_id
    WHERE a.branch_id = p_branch_id AND a.is_active IS TRUE AND i.deleted_at IS NULL
  LOOP
    IF v_addon.quantity <= 0 OR v_addon.quantity <> floor(v_addon.quantity) THEN
      RAISE EXCEPTION 'Add-on quantities must be whole numbers greater than zero';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_resolved) item
      WHERE item->>'service_type_id' = v_addon.service_type_id::TEXT) THEN
      RAISE EXCEPTION 'The selected add-on is not available for a service in this order';
    END IF;
    v_raw_total := v_raw_total + v_addon.quantity * v_addon.unit_price;
  END LOOP;
  IF (SELECT COUNT(*) FROM jsonb_each(COALESCE(p_addons, '{}'::JSONB))) <>
     (SELECT COUNT(*) FROM jsonb_each_text(COALESCE(p_addons, '{}'::JSONB)) selected
      JOIN public.service_addon_items a ON a.id = selected.key::UUID
      JOIN public.inventory_items i ON i.id = a.inventory_item_id
      WHERE a.branch_id = p_branch_id AND a.is_active IS TRUE AND i.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'One or more selected add-ons are unavailable for this branch';
  END IF;
  v_raw_total := ROUND(v_raw_total, 2); v_final_total := v_raw_total;

  IF p_loyalty_reward_id IS NOT NULL THEN RAISE EXCEPTION 'Loyalty rewards are applied automatically to qualifying orders'; END IF;
  SELECT loyalty_enabled, loyalty_discount_milestone, loyalty_free_load_milestone,
    loyalty_discount_percent, loyalty_reward_expiry_days, loyalty_program_started_at
  INTO v_loyalty_enabled, v_discount_milestone, v_free_load_milestone,
    v_discount_percent, v_expiry_days, v_program_started_at FROM public.settings LIMIT 1;
  IF COALESCE(v_loyalty_enabled, FALSE) AND NOT EXISTS (
    SELECT 1 FROM public.loyalty_rewards r JOIN public.orders ro ON ro.id = r.earned_order_id
    WHERE r.customer_id = v_customer_id AND r.status = 'redeemed' AND ro.status NOT IN ('released', 'cancelled')
  ) THEN
    SELECT COUNT(*) INTO v_completed_count FROM public.orders
    WHERE customer_id = v_customer_id AND status = 'released' AND payment_status = 'paid'
      AND picked_up_at >= COALESCE(v_program_started_at, '-infinity'::TIMESTAMPTZ);
    v_next_position := (v_completed_count % GREATEST(COALESCE(v_free_load_milestone, 10), 2)) + 1;
    IF v_next_position = v_discount_milestone THEN
      v_reward_type := 'percentage_discount';
      v_final_total := ROUND(v_raw_total * (100 - GREATEST(LEAST(COALESCE(v_discount_percent, 50), 100), 1)) / 100.0, 2);
    ELSIF v_next_position = v_free_load_milestone THEN
      v_reward_type := 'free_load'; v_final_total := GREATEST(0, v_raw_total - v_first_bundle_price);
    END IF;
    v_discount := v_raw_total - v_final_total;
  END IF;
  IF v_amount_paid < v_final_total * 0.5 THEN RAISE EXCEPTION 'Minimum 50%% payment required: %', ROUND(v_final_total * 0.5, 2); END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_resolved) AS resolved(item)
    JOIN public.service_inventory_requirements r
      ON r.service_type_id = (resolved.item->>'service_type_id')::UUID
     AND r.branch_id = p_branch_id
     AND r.is_active IS TRUE
    LEFT JOIN public.inventory_items i ON i.id = r.inventory_item_id
    WHERE i.id IS NULL OR i.deleted_at IS NOT NULL OR i.branch_id IS DISTINCT FROM p_branch_id
  ) THEN
    RAISE EXCEPTION 'One or more automatic deduction items are unavailable for this branch. Update the service inventory checklist before creating the order.';
  END IF;

  -- Lock every inventory row in a stable order and validate the combined
  -- service-recipe plus add-on requirement. This prevents concurrent orders
  -- from overselling stock and avoids inconsistent lock ordering when the
  -- same inventory item is used by several services or as both recipe/add-on.
  FOR v_stock IN
    SELECT i.id, i.name, i.unit, i.current_stock, required.total_required
    FROM public.inventory_items i
    JOIN (
      SELECT combined.inventory_item_id, SUM(combined.required_quantity) AS total_required
      FROM (
        SELECT r.inventory_item_id,
          r.quantity_per_load * (resolved.item->>'loads')::INTEGER AS required_quantity
        FROM jsonb_array_elements(v_resolved) AS resolved(item)
        JOIN public.service_inventory_requirements r
          ON r.service_type_id = (resolved.item->>'service_type_id')::UUID
         AND r.branch_id = p_branch_id
         AND r.is_active IS TRUE
        UNION ALL
        SELECT a.inventory_item_id, selected.value::NUMERIC AS required_quantity
        FROM jsonb_each_text(COALESCE(p_addons, '{}'::JSONB)) AS selected
        JOIN public.service_addon_items a
          ON a.id = selected.key::UUID
         AND a.branch_id = p_branch_id
         AND a.is_active IS TRUE
      ) combined
      GROUP BY combined.inventory_item_id
    ) required ON required.inventory_item_id = i.id
    WHERE i.branch_id = p_branch_id AND i.deleted_at IS NULL
    ORDER BY i.id
    FOR UPDATE OF i
  LOOP
    IF v_stock.total_required > COALESCE(v_stock.current_stock, 0) THEN
      RAISE EXCEPTION '% has only % % remaining; % % is required for this order',
        v_stock.name, COALESCE(v_stock.current_stock, 0), v_stock.unit,
        v_stock.total_required, v_stock.unit;
    END IF;
  END LOOP;

  INSERT INTO public.orders(customer_id, service_type_id, weight_kg, total_price, addons, payment_method,
    payment_status, amount_paid, branch, branch_id, created_by_staff_id, last_updated_by_staff_id, status,
    estimated_processing_minutes, eta_source, estimated_ready_at, loyalty_original_total,
    loyalty_discount_amount, client_request_id)
  VALUES (v_customer_id, v_first_service, v_total_weight, v_final_total, COALESCE(p_addons, '{}'::JSONB),
    'cash',
    CASE WHEN v_amount_paid >= v_final_total THEN 'paid' ELSE 'partial' END, v_amount_paid,
    v_branch_name, p_branch_id, p_staff_id, p_staff_id, 'received', GREATEST(v_eta_minutes, 1),
    v_eta_source, now() + make_interval(mins => GREATEST(v_eta_minutes, 1)), v_raw_total,
    v_discount, v_request_id)
  RETURNING * INTO v_order;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_resolved) LOOP
    INSERT INTO public.order_items(order_id, branch_id, service_type_id, service_name_snapshot, pricing_type_snapshot,
      bundle_kg_snapshot, bundle_price_snapshot, excess_kg_price_snapshot, processing_type_snapshot,
      weight_kg, quantity, loads, unit_price_snapshot, subtotal, last_updated_by_staff_id)
    VALUES (v_order.id, p_branch_id, (v_entry->>'service_type_id')::UUID, v_entry->>'name', 'bundle',
      (v_entry->>'bundle_kg')::NUMERIC, (v_entry->>'bundle_price')::NUMERIC,
      (v_entry->>'excess_kg_price')::NUMERIC, v_entry->>'processing_type',
      (v_entry->>'weight_kg')::NUMERIC, 1, (v_entry->>'loads')::INTEGER,
      (v_entry->>'bundle_price')::NUMERIC, (v_entry->>'subtotal')::NUMERIC,
      p_staff_id)
    RETURNING id INTO v_order_item_id;

    FOR v_requirement IN
      SELECT r.*, i.name, i.unit, i.current_stock FROM public.service_inventory_requirements r
      JOIN public.inventory_items i ON i.id = r.inventory_item_id
      WHERE r.branch_id = p_branch_id AND r.service_type_id = (v_entry->>'service_type_id')::UUID
        AND r.is_active IS TRUE AND i.deleted_at IS NULL FOR UPDATE OF i
    LOOP
      v_required := v_requirement.quantity_per_load * (v_entry->>'loads')::INTEGER;
      IF v_required > v_requirement.current_stock THEN
        RAISE EXCEPTION '% has only % % remaining; % % is required for %',
          v_requirement.name, v_requirement.current_stock, v_requirement.unit,
          v_required, v_requirement.unit, v_entry->>'name';
      END IF;
      UPDATE public.inventory_items SET current_stock = current_stock - v_required
      WHERE id = v_requirement.inventory_item_id;
      INSERT INTO public.inventory_usage_log(item_id, quantity_used, order_id, order_item_id,
        service_inventory_requirement_id, deduction_key, reason)
      VALUES (v_requirement.inventory_item_id, v_required, v_order.id, v_order_item_id,
        v_requirement.id, 'request:' || v_request_id || ':item:' || v_order_item_id || ':recipe:' || v_requirement.id,
        'Automatic service consumption');
    END LOOP;
  END LOOP;

  FOR v_addon IN
    SELECT a.id, a.service_type_id, a.inventory_item_id, a.unit_price,
      i.name, i.unit, i.current_stock, value::NUMERIC AS quantity
    FROM jsonb_each_text(COALESCE(p_addons, '{}'::JSONB)) selected
    JOIN public.service_addon_items a ON a.id = selected.key::UUID
    JOIN public.inventory_items i ON i.id = a.inventory_item_id
    WHERE a.branch_id = p_branch_id AND a.is_active IS TRUE FOR UPDATE OF i
  LOOP
    SELECT id INTO v_order_item_id FROM public.order_items
    WHERE order_id = v_order.id AND service_type_id = v_addon.service_type_id ORDER BY created_at LIMIT 1;
    IF v_addon.quantity > v_addon.current_stock THEN
      RAISE EXCEPTION '% has only % % remaining; % % is required',
        v_addon.name, v_addon.current_stock, v_addon.unit, v_addon.quantity, v_addon.unit;
    END IF;
    UPDATE public.inventory_items SET current_stock = current_stock - v_addon.quantity
    WHERE id = v_addon.inventory_item_id;
    INSERT INTO public.order_item_addons(order_item_id, branch_id, service_addon_item_id, inventory_item_id,
      item_name_snapshot, quantity, unit_price_snapshot, subtotal)
    VALUES (v_order_item_id, p_branch_id, v_addon.id, v_addon.inventory_item_id, v_addon.name,
      v_addon.quantity, v_addon.unit_price, v_addon.quantity * v_addon.unit_price);
    INSERT INTO public.inventory_usage_log(item_id, quantity_used, order_id, order_item_id,
      deduction_key, reason)
    VALUES (v_addon.inventory_item_id, v_addon.quantity, v_order.id, v_order_item_id,
      'request:' || v_request_id || ':addon:' || v_addon.id, 'Order add-on consumption');
  END LOOP;

  IF v_reward_type IS NOT NULL THEN
    INSERT INTO public.loyalty_rewards(customer_id, earned_order_id, reward_type, status,
      discount_percent, free_load_kg, expires_at, redeemed_at, redeemed_order_id)
    VALUES (v_customer_id, v_order.id, v_reward_type, 'redeemed',
      CASE WHEN v_reward_type = 'percentage_discount' THEN v_discount_percent ELSE NULL END,
      CASE WHEN v_reward_type = 'free_load' THEN (v_resolved->0->>'bundle_kg')::NUMERIC ELSE NULL END,
      now() + make_interval(days => GREATEST(COALESCE(v_expiry_days, 180), 1)), now(), v_order.id)
    RETURNING id INTO v_reward_id;
    UPDATE public.orders SET loyalty_reward_id = v_reward_id WHERE id = v_order.id;
  END IF;
  INSERT INTO public.customer_branches(customer_id, branch_id, first_served_at, last_served_at, order_count)
  VALUES (v_customer_id, p_branch_id, now(), now(), 1)
  ON CONFLICT (customer_id, branch_id) DO UPDATE
  SET last_served_at = now(), order_count = public.customer_branches.order_count + 1;
  RETURN v_order;
END $$;

REVOKE EXECUTE ON FUNCTION public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-- Historical audit JSON is intentionally left unchanged. Audit entries are
-- append-only evidence of what existed when an action occurred; they are not
-- active form fields or schema columns.

ALTER TABLE IF EXISTS public.order_items DROP COLUMN IF EXISTS notes;
ALTER TABLE IF EXISTS public.payments DROP COLUMN IF EXISTS notes;
ALTER TABLE IF EXISTS public.orders DROP COLUMN IF EXISTS notes;
ALTER TABLE IF EXISTS public.customers DROP COLUMN IF EXISTS notes;

COMMIT;

