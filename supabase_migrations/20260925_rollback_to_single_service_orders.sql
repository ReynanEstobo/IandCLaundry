-- Run after the multi-service migrations to restore the original
-- one-service-per-order workflow. Existing payment, ETA, loyalty, audit,
-- cancellation, and branch-isolation features are retained.
BEGIN;

-- Item-level records cannot be represented by the old orders table. Stop
-- before deleting anything if a real multi-service order has been created.
DO $$
DECLARE
  v_has_multi_service_orders BOOLEAN := FALSE;
BEGIN
  IF to_regclass('public.order_items') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (
      SELECT 1 FROM public.order_items WHERE pricing_type_snapshot <> ''legacy''
    )' INTO v_has_multi_service_orders;
  END IF;
  IF v_has_multi_service_orders THEN
    RAISE EXCEPTION
      'Single-service rollback blocked: multi-service orders exist. Preserve or remove those test orders before running this migration.';
  END IF;
END $$;

DROP TRIGGER IF EXISTS tr_cancel_order_service_items ON public.orders;
DROP TRIGGER IF EXISTS tr_prevent_multi_service_stage_rollback ON public.orders;
DROP TRIGGER IF EXISTS tr_validate_order_addons ON public.orders;
DROP FUNCTION IF EXISTS public.cancel_order_service_items();
DROP FUNCTION IF EXISTS public.prevent_multi_service_stage_rollback();
DROP FUNCTION IF EXISTS public.validate_order_addons();
DROP FUNCTION IF EXISTS public.transition_all_order_items(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.transition_order_item(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.order_item_price(TEXT, NUMERIC, NUMERIC, NUMERIC);

ALTER TABLE public.inventory_usage_log
  DROP COLUMN IF EXISTS service_inventory_requirement_id,
  DROP COLUMN IF EXISTS order_item_id,
  DROP COLUMN IF EXISTS deduction_key,
  DROP COLUMN IF EXISTS reason;
DROP INDEX IF EXISTS public.inventory_usage_log_deduction_key_unique;
DROP INDEX IF EXISTS public.idx_inventory_usage_order_item;

DROP TABLE IF EXISTS public.service_addon_items;
DROP FUNCTION IF EXISTS public.validate_service_addon_item();
DROP TABLE IF EXISTS public.service_inventory_requirements;
DROP FUNCTION IF EXISTS public.validate_service_inventory_requirement();
DROP TABLE IF EXISTS public.order_items;

ALTER TABLE public.inventory_items DROP COLUMN IF EXISTS is_order_addon;

ALTER TABLE public.service_types
  DROP CONSTRAINT IF EXISTS service_types_bundle_kg_check,
  DROP CONSTRAINT IF EXISTS service_types_bundle_price_check,
  DROP CONSTRAINT IF EXISTS service_types_excess_kg_price_check,
  DROP CONSTRAINT IF EXISTS service_types_pricing_type_check,
  DROP CONSTRAINT IF EXISTS service_types_processing_type_check,
  DROP CONSTRAINT IF EXISTS service_types_unit_price_check;
ALTER TABLE public.service_types
  DROP COLUMN IF EXISTS bundle_kg,
  DROP COLUMN IF EXISTS bundle_price,
  DROP COLUMN IF EXISTS excess_kg_price,
  DROP COLUMN IF EXISTS pricing_type,
  DROP COLUMN IF EXISTS unit_price,
  DROP COLUMN IF EXISTS processing_type,
  DROP COLUMN IF EXISTS updated_at;

-- Restore the last single-service creation procedure. Customer pricing comes
-- from Settings and stock usage is usage_per_load x calculated loads, plus
-- the selected branch inventory add-ons.
CREATE OR REPLACE FUNCTION public.create_branch_order(
  p_branch_id UUID, p_staff_id UUID, p_customer JSONB, p_order JSONB,
  p_addons JSONB, p_loads INTEGER, p_loyalty_reward_id UUID DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer_id UUID; v_branch_name TEXT; v_item RECORD; v_required NUMERIC(10,4); v_order public.orders;
  v_eta_minutes INTEGER; v_eta_source TEXT; v_reward_id UUID;
  v_weight NUMERIC; v_amount_paid NUMERIC; v_bundle_kg NUMERIC; v_bundle_price NUMERIC;
  v_excess_price NUMERIC; v_addon_price NUMERIC; v_raw_total NUMERIC; v_final_total NUMERIC; v_loads INTEGER;
  v_addon_units NUMERIC; v_discount NUMERIC := 0;
  v_loyalty_enabled BOOLEAN; v_discount_milestone INTEGER; v_free_load_milestone INTEGER;
  v_discount_percent INTEGER; v_expiry_days INTEGER; v_program_started_at TIMESTAMPTZ;
  v_completed_count INTEGER; v_next_position INTEGER; v_reward_type TEXT;
BEGIN
  IF p_branch_id IS NULL OR p_staff_id IS NULL THEN RAISE EXCEPTION 'A staff branch assignment is required'; END IF;
  SELECT name INTO v_branch_name FROM public.branches WHERE id = p_branch_id;
  IF v_branch_name IS NULL THEN RAISE EXCEPTION 'Selected branch does not exist'; END IF;
  IF COALESCE(trim(p_customer->>'phone'), '') = '' OR COALESCE(trim(p_customer->>'name'), '') = '' THEN RAISE EXCEPTION 'Customer name and phone are required'; END IF;
  v_weight := NULLIF(p_order->>'weight_kg', '')::NUMERIC;
  v_amount_paid := COALESCE(NULLIF(p_order->>'amount_paid', '')::NUMERIC, 0);
  IF v_weight IS NULL OR v_weight <= 0 OR v_amount_paid < 0 THEN RAISE EXCEPTION 'A valid weight and payment amount are required'; END IF;

  SELECT id INTO v_customer_id FROM public.customers
  WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(trim(p_customer->>'phone'), '[^0-9]', '', 'g')
  LIMIT 1 FOR UPDATE;
  IF v_customer_id IS NULL THEN
    INSERT INTO public.customers(name, phone, email, notes, branch, branch_id, created_by_staff_id)
    VALUES (trim(p_customer->>'name'), trim(p_customer->>'phone'), NULLIF(trim(p_customer->>'email'), ''), NULLIF(trim(p_customer->>'notes'), ''), v_branch_name, p_branch_id, p_staff_id)
    RETURNING id INTO v_customer_id;
  END IF;

  SELECT bundlekg, bundleprice, excesskgprice, addonprice, loyalty_enabled,
         loyalty_discount_milestone, loyalty_free_load_milestone,
         loyalty_discount_percent, loyalty_reward_expiry_days, loyalty_program_started_at
  INTO v_bundle_kg, v_bundle_price, v_excess_price, v_addon_price, v_loyalty_enabled,
       v_discount_milestone, v_free_load_milestone, v_discount_percent, v_expiry_days, v_program_started_at
  FROM public.settings LIMIT 1;
  v_bundle_kg := GREATEST(COALESCE(v_bundle_kg, 8), 1);
  v_bundle_price := GREATEST(COALESCE(v_bundle_price, 200), 0);
  v_excess_price := GREATEST(COALESCE(v_excess_price, 30), 0);
  v_addon_price := GREATEST(COALESCE(v_addon_price, 15), 0);
  v_loads := GREATEST(1, CEIL(v_weight / v_bundle_kg)::INTEGER);
  SELECT COALESCE(SUM(value::NUMERIC), 0) INTO v_addon_units FROM jsonb_each_text(COALESCE(p_addons, '{}'::JSONB));
  IF v_addon_units < 0 THEN RAISE EXCEPTION 'Add-on quantities cannot be negative'; END IF;
  v_raw_total := v_bundle_price + CEIL(GREATEST(v_weight - v_bundle_kg, 0)) * v_excess_price + v_addon_units * v_addon_price;
  v_final_total := v_raw_total;

  IF p_loyalty_reward_id IS NOT NULL THEN RAISE EXCEPTION 'Loyalty rewards are applied automatically to qualifying orders'; END IF;
  IF COALESCE(v_loyalty_enabled, FALSE) AND NOT EXISTS (
    SELECT 1 FROM public.loyalty_rewards reward
    JOIN public.orders reward_order ON reward_order.id = reward.earned_order_id
    WHERE reward.customer_id = v_customer_id AND reward.status = 'redeemed'
      AND reward_order.status NOT IN ('released', 'cancelled')
  ) THEN
    SELECT COUNT(*) INTO v_completed_count FROM public.orders
    WHERE customer_id = v_customer_id AND status = 'released' AND payment_status = 'paid'
      AND picked_up_at >= v_program_started_at;
    v_next_position := (v_completed_count % v_free_load_milestone) + 1;
    v_reward_type := CASE
      WHEN v_next_position = v_discount_milestone THEN 'percentage_discount'
      WHEN v_next_position = v_free_load_milestone THEN 'free_load'
      ELSE NULL
    END;
    IF v_reward_type = 'percentage_discount' THEN
      v_final_total := ROUND(v_raw_total * (100 - v_discount_percent) / 100.0, 2);
    ELSIF v_reward_type = 'free_load' THEN
      v_final_total := GREATEST(0, v_raw_total - v_bundle_price);
    END IF;
    v_discount := v_raw_total - v_final_total;
  END IF;
  IF v_amount_paid < v_final_total * 0.5 THEN RAISE EXCEPTION 'Minimum 50%% payment required: %', ROUND(v_final_total * 0.5, 2); END IF;

  FOR v_item IN SELECT * FROM public.inventory_items WHERE branch_id = p_branch_id FOR UPDATE LOOP
    v_required := COALESCE(v_item.usage_per_load, 0) * v_loads + COALESCE((p_addons ->> v_item.id::TEXT)::NUMERIC, 0);
    IF v_required > COALESCE(v_item.current_stock, 0) THEN RAISE EXCEPTION '% has only % % remaining at %', v_item.name, v_item.current_stock, v_item.unit, v_branch_name; END IF;
  END LOOP;

  SELECT minutes, source INTO v_eta_minutes, v_eta_source
  FROM public.estimate_order_processing_minutes(p_branch_id, NULLIF(p_order->>'service_type_id', '')::UUID, v_weight);
  INSERT INTO public.orders(customer_id, service_type_id, weight_kg, total_price, addons, notes, payment_method,
    payment_status, amount_paid, branch, branch_id, created_by_staff_id, last_updated_by_staff_id, status,
    estimated_processing_minutes, eta_source, estimated_ready_at, loyalty_reward_id, loyalty_original_total, loyalty_discount_amount)
  VALUES (v_customer_id, NULLIF(p_order->>'service_type_id', '')::UUID, v_weight, v_final_total,
    COALESCE(p_addons, '{}'::JSONB), NULLIF(p_order->>'notes', ''), COALESCE(NULLIF(p_order->>'payment_method', ''), 'cash'),
    CASE WHEN v_amount_paid >= v_final_total THEN 'paid' ELSE 'partial' END, v_amount_paid,
    v_branch_name, p_branch_id, p_staff_id, p_staff_id, 'received', v_eta_minutes, v_eta_source,
    now() + make_interval(mins => v_eta_minutes), NULL, v_raw_total, v_discount)
  RETURNING * INTO v_order;

  IF v_reward_type IS NOT NULL THEN
    INSERT INTO public.loyalty_rewards(customer_id, earned_order_id, reward_type, status, discount_percent, free_load_kg, expires_at, redeemed_at, redeemed_order_id)
    VALUES (v_customer_id, v_order.id, v_reward_type, 'redeemed',
      CASE WHEN v_reward_type = 'percentage_discount' THEN v_discount_percent ELSE NULL END,
      CASE WHEN v_reward_type = 'free_load' THEN 8 ELSE NULL END,
      now() + make_interval(days => v_expiry_days), now(), v_order.id)
    RETURNING id INTO v_reward_id;
    UPDATE public.orders SET loyalty_reward_id = v_reward_id WHERE id = v_order.id;
  END IF;

  FOR v_item IN SELECT * FROM public.inventory_items WHERE branch_id = p_branch_id FOR UPDATE LOOP
    v_required := COALESCE(v_item.usage_per_load, 0) * v_loads + COALESCE((p_addons ->> v_item.id::TEXT)::NUMERIC, 0);
    IF v_required > 0 THEN
      UPDATE public.inventory_items SET current_stock = current_stock - v_required WHERE id = v_item.id;
      INSERT INTO public.inventory_usage_log(item_id, quantity_used, order_id) VALUES (v_item.id, v_required, v_order.id);
    END IF;
  END LOOP;
  INSERT INTO public.customer_branches(customer_id, branch_id, first_served_at, last_served_at, order_count)
  VALUES (v_customer_id, p_branch_id, now(), now(), 1)
  ON CONFLICT (customer_id, branch_id) DO UPDATE SET last_served_at = now(), order_count = public.customer_branches.order_count + 1;
  RETURN v_order;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_branch_order(UUID, UUID, JSONB, JSONB, JSONB, INTEGER, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_branch_order(UUID, UUID, JSONB, JSONB, JSONB, INTEGER, UUID) TO service_role;

COMMIT;
