-- Run after 20260923_multi_service_configuration_alignment.sql.
-- Services remain distinct for workflow and stock consumption, while every
-- service item uses the existing Settings bundle/excess/add-on price rule.
BEGIN;

ALTER TABLE public.inventory_items
  ADD COLUMN IF NOT EXISTS is_order_addon BOOLEAN NOT NULL DEFAULT FALSE;

-- Pricing is deliberately centralised in Settings. A service no longer owns a
-- rate or duration: it is a selectable workflow that uses the same customer
-- price calculation as every other service.
UPDATE public.service_types
SET pricing_type = 'bundle',
    unit_price = COALESCE(unit_price, price_per_kg, 0),
    updated_at = now()
WHERE deleted_at IS NULL;

-- The configuration screen now records a fixed amount for a service item.
-- New recipes always use this basis, and existing recipes are normalised so
-- their displayed and applied meaning cannot disagree.
UPDATE public.service_inventory_requirements
SET usage_basis = 'per_order', updated_at = now()
WHERE usage_basis IS DISTINCT FROM 'per_order';

-- Add-ons must be explicitly enabled on the inventory item and must belong to
-- the order's branch. This protects the rule even if a caller bypasses the UI.
CREATE OR REPLACE FUNCTION public.validate_order_addons()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_addon RECORD;
BEGIN
  FOR v_addon IN
    SELECT key AS item_id, value::NUMERIC AS quantity
    FROM jsonb_each_text(COALESCE(NEW.addons, '{}'::JSONB))
  LOOP
    IF v_addon.quantity < 0 THEN
      RAISE EXCEPTION 'Add-on quantities cannot be negative';
    END IF;
    IF v_addon.quantity > 0 AND NOT EXISTS (
      SELECT 1
      FROM public.inventory_items i
      WHERE i.id = v_addon.item_id::UUID
        AND i.branch_id = NEW.branch_id
        AND i.is_order_addon IS TRUE
    ) THEN
      RAISE EXCEPTION 'Each add-on must be enabled for the order branch before it can be used';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_validate_order_addons ON public.orders;
CREATE TRIGGER tr_validate_order_addons
BEFORE INSERT OR UPDATE OF addons, branch_id ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.validate_order_addons();

CREATE OR REPLACE FUNCTION public.create_branch_order(
  p_branch_id UUID, p_staff_id UUID, p_customer JSONB, p_order JSONB,
  p_addons JSONB, p_loads INTEGER, p_loyalty_reward_id UUID DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer_id UUID; v_branch_name TEXT; v_order public.orders; v_service RECORD; v_entry JSONB;
  v_items JSONB; v_resolved JSONB := '[]'::JSONB; v_weight NUMERIC; v_quantity NUMERIC;
  v_subtotal NUMERIC; v_raw_total NUMERIC := 0; v_final_total NUMERIC; v_amount_paid NUMERIC;
  v_addon_units NUMERIC := 0; v_addon_price NUMERIC := 0; v_eta_minutes INTEGER := 0;
  v_eta_source TEXT := 'branch_default_max'; v_item_eta INTEGER; v_item_eta_source TEXT;
  v_first_service UUID; v_total_weight NUMERIC := 0; v_discount NUMERIC := 0;
  v_loyalty_enabled BOOLEAN; v_discount_milestone INTEGER; v_free_load_milestone INTEGER;
  v_discount_percent INTEGER; v_expiry_days INTEGER; v_program_started_at TIMESTAMPTZ;
  v_completed_count INTEGER; v_next_position INTEGER; v_reward_type TEXT; v_reward_id UUID; v_bundle_price NUMERIC;
BEGIN
  IF p_branch_id IS NULL OR p_staff_id IS NULL THEN RAISE EXCEPTION 'A staff branch assignment is required'; END IF;
  SELECT name INTO v_branch_name FROM public.branches WHERE id = p_branch_id;
  IF v_branch_name IS NULL THEN RAISE EXCEPTION 'Selected branch does not exist'; END IF;
  IF COALESCE(trim(p_customer->>'phone'), '') = '' OR COALESCE(trim(p_customer->>'name'), '') = '' THEN
    RAISE EXCEPTION 'Customer name and phone are required';
  END IF;
  v_amount_paid := COALESCE(NULLIF(p_order->>'amount_paid', '')::NUMERIC, 0);
  IF v_amount_paid < 0 THEN RAISE EXCEPTION 'A valid payment amount is required'; END IF;

  SELECT id INTO v_customer_id FROM public.customers
   WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(trim(p_customer->>'phone'), '[^0-9]', '', 'g')
   LIMIT 1 FOR UPDATE;
  IF v_customer_id IS NULL THEN
    INSERT INTO public.customers(name, phone, email, notes, branch, branch_id, created_by_staff_id)
    VALUES (trim(p_customer->>'name'), trim(p_customer->>'phone'), NULLIF(trim(p_customer->>'email'), ''),
      NULLIF(trim(p_customer->>'notes'), ''), v_branch_name, p_branch_id, p_staff_id) RETURNING id INTO v_customer_id;
  END IF;

  v_items := p_order->'items';
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' OR jsonb_array_length(v_items) = 0 THEN
    v_items := jsonb_build_array(jsonb_build_object('service_type_id', p_order->>'service_type_id', 'weight_kg', p_order->>'weight_kg', 'quantity', 1));
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_items) LOOP
    SELECT * INTO v_service FROM public.service_types
      WHERE id = NULLIF(v_entry->>'service_type_id', '')::UUID AND is_active IS TRUE AND deleted_at IS NULL;
    IF v_service.id IS NULL THEN RAISE EXCEPTION 'Choose an active service for every service item'; END IF;
    v_weight := NULLIF(v_entry->>'weight_kg', '')::NUMERIC;
    IF COALESCE(v_weight, 0) <= 0 THEN RAISE EXCEPTION '% requires a weight greater than zero', v_service.name; END IF;
    v_quantity := 1;
    v_subtotal := public.order_item_price('bundle', 0, v_weight, v_quantity);
    v_raw_total := v_raw_total + v_subtotal;
    v_total_weight := v_total_weight + v_weight;
    SELECT minutes, source INTO v_item_eta, v_item_eta_source
    FROM public.estimate_order_processing_minutes(p_branch_id, v_service.id, v_weight);
    v_eta_minutes := GREATEST(v_eta_minutes, COALESCE(v_item_eta, 1));
    IF v_item_eta_source = 'historical_service_branch' THEN v_eta_source := 'historical_service_branch_max'; END IF;
    v_first_service := COALESCE(v_first_service, v_service.id);
    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'service_type_id', v_service.id, 'name', v_service.name, 'pricing_type', 'bundle',
      'processing_type', v_service.processing_type, 'weight_kg', v_weight, 'quantity', v_quantity,
      'unit_price', public.order_item_price('bundle', 0, LEAST(v_weight, COALESCE((SELECT bundlekg FROM public.settings LIMIT 1), 8)), 1),
      'subtotal', v_subtotal, 'notes', NULLIF(trim(v_entry->>'notes'), '')
    ));
  END LOOP;

  SELECT COALESCE(SUM(value::NUMERIC), 0) INTO v_addon_units FROM jsonb_each_text(COALESCE(p_addons, '{}'::JSONB));
  IF v_addon_units < 0 THEN RAISE EXCEPTION 'Add-on quantities cannot be negative'; END IF;
  SELECT COALESCE(addonprice, 0) INTO v_addon_price FROM public.settings LIMIT 1;
  v_raw_total := ROUND(v_raw_total + v_addon_units * v_addon_price, 2);
  v_final_total := v_raw_total;

  IF p_loyalty_reward_id IS NOT NULL THEN RAISE EXCEPTION 'Loyalty rewards are applied automatically to qualifying orders'; END IF;
  SELECT loyalty_enabled, loyalty_discount_milestone, loyalty_free_load_milestone,
    loyalty_discount_percent, loyalty_reward_expiry_days, loyalty_program_started_at, bundleprice
  INTO v_loyalty_enabled, v_discount_milestone, v_free_load_milestone,
    v_discount_percent, v_expiry_days, v_program_started_at, v_bundle_price FROM public.settings LIMIT 1;
  IF COALESCE(v_loyalty_enabled, FALSE) AND NOT EXISTS (
    SELECT 1 FROM public.loyalty_rewards r JOIN public.orders reward_order ON reward_order.id = r.earned_order_id
    WHERE r.customer_id = v_customer_id AND r.status = 'redeemed' AND reward_order.status NOT IN ('released', 'cancelled')
  ) THEN
    SELECT COUNT(*) INTO v_completed_count FROM public.orders
      WHERE customer_id = v_customer_id AND status = 'released' AND payment_status = 'paid'
        AND picked_up_at >= COALESCE(v_program_started_at, '-infinity'::TIMESTAMPTZ);
    v_next_position := (v_completed_count % GREATEST(COALESCE(v_free_load_milestone, 10), 2)) + 1;
    IF v_next_position = v_discount_milestone THEN
      v_reward_type := 'percentage_discount';
      v_final_total := ROUND(v_raw_total * (100 - GREATEST(LEAST(COALESCE(v_discount_percent, 50), 100), 1)) / 100.0, 2);
    ELSIF v_next_position = v_free_load_milestone THEN
      v_reward_type := 'free_load';
      v_final_total := GREATEST(0, v_raw_total - GREATEST(COALESCE(v_bundle_price, 0), 0));
    END IF;
    v_discount := v_raw_total - v_final_total;
  END IF;
  IF v_amount_paid < v_final_total * 0.5 THEN RAISE EXCEPTION 'Minimum 50%% payment required: %', ROUND(v_final_total * 0.5, 2); END IF;

  INSERT INTO public.orders(customer_id, service_type_id, weight_kg, total_price, addons, notes, payment_method,
    payment_status, amount_paid, branch, branch_id, created_by_staff_id, last_updated_by_staff_id, status,
    estimated_processing_minutes, eta_source, estimated_ready_at, loyalty_original_total, loyalty_discount_amount)
  VALUES (v_customer_id, v_first_service, v_total_weight, v_final_total, COALESCE(p_addons, '{}'::JSONB),
    NULLIF(p_order->>'notes', ''), COALESCE(NULLIF(p_order->>'payment_method', ''), 'cash'),
    CASE WHEN v_amount_paid >= v_final_total THEN 'paid' ELSE 'partial' END, v_amount_paid,
    v_branch_name, p_branch_id, p_staff_id, p_staff_id, 'received',
    GREATEST(v_eta_minutes, 1), v_eta_source,
    now() + make_interval(mins => GREATEST(v_eta_minutes, 1)), v_raw_total, v_discount)
  RETURNING * INTO v_order;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_resolved) LOOP
    INSERT INTO public.order_items(order_id, service_type_id, service_name_snapshot, pricing_type_snapshot,
      processing_type_snapshot, weight_kg, quantity, unit_price_snapshot, subtotal, notes, branch_id, last_updated_by_staff_id)
    VALUES (v_order.id, (v_entry->>'service_type_id')::UUID, v_entry->>'name', v_entry->>'pricing_type',
      v_entry->>'processing_type', NULLIF(v_entry->>'weight_kg', '')::NUMERIC,
      (v_entry->>'quantity')::NUMERIC, (v_entry->>'unit_price')::NUMERIC,
      (v_entry->>'subtotal')::NUMERIC, NULLIF(v_entry->>'notes', ''), p_branch_id, p_staff_id);
  END LOOP;
  IF v_reward_type IS NOT NULL THEN
    INSERT INTO public.loyalty_rewards(customer_id, earned_order_id, reward_type, status, discount_percent, free_load_kg, expires_at, redeemed_at, redeemed_order_id)
    VALUES (v_customer_id, v_order.id, v_reward_type, 'redeemed',
      CASE WHEN v_reward_type = 'percentage_discount' THEN v_discount_percent ELSE NULL END,
      CASE WHEN v_reward_type = 'free_load' THEN 8 ELSE NULL END,
      now() + make_interval(days => GREATEST(COALESCE(v_expiry_days, 180), 1)), now(), v_order.id)
    RETURNING id INTO v_reward_id;
    UPDATE public.orders SET loyalty_reward_id = v_reward_id WHERE id = v_order.id;
  END IF;
  INSERT INTO public.customer_branches(customer_id, branch_id, first_served_at, last_served_at, order_count)
  VALUES (v_customer_id, p_branch_id, now(), now(), 1)
  ON CONFLICT (customer_id, branch_id) DO UPDATE SET last_served_at = now(), order_count = public.customer_branches.order_count + 1;
  RETURN v_order;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_branch_order(UUID, UUID, JSONB, JSONB, JSONB, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_branch_order(UUID, UUID, JSONB, JSONB, JSONB, INTEGER, UUID) TO service_role;
COMMIT;
