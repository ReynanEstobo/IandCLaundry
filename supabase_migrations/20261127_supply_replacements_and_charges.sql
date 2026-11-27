-- Customer supply choices: approved replacements, extra charges, and safeguards.
--
-- Run after 20261126_customer_supply_choices.sql.
--
-- 1. For each usual supply of a service at a branch, the Administrator decides
--    whether the customer may bring their own and whether it may be left out,
--    and lists the items approved to replace it. Each approved replacement has
--    its own amount per load (in that item's unit) and an extra charge per load.
-- 2. On a new order, staff can only pick an approved replacement. The database
--    works out the amount and the charge from these settings; any amount or
--    price sent by the browser is ignored. The charge is part of the order total
--    (like an add-on), so a percentage loyalty discount also applies to it,
--    while a free load covers the service only.
-- 3. Every supply change is written to the Audit Log.
-- 4. Supplies of a service that is still "Received" can be changed later; the
--    stock, the charge, and the total are recalculated.
-- 5. Cancelling returns supplies and add-ons to stock only for services that
--    had not started; once washing has started they were used, so they stay
--    deducted.
--
-- Safe to run more than once.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.order_item_supplies') IS NULL
    OR position('order_item_supplies' IN pg_get_functiondef(
      'public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Stopped: apply 20261126_customer_supply_choices.sql first. Nothing was changed.';
  END IF;
  IF position('order_refunds' IN pg_get_functiondef('public.cancel_branch_order(uuid,uuid,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Stopped: cancel_branch_order is not the expected version (with cash refunds). Nothing was changed.';
  END IF;
END $$;

-- 1. Per usual supply: may the customer bring their own, and may it be left out.
ALTER TABLE public.service_inventory_requirements
  ADD COLUMN IF NOT EXISTS allow_customer_own BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS allow_leave_out BOOLEAN NOT NULL DEFAULT TRUE;

-- 2. Items approved to replace a usual supply.
CREATE TABLE IF NOT EXISTS public.service_supply_replacements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requirement_id UUID NOT NULL REFERENCES public.service_inventory_requirements(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  service_type_id UUID NOT NULL REFERENCES public.service_types(id) ON DELETE CASCADE,
  replacement_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  quantity_per_load NUMERIC(12,4) NOT NULL CHECK (quantity_per_load > 0 AND quantity_per_load <= 100000),
  extra_charge_per_load NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (extra_charge_per_load >= 0 AND extra_charge_per_load <= 10000),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_supply_replacements_unique UNIQUE (requirement_id, replacement_item_id)
);
CREATE INDEX IF NOT EXISTS idx_service_supply_replacements_branch_service
  ON public.service_supply_replacements(branch_id, service_type_id);
ALTER TABLE public.service_supply_replacements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.service_supply_replacements FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_supply_replacements TO service_role;

-- A replacement must be a current item of the same branch, other than the usual
-- item and other than another usual supply of the same service. The branch and
-- service always come from the usual supply it replaces.
CREATE OR REPLACE FUNCTION public.check_service_supply_replacement()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_requirement RECORD; v_item RECORD;
BEGIN
  SELECT r.id, r.branch_id, r.service_type_id, r.inventory_item_id, r.is_active
  INTO v_requirement FROM public.service_inventory_requirements r WHERE r.id = NEW.requirement_id;
  IF v_requirement.id IS NULL THEN RAISE EXCEPTION 'Choose a usual supply to replace'; END IF;
  NEW.branch_id := v_requirement.branch_id;
  NEW.service_type_id := v_requirement.service_type_id;
  SELECT i.id, i.name, i.unit, i.branch_id, i.deleted_at INTO v_item
  FROM public.inventory_items i WHERE i.id = NEW.replacement_item_id;
  IF v_item.id IS NULL OR v_item.deleted_at IS NOT NULL OR v_item.branch_id IS DISTINCT FROM v_requirement.branch_id THEN
    RAISE EXCEPTION 'A replacement must be a current inventory item of the same branch';
  END IF;
  IF v_item.id = v_requirement.inventory_item_id THEN
    RAISE EXCEPTION '% cannot replace itself', v_item.name;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.service_inventory_requirements other
    WHERE other.branch_id = v_requirement.branch_id AND other.service_type_id = v_requirement.service_type_id
      AND other.is_active IS TRUE AND other.inventory_item_id = v_item.id
  ) THEN
    RAISE EXCEPTION '% is already one of this service''s usual supplies', v_item.name;
  END IF;
  IF lower(btrim(v_item.unit)) IN ('pcs', 'packs', 'bottles', 'sachets')
    AND NEW.quantity_per_load <> trunc(NEW.quantity_per_load) THEN
    RAISE EXCEPTION 'The amount of % per load must be a whole number because it is counted in %', v_item.name, v_item.unit;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tr_check_service_supply_replacement ON public.service_supply_replacements;
CREATE TRIGGER tr_check_service_supply_replacement
BEFORE INSERT OR UPDATE ON public.service_supply_replacements
FOR EACH ROW EXECUTE FUNCTION public.check_service_supply_replacement();
DROP TRIGGER IF EXISTS tr_audit_service_supply_replacements ON public.service_supply_replacements;
CREATE TRIGGER tr_audit_service_supply_replacements
AFTER INSERT OR UPDATE OR DELETE ON public.service_supply_replacements
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();

-- 3. What each change cost, kept with the order so later price changes never
--    alter an existing order.
ALTER TABLE public.order_item_supplies
  ADD COLUMN IF NOT EXISTS replacement_id UUID REFERENCES public.service_supply_replacements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS loads INTEGER,
  ADD COLUMN IF NOT EXISTS extra_charge_per_load NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_charge NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.order_items
  ADD COLUMN IF NOT EXISTS supply_charge NUMERIC(12,2) NOT NULL DEFAULT 0;

-- 4a. Checks the changes sent with one service against the Administrator's
--     settings and returns them in full. Amounts and charges always come from
--     the settings, never from the request.
CREATE OR REPLACE FUNCTION public.resolve_order_item_supplies(
  p_branch_id UUID,
  p_service_type_id UUID,
  p_supplies JSONB
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_entry JSONB; v_choice TEXT; v_result JSONB := '[]'::JSONB; v_seen UUID[] := '{}'::UUID[];
  v_requirement RECORD; v_replacement RECORD;
BEGIN
  IF p_supplies IS NULL OR jsonb_typeof(p_supplies) = 'null' THEN RETURN v_result; END IF;
  IF jsonb_typeof(p_supplies) <> 'array' THEN
    RAISE EXCEPTION 'Supply choices must be sent as a list';
  END IF;
  FOR v_entry IN SELECT value FROM jsonb_array_elements(p_supplies) LOOP
    v_choice := lower(COALESCE(NULLIF(btrim(v_entry->>'choice'), ''), 'default'));
    CONTINUE WHEN v_choice = 'default';
    IF v_choice NOT IN ('substitute', 'customer_own', 'none') THEN
      RAISE EXCEPTION 'Choose a valid supply option';
    END IF;

    SELECT r.id, r.quantity_per_load, r.allow_customer_own, r.allow_leave_out,
      i.id AS item_id, i.name, i.unit
    INTO v_requirement
    FROM public.service_inventory_requirements r
    JOIN public.inventory_items i ON i.id = r.inventory_item_id
    WHERE r.id = NULLIF(v_entry->>'requirement_id', '')::UUID
      AND r.branch_id = p_branch_id
      AND r.service_type_id = p_service_type_id
      AND r.is_active IS TRUE;
    IF v_requirement.id IS NULL THEN
      RAISE EXCEPTION 'A supply choice no longer matches this service. Refresh the order form and try again.';
    END IF;
    IF v_requirement.id = ANY(v_seen) THEN
      RAISE EXCEPTION '% was changed more than once for the same service', v_requirement.name;
    END IF;
    v_seen := v_seen || v_requirement.id;

    IF v_choice = 'customer_own' AND v_requirement.allow_customer_own IS NOT TRUE THEN
      RAISE EXCEPTION 'The customer cannot bring their own % for this service', v_requirement.name;
    END IF;
    IF v_choice = 'none' AND v_requirement.allow_leave_out IS NOT TRUE THEN
      RAISE EXCEPTION '% cannot be left out for this service', v_requirement.name;
    END IF;

    IF v_choice = 'substitute' THEN
      -- Newer forms send the approved replacement; older ones sent the item.
      SELECT s.id, s.quantity_per_load, s.extra_charge_per_load, i.id AS item_id, i.name, i.unit
      INTO v_replacement
      FROM public.service_supply_replacements s
      JOIN public.inventory_items i ON i.id = s.replacement_item_id
      WHERE s.requirement_id = v_requirement.id AND s.is_active IS TRUE
        AND i.branch_id = p_branch_id AND i.deleted_at IS NULL
        AND (s.id = NULLIF(v_entry->>'replacement_id', '')::UUID
          OR (NULLIF(v_entry->>'replacement_id', '') IS NULL
            AND s.replacement_item_id = NULLIF(v_entry->>'item_id', '')::UUID))
      LIMIT 1;
      IF v_replacement.id IS NULL THEN
        RAISE EXCEPTION 'That item is not an approved replacement for % at this branch. Ask an administrator to approve it on the Services page.',
          v_requirement.name;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.service_inventory_requirements other
        WHERE other.branch_id = p_branch_id AND other.service_type_id = p_service_type_id
          AND other.is_active IS TRUE AND other.inventory_item_id = v_replacement.item_id
      ) THEN
        RAISE EXCEPTION '% is now one of this service''s usual supplies, so it cannot replace %',
          v_replacement.name, v_requirement.name;
      END IF;
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'requirement_id', v_requirement.id, 'choice', v_choice,
        'default_item_id', v_requirement.item_id, 'default_item_name', v_requirement.name,
        'item_id', v_replacement.item_id, 'item_name', v_replacement.name, 'unit', v_replacement.unit,
        'quantity_per_load', v_replacement.quantity_per_load,
        'replacement_id', v_replacement.id, 'extra_charge_per_load', v_replacement.extra_charge_per_load
      ));
    ELSE
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'requirement_id', v_requirement.id, 'choice', v_choice,
        'default_item_id', v_requirement.item_id, 'default_item_name', v_requirement.name,
        'item_id', NULL, 'item_name', NULL, 'unit', v_requirement.unit,
        'quantity_per_load', v_requirement.quantity_per_load,
        'replacement_id', NULL, 'extra_charge_per_load', 0
      ));
    END IF;
  END LOOP;
  RETURN v_result;
END $$;

-- 4b. How much to take for one usual supply of a service: the approved
--     replacement's amount per load, or the usual amount, times the loads.
CREATE OR REPLACE FUNCTION public.order_supply_amount(
  p_supplies JSONB,
  p_requirement_id UUID,
  p_usual_per_load NUMERIC,
  p_loads INTEGER
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT NULLIF(value->>'quantity_per_load', '')::NUMERIC
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_supplies) = 'array' THEN p_supplies ELSE '[]'::JSONB END)
      WHERE value->>'requirement_id' = p_requirement_id::TEXT AND value->>'choice' = 'substitute'
      LIMIT 1
    ),
    p_usual_per_load
  ) * GREATEST(COALESCE(p_loads, 1), 1)
$$;

-- 4c. The extra charge of one service's supply changes: each approved
--     replacement's charge per load, times the loads.
CREATE OR REPLACE FUNCTION public.order_supply_charge(
  p_supplies JSONB,
  p_loads INTEGER
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ROUND(COALESCE(SUM(NULLIF(value->>'extra_charge_per_load', '')::NUMERIC), 0)
    * GREATEST(COALESCE(p_loads, 1), 1), 2)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_supplies) = 'array' THEN p_supplies ELSE '[]'::JSONB END)
$$;

-- 4d. The changes of one service as the Audit Log records them.
CREATE OR REPLACE FUNCTION public.order_supply_audit_entries(
  p_service_name TEXT,
  p_supplies JSONB,
  p_loads INTEGER
) RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'service', p_service_name,
    'usual_item', value->>'default_item_name',
    'choice', value->>'choice',
    'used_item', value->>'item_name',
    'quantity', NULLIF(value->>'quantity_per_load', '')::NUMERIC * GREATEST(COALESCE(p_loads, 1), 1),
    'unit', value->>'unit',
    'extra_charge', ROUND(COALESCE(NULLIF(value->>'extra_charge_per_load', '')::NUMERIC, 0) * GREATEST(COALESCE(p_loads, 1), 1), 2)
  )), '[]'::JSONB)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_supplies) = 'array' THEN p_supplies ELSE '[]'::JSONB END)
$$;

REVOKE ALL ON FUNCTION public.resolve_order_item_supplies(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_supply_amount(JSONB, UUID, NUMERIC, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_supply_charge(JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_supply_audit_entries(TEXT, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_item_supplies(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_supply_amount(JSONB, UUID, NUMERIC, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_supply_charge(JSONB, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_supply_audit_entries(TEXT, JSONB, INTEGER) TO service_role;

-- 5. Order creation with supply charges. Identical to the current function
--    except where marked "supply".
CREATE OR REPLACE FUNCTION public.create_branch_order(p_branch_id uuid, p_staff_id uuid, p_customer jsonb, p_order jsonb, p_addons jsonb, p_loads integer, p_loyalty_reward_id uuid DEFAULT NULL::uuid)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_supplies JSONB; v_supply_charge NUMERIC; v_supply_changes JSONB := '[]'::JSONB;
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
    THEN
    RAISE EXCEPTION 'Customer name and phone are required';
  END IF;
  IF NULLIF(trim(p_customer->>'email'), '') IS NOT NULL AND trim(p_customer->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter a valid customer email';
  END IF;
  v_amount_paid := COALESCE(NULLIF(p_order->>'amount_paid', '')::NUMERIC, 0);
  IF v_amount_paid < 0 THEN RAISE EXCEPTION 'A valid payment amount is required'; END IF;
  IF lower(COALESCE(NULLIF(trim(p_order->>'payment_method'), ''), 'cash')) <> 'cash' THEN
    RAISE EXCEPTION 'Cash is the only accepted payment method';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('customer-phone:' || regexp_replace(trim(p_customer->>'phone'), '[^0-9]', '', 'g'), 0));
  SELECT id, email INTO v_customer_id, v_customer_email FROM public.customers
  WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(trim(p_customer->>'phone'), '[^0-9]', '', 'g') AND deleted_at IS NULL
  LIMIT 1 FOR UPDATE;
  IF v_customer_id IS NULL THEN
    INSERT INTO public.customers(name, phone, email, branch, branch_id, created_by_staff_id)
    VALUES (trim(p_customer->>'name'), trim(p_customer->>'phone'), NULLIF(trim(p_customer->>'email'), ''),
      v_branch_name, p_branch_id, p_staff_id)
    RETURNING id INTO v_customer_id;
  ELSIF COALESCE(trim(v_customer_email), '') = '' AND NULLIF(trim(p_customer->>'email'), '') IS NOT NULL THEN
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
    -- supply: the checked changes and their extra charge for this service.
    v_supplies := public.resolve_order_item_supplies(p_branch_id, v_service.id, v_entry->'supplies');
    v_supply_charge := public.order_supply_charge(v_supplies, v_load_count);
    v_raw_total := v_raw_total + v_subtotal + v_supply_charge;
    v_total_weight := v_total_weight + v_weight;
    SELECT minutes, source INTO v_item_eta, v_item_eta_source
    FROM public.estimate_order_processing_minutes(p_branch_id, v_service.id, v_weight);
    v_eta_minutes := GREATEST(v_eta_minutes, COALESCE(v_item_eta, 1));
    IF v_item_eta_source LIKE 'historical_service_branch%' THEN v_eta_source := 'historical_service_branch_max'; END IF;
    IF v_first_service IS NULL THEN v_first_service := v_service.id; v_first_bundle_price := v_service.bundle_price; END IF;
    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'service_type_id', v_service.id, 'name', v_service.name, 'processing_type', v_service.processing_type,
      'weight_kg', v_weight, 'loads', v_load_count, 'bundle_kg', v_service.bundle_kg,
      'bundle_price', v_service.bundle_price, 'excess_kg_price', v_service.excess_kg_price,
      'subtotal', v_subtotal,
      'supplies', v_supplies,
      'supply_charge', v_supply_charge
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
        SELECT supply.item_id AS inventory_item_id,
          public.order_supply_amount(resolved.item->'supplies', r.id,
            r.quantity_per_load, (resolved.item->>'loads')::INTEGER) AS required_quantity
        FROM jsonb_array_elements(v_resolved) AS resolved(item)
        JOIN public.service_inventory_requirements r
          ON r.service_type_id = (resolved.item->>'service_type_id')::UUID
         AND r.branch_id = p_branch_id
         AND r.is_active IS TRUE
        CROSS JOIN LATERAL (
          SELECT public.order_supply_item_to_deduct(resolved.item->'supplies', r.id, r.inventory_item_id) AS item_id
        ) supply
        WHERE supply.item_id IS NOT NULL
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
    CASE WHEN v_amount_paid <= 0 THEN 'unpaid' WHEN v_amount_paid >= v_final_total THEN 'paid' ELSE 'partial' END, v_amount_paid,
    v_branch_name, p_branch_id, p_staff_id, p_staff_id, 'received', GREATEST(v_eta_minutes, 1),
    v_eta_source, now() + make_interval(mins => GREATEST(v_eta_minutes, 1)), v_raw_total,
    v_discount, v_request_id)
  RETURNING * INTO v_order;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_resolved) LOOP
    INSERT INTO public.order_items(order_id, branch_id, service_type_id, service_name_snapshot, pricing_type_snapshot,
      bundle_kg_snapshot, bundle_price_snapshot, excess_kg_price_snapshot, processing_type_snapshot,
      weight_kg, quantity, loads, unit_price_snapshot, subtotal, last_updated_by_staff_id, supply_charge)
    VALUES (v_order.id, p_branch_id, (v_entry->>'service_type_id')::UUID, v_entry->>'name', 'bundle',
      (v_entry->>'bundle_kg')::NUMERIC, (v_entry->>'bundle_price')::NUMERIC,
      (v_entry->>'excess_kg_price')::NUMERIC, v_entry->>'processing_type',
      (v_entry->>'weight_kg')::NUMERIC, 1, (v_entry->>'loads')::INTEGER,
      (v_entry->>'bundle_price')::NUMERIC, (v_entry->>'subtotal')::NUMERIC,
      p_staff_id, COALESCE((v_entry->>'supply_charge')::NUMERIC, 0))
    RETURNING id INTO v_order_item_id;

    FOR v_requirement IN
      SELECT r.id, r.quantity_per_load, i.id AS inventory_item_id, i.name, i.unit, i.current_stock
      FROM public.service_inventory_requirements r
      CROSS JOIN LATERAL (
        SELECT public.order_supply_item_to_deduct(v_entry->'supplies', r.id, r.inventory_item_id) AS item_id
      ) supply
      JOIN public.inventory_items i ON i.id = supply.item_id
      WHERE r.branch_id = p_branch_id AND r.service_type_id = (v_entry->>'service_type_id')::UUID
        AND r.is_active IS TRUE AND i.deleted_at IS NULL FOR UPDATE OF i
    LOOP
      v_required := public.order_supply_amount(v_entry->'supplies', v_requirement.id,
        v_requirement.quantity_per_load, (v_entry->>'loads')::INTEGER);
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
    -- supply: keep each change, its amount, and its charge with the service.
    INSERT INTO public.order_item_supplies(order_item_id, branch_id, service_inventory_requirement_id,
      default_item_id, default_item_name_snapshot, choice, used_item_id, used_item_name_snapshot,
      quantity, unit_snapshot, replacement_id, loads, extra_charge_per_load, extra_charge)
    SELECT v_order_item_id, p_branch_id, (chosen.supply->>'requirement_id')::UUID,
      (chosen.supply->>'default_item_id')::UUID, chosen.supply->>'default_item_name', chosen.supply->>'choice',
      NULLIF(chosen.supply->>'item_id', '')::UUID, NULLIF(chosen.supply->>'item_name', ''),
      (chosen.supply->>'quantity_per_load')::NUMERIC * (v_entry->>'loads')::INTEGER, chosen.supply->>'unit',
      NULLIF(chosen.supply->>'replacement_id', '')::UUID, (v_entry->>'loads')::INTEGER,
      COALESCE(NULLIF(chosen.supply->>'extra_charge_per_load', '')::NUMERIC, 0),
      ROUND(COALESCE(NULLIF(chosen.supply->>'extra_charge_per_load', '')::NUMERIC, 0) * (v_entry->>'loads')::INTEGER, 2)
    FROM jsonb_array_elements(COALESCE(v_entry->'supplies', '[]'::JSONB)) AS chosen(supply);
    v_supply_changes := v_supply_changes || public.order_supply_audit_entries(
      v_entry->>'name', v_entry->'supplies', (v_entry->>'loads')::INTEGER);
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
  -- supply: one Audit Log entry listing every change on the order.
  IF jsonb_array_length(v_supply_changes) > 0 THEN
    INSERT INTO public.audit_logs(action, event_type, event_category, table_name, record_id,
      actor_staff_id, branch_id, before_data, after_data, source)
    VALUES ('insert', 'order_supplies_changed', 'operations', 'order_item_supplies', v_order.id,
      p_staff_id, p_branch_id, '{}'::JSONB,
      jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'changes', v_supply_changes),
      'application');
  END IF;
  RETURN v_order;
END $function$;

-- 6. Cancelling: supplies and add-ons go back to stock only for services that
--    had not started. Otherwise identical to the current function.
CREATE OR REPLACE FUNCTION public.cancel_branch_order(p_order_id uuid, p_staff_id uuid, p_reason text)
 RETURNS orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_order public.orders; v_usage RECORD; v_item RECORD; v_actor RECORD; v_before JSONB; v_refund NUMERIC(12,2);
BEGIN
  IF COALESCE(trim(p_reason), '') = '' THEN RAISE EXCEPTION 'A cancellation reason is required'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF v_order.id IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  IF v_order.status = 'released' THEN RAISE EXCEPTION 'Released orders cannot be cancelled'; END IF;
  IF v_order.status = 'cancelled' THEN RAISE EXCEPTION 'This order is already cancelled'; END IF;
  SELECT id, role, branch_id INTO v_actor FROM public.staff
  WHERE id = p_staff_id AND deleted_at IS NULL;
  IF v_actor.id IS NULL THEN RAISE EXCEPTION 'A valid active staff account is required'; END IF;
  IF lower(COALESCE(v_actor.role, 'staff')) <> 'admin'
    AND v_actor.branch_id IS DISTINCT FROM v_order.branch_id THEN
    RAISE EXCEPTION 'You can only cancel orders assigned to your branch';
  END IF;
  v_before := to_jsonb(v_order);
  v_refund := GREATEST(COALESCE(v_order.amount_paid, 0) - COALESCE(v_order.refunded_amount, 0), 0);

  FOR v_item IN
    SELECT i.id FROM public.inventory_items i
    WHERE i.id IN (
      SELECT u.item_id FROM public.inventory_usage_log u
      WHERE u.order_id = p_order_id AND u.reversed_at IS NULL
        AND CASE WHEN u.order_item_id IS NULL THEN v_order.status = 'received'
          ELSE EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = u.order_item_id AND oi.status = 'received') END
    )
    ORDER BY i.id FOR UPDATE OF i
  LOOP NULL; END LOOP;

  FOR v_usage IN
    SELECT u.* FROM public.inventory_usage_log u
    WHERE u.order_id = p_order_id AND u.reversed_at IS NULL
      AND CASE WHEN u.order_item_id IS NULL THEN v_order.status = 'received'
        ELSE EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.id = u.order_item_id AND oi.status = 'received') END
    ORDER BY u.item_id, u.id FOR UPDATE OF u
  LOOP
    UPDATE public.inventory_items SET current_stock = current_stock + v_usage.quantity_used
    WHERE id = v_usage.item_id;
    INSERT INTO public.inventory_adjustments(item_id, order_id, branch_id, quantity_change, reason, created_by_staff_id)
    VALUES (v_usage.item_id, p_order_id, v_order.branch_id, v_usage.quantity_used,
      'Order cancellation stock return', p_staff_id);
    UPDATE public.inventory_usage_log SET reversed_at = now(), reversed_by_staff_id = p_staff_id
    WHERE id = v_usage.id;
  END LOOP;

  PERFORM set_config('app.order_transition_type', 'cancel', true);
  PERFORM set_config('app.order_correction_reason', trim(p_reason), true);
  PERFORM set_config('app.order_eta_before', COALESCE(v_order.estimated_ready_at::TEXT, ''), true);
  UPDATE public.orders
  SET status = 'cancelled', cancelled_at = now(), cancelled_by_staff_id = p_staff_id,
      cancellation_reason = trim(p_reason), last_updated_by_staff_id = p_staff_id,
      stage_started_at = NULL, refunded_amount = COALESCE(refunded_amount, 0) + v_refund,
      updated_at = now()
  WHERE id = p_order_id RETURNING * INTO v_order;

  IF v_refund > 0 THEN
    INSERT INTO public.order_refunds(order_id, branch_id, branch, amount, refunded_by_staff_id, reason)
    VALUES (p_order_id, v_order.branch_id, v_order.branch, v_refund, p_staff_id, trim(p_reason));
  END IF;

  INSERT INTO public.audit_logs(action, table_name, record_id, actor_staff_id, branch_id, before_data, after_data)
  VALUES ('cancel', 'orders', p_order_id, p_staff_id, v_order.branch_id, v_before, to_jsonb(v_order));
  RETURN v_order;
END $function$;

-- 7. Changing the supplies of a service that is still "Received". The old
--    supplies go back to stock, the new ones are taken, and the charge and the
--    total are recalculated (with the order's loyalty reward, if any). The new
--    total may not fall below what the customer has already paid.
CREATE OR REPLACE FUNCTION public.update_order_item_supplies(
  p_order_item_id UUID,
  p_staff_id UUID,
  p_supplies JSONB
) RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor RECORD; v_item public.order_items; v_order public.orders; v_new JSONB; v_usage RECORD;
  v_requirement RECORD; v_required NUMERIC; v_lock RECORD;
  v_before_rows JSONB; v_new_charge NUMERIC; v_original NUMERIC; v_total NUMERIC;
  v_reward RECORD; v_edit_key TEXT := gen_random_uuid()::TEXT;
BEGIN
  SELECT id, role, branch_id INTO v_actor FROM public.staff WHERE id = p_staff_id AND deleted_at IS NULL;
  IF v_actor.id IS NULL THEN RAISE EXCEPTION 'A valid active staff account is required'; END IF;
  SELECT * INTO v_item FROM public.order_items WHERE id = p_order_item_id;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Service not found'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = v_item.order_id FOR UPDATE;
  SELECT * INTO v_item FROM public.order_items WHERE id = p_order_item_id FOR UPDATE;
  IF lower(COALESCE(v_actor.role, 'staff')) <> 'admin' AND v_actor.branch_id IS DISTINCT FROM v_order.branch_id THEN
    RAISE EXCEPTION 'You can only change orders assigned to your branch';
  END IF;
  IF v_order.status <> 'received' OR v_item.status <> 'received' THEN
    RAISE EXCEPTION 'Supplies can only be changed before work on the service starts';
  END IF;

  v_new := public.resolve_order_item_supplies(v_item.branch_id, v_item.service_type_id, p_supplies);
  SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.created_at), '[]'::JSONB) INTO v_before_rows
  FROM public.order_item_supplies s WHERE s.order_item_id = v_item.id;

  -- Lock every stock row involved, old and new, in one stable order.
  FOR v_lock IN
    SELECT i.id FROM public.inventory_items i
    WHERE i.id IN (
      SELECT u.item_id FROM public.inventory_usage_log u
      WHERE u.order_item_id = v_item.id AND u.service_inventory_requirement_id IS NOT NULL AND u.reversed_at IS NULL
      UNION
      SELECT public.order_supply_item_to_deduct(v_new, r.id, r.inventory_item_id)
      FROM public.service_inventory_requirements r
      WHERE r.branch_id = v_item.branch_id AND r.service_type_id = v_item.service_type_id AND r.is_active IS TRUE
    )
    ORDER BY i.id FOR UPDATE OF i
  LOOP NULL; END LOOP;

  -- Return what was taken for this service's usual supplies.
  FOR v_usage IN
    SELECT u.* FROM public.inventory_usage_log u
    WHERE u.order_item_id = v_item.id AND u.service_inventory_requirement_id IS NOT NULL AND u.reversed_at IS NULL
    ORDER BY u.item_id, u.id FOR UPDATE OF u
  LOOP
    UPDATE public.inventory_items SET current_stock = current_stock + v_usage.quantity_used WHERE id = v_usage.item_id;
    INSERT INTO public.inventory_adjustments(item_id, order_id, branch_id, quantity_change, reason, created_by_staff_id)
    VALUES (v_usage.item_id, v_order.id, v_order.branch_id, v_usage.quantity_used,
      'Supplies changed on the order: stock returned', p_staff_id);
    UPDATE public.inventory_usage_log SET reversed_at = now(), reversed_by_staff_id = p_staff_id WHERE id = v_usage.id;
  END LOOP;

  -- Take the supplies now chosen.
  FOR v_requirement IN
    SELECT r.id, r.quantity_per_load, i.id AS inventory_item_id, i.name, i.unit, i.current_stock
    FROM public.service_inventory_requirements r
    CROSS JOIN LATERAL (
      SELECT public.order_supply_item_to_deduct(v_new, r.id, r.inventory_item_id) AS item_id
    ) supply
    JOIN public.inventory_items i ON i.id = supply.item_id
    WHERE r.branch_id = v_item.branch_id AND r.service_type_id = v_item.service_type_id
      AND r.is_active IS TRUE AND i.deleted_at IS NULL
  LOOP
    v_required := public.order_supply_amount(v_new, v_requirement.id, v_requirement.quantity_per_load, v_item.loads);
    IF v_required > v_requirement.current_stock THEN
      RAISE EXCEPTION '% has only % % remaining; % % is required for %',
        v_requirement.name, v_requirement.current_stock, v_requirement.unit,
        v_required, v_requirement.unit, v_item.service_name_snapshot;
    END IF;
    UPDATE public.inventory_items SET current_stock = current_stock - v_required WHERE id = v_requirement.inventory_item_id;
    INSERT INTO public.inventory_usage_log(item_id, quantity_used, order_id, order_item_id,
      service_inventory_requirement_id, deduction_key, reason)
    VALUES (v_requirement.inventory_item_id, v_required, v_order.id, v_item.id, v_requirement.id,
      'supplies-changed:' || v_edit_key || ':item:' || v_item.id || ':recipe:' || v_requirement.id,
      'Automatic service consumption (supplies changed)');
  END LOOP;

  DELETE FROM public.order_item_supplies WHERE order_item_id = v_item.id;
  INSERT INTO public.order_item_supplies(order_item_id, branch_id, service_inventory_requirement_id,
    default_item_id, default_item_name_snapshot, choice, used_item_id, used_item_name_snapshot,
    quantity, unit_snapshot, replacement_id, loads, extra_charge_per_load, extra_charge)
  SELECT v_item.id, v_item.branch_id, (chosen.supply->>'requirement_id')::UUID,
    (chosen.supply->>'default_item_id')::UUID, chosen.supply->>'default_item_name', chosen.supply->>'choice',
    NULLIF(chosen.supply->>'item_id', '')::UUID, NULLIF(chosen.supply->>'item_name', ''),
    (chosen.supply->>'quantity_per_load')::NUMERIC * v_item.loads, chosen.supply->>'unit',
    NULLIF(chosen.supply->>'replacement_id', '')::UUID, v_item.loads,
    COALESCE(NULLIF(chosen.supply->>'extra_charge_per_load', '')::NUMERIC, 0),
    ROUND(COALESCE(NULLIF(chosen.supply->>'extra_charge_per_load', '')::NUMERIC, 0) * v_item.loads, 2)
  FROM jsonb_array_elements(v_new) AS chosen(supply);

  -- Recalculate the charge and the order total.
  v_new_charge := public.order_supply_charge(v_new, v_item.loads);
  v_original := COALESCE(v_order.loyalty_original_total, v_order.total_price) + v_new_charge - COALESCE(v_item.supply_charge, 0);
  SELECT reward_type, discount_percent INTO v_reward FROM public.loyalty_rewards WHERE id = v_order.loyalty_reward_id;
  IF v_reward.reward_type = 'percentage_discount' THEN
    v_total := ROUND(v_original * (100 - GREATEST(LEAST(COALESCE(v_reward.discount_percent, 50), 100), 1)) / 100.0, 2);
  ELSIF v_reward.reward_type = 'free_load' THEN
    v_total := GREATEST(0, v_original - COALESCE(v_order.loyalty_discount_amount, 0));
  ELSE
    v_total := v_original;
  END IF;
  IF COALESCE(v_order.amount_paid, 0) > v_total THEN
    RAISE EXCEPTION 'The customer has already paid ₱%, more than the new total of ₱%. Keep the paid supply change, or cancel the order and create it again.',
      to_char(v_order.amount_paid, 'FM999,999,990.00'), to_char(v_total, 'FM999,999,990.00');
  END IF;

  UPDATE public.order_items SET supply_charge = v_new_charge, last_updated_by_staff_id = p_staff_id, updated_at = now()
  WHERE id = v_item.id;
  UPDATE public.orders
  SET total_price = v_total, loyalty_original_total = v_original, loyalty_discount_amount = v_original - v_total,
      payment_status = CASE WHEN COALESCE(amount_paid, 0) <= 0 THEN 'unpaid'
        WHEN amount_paid >= v_total THEN 'paid' ELSE 'partial' END,
      last_updated_by_staff_id = p_staff_id, updated_at = now()
  WHERE id = v_order.id RETURNING * INTO v_order;

  INSERT INTO public.audit_logs(action, event_type, event_category, table_name, record_id,
    actor_staff_id, branch_id, before_data, after_data, source)
  VALUES ('update', 'order_supplies_changed', 'operations', 'order_item_supplies', v_order.id,
    p_staff_id, v_order.branch_id,
    jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'service', v_item.service_name_snapshot,
      'changes', (SELECT COALESCE(jsonb_agg(jsonb_build_object('service', v_item.service_name_snapshot,
        'usual_item', row->>'default_item_name_snapshot', 'choice', row->>'choice', 'used_item', row->>'used_item_name_snapshot',
        'quantity', (row->>'quantity')::NUMERIC, 'unit', row->>'unit_snapshot', 'extra_charge', COALESCE((row->>'extra_charge')::NUMERIC, 0))), '[]'::JSONB)
        FROM jsonb_array_elements(v_before_rows) AS row)),
    jsonb_build_object('order_id', v_order.id, 'order_number', v_order.order_number, 'service', v_item.service_name_snapshot,
      'changes', public.order_supply_audit_entries(v_item.service_name_snapshot, v_new, v_item.loads)),
    'application');
  RETURN v_order;
END $$;
REVOKE ALL ON FUNCTION public.update_order_item_supplies(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_order_item_supplies(UUID, UUID, JSONB) TO service_role;

COMMIT;
