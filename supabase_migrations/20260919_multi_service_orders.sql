-- Run after 20260918_record_additional_order_payment.sql.
-- Adds one-or-more configurable service items to an order without removing the
-- legacy order service_type_id/weight_kg columns used by historic records.
BEGIN;

ALTER TABLE public.service_types
  ADD COLUMN IF NOT EXISTS pricing_type TEXT NOT NULL DEFAULT 'per_kg',
  ADD COLUMN IF NOT EXISTS unit_price NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS processing_type TEXT NOT NULL DEFAULT 'full_service',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

UPDATE public.service_types
SET unit_price = COALESCE(unit_price, price_per_kg, 0),
    pricing_type = COALESCE(NULLIF(pricing_type, ''), 'per_kg'),
    processing_type = COALESCE(NULLIF(processing_type, ''), 'full_service');

-- Prior order creation ignored the selected service rate and always used the
-- normal Settings bundle formula. Mark existing active services as bundle so
-- their behaviour remains compatible until an administrator configures a
-- distinct pricing type/rate.
UPDATE public.service_types SET pricing_type = 'bundle' WHERE is_active IS TRUE;

ALTER TABLE public.service_types DROP CONSTRAINT IF EXISTS service_types_pricing_type_check;
ALTER TABLE public.service_types ADD CONSTRAINT service_types_pricing_type_check
  CHECK (pricing_type IN ('bundle', 'per_kg', 'per_piece', 'fixed'));
ALTER TABLE public.service_types DROP CONSTRAINT IF EXISTS service_types_processing_type_check;
ALTER TABLE public.service_types ADD CONSTRAINT service_types_processing_type_check
  CHECK (processing_type IN ('full_service', 'air_dry_only'));
ALTER TABLE public.service_types DROP CONSTRAINT IF EXISTS service_types_unit_price_check;
ALTER TABLE public.service_types ADD CONSTRAINT service_types_unit_price_check
  CHECK (unit_price IS NULL OR unit_price >= 0);

-- These are intentionally inactive placeholders. An administrator must choose
-- the actual local rates before special services can be offered.
INSERT INTO public.service_types(name, description, is_active, pricing_type, unit_price, processing_type, estimated_minutes)
SELECT v.name, v.description, FALSE, v.pricing_type, 0, v.processing_type, v.estimated_minutes
FROM (VALUES
  ('Regular Clothing', 'Normal laundry bundle pricing configured in Settings.', 'bundle', 'full_service', 120),
  ('Comforter', 'Configure the local rate before enabling this service.', 'per_kg', 'full_service', 180),
  ('Pads', 'Configure the local rate before enabling this service.', 'per_kg', 'full_service', 180),
  ('Gown / Dress', 'Configure the local rate before enabling this service.', 'per_piece', 'air_dry_only', 180)
) AS v(name, description, pricing_type, processing_type, estimated_minutes)
WHERE NOT EXISTS (SELECT 1 FROM public.service_types s WHERE lower(s.name) = lower(v.name));

CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  service_type_id UUID REFERENCES public.service_types(id) ON DELETE RESTRICT,
  service_name_snapshot TEXT NOT NULL,
  pricing_type_snapshot TEXT NOT NULL CHECK (pricing_type_snapshot IN ('bundle', 'per_kg', 'per_piece', 'fixed', 'legacy')),
  processing_type_snapshot TEXT NOT NULL CHECK (processing_type_snapshot IN ('full_service', 'air_dry_only', 'legacy')),
  weight_kg NUMERIC(10,2),
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1,
  unit_price_snapshot NUMERIC(12,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'on_process', 'completed', 'cancelled')),
  notes TEXT,
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (weight_kg IS NULL OR weight_kg > 0),
  CHECK (quantity > 0),
  CHECK (unit_price_snapshot >= 0),
  CHECK (subtotal >= 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_service ON public.order_items(service_type_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_status ON public.order_items(order_id, status);

CREATE TABLE IF NOT EXISTS public.service_inventory_requirements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  service_type_id UUID NOT NULL REFERENCES public.service_types(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  usage_basis TEXT NOT NULL CHECK (usage_basis IN ('per_kg', 'per_piece', 'per_order')),
  quantity_per_unit NUMERIC(12,4) NOT NULL CHECK (quantity_per_unit > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(branch_id, service_type_id, inventory_item_id)
);
CREATE INDEX IF NOT EXISTS idx_service_inventory_requirements_service_branch
  ON public.service_inventory_requirements(service_type_id, branch_id) WHERE is_active;

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_inventory_requirements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated order item access" ON public.order_items;
CREATE POLICY "Authenticated order item access" ON public.order_items FOR ALL USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Authenticated service recipe access" ON public.service_inventory_requirements;
CREATE POLICY "Authenticated service recipe access" ON public.service_inventory_requirements FOR ALL USING (auth.role() = 'authenticated');

ALTER TABLE public.inventory_usage_log
  ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES public.order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS service_inventory_requirement_id UUID REFERENCES public.service_inventory_requirements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deduction_key TEXT,
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'Automatic service consumption';
CREATE UNIQUE INDEX IF NOT EXISTS inventory_usage_log_deduction_key_unique
  ON public.inventory_usage_log(deduction_key) WHERE deduction_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_usage_order_item ON public.inventory_usage_log(order_item_id, logged_at DESC);

-- Reuse the structured audit trail installed by the preceding migration.
DROP TRIGGER IF EXISTS tr_audit_order_items ON public.order_items;
CREATE TRIGGER tr_audit_order_items AFTER INSERT OR UPDATE OR DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_service_inventory_requirements ON public.service_inventory_requirements;
CREATE TRIGGER tr_audit_service_inventory_requirements AFTER INSERT OR UPDATE OR DELETE ON public.service_inventory_requirements
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();

-- Every historical order becomes one legacy item. Its stored total is kept as
-- the snapshot because historic add-ons/discounts cannot be separated safely.
INSERT INTO public.order_items(
  order_id, service_type_id, service_name_snapshot, pricing_type_snapshot,
  processing_type_snapshot, weight_kg, quantity, unit_price_snapshot, subtotal,
  status, processing_started_at, completed_at, created_at, updated_at
)
SELECT o.id, o.service_type_id, COALESCE(s.name, 'Legacy laundry service'), 'legacy', 'legacy',
  NULLIF(o.weight_kg, 0), 1, COALESCE(o.total_price, 0), COALESCE(o.total_price, 0),
  CASE o.status WHEN 'on_process' THEN 'on_process' WHEN 'ready' THEN 'completed'
    WHEN 'released' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'received' END,
  o.processing_started_at,
  CASE WHEN o.status IN ('ready', 'released') THEN COALESCE(o.ready_at, o.actual_completion, o.updated_at) END,
  o.created_at, COALESCE(o.updated_at, o.created_at)
FROM public.orders o
LEFT JOIN public.service_types s ON s.id = o.service_type_id
WHERE NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id = o.id);

CREATE OR REPLACE FUNCTION public.order_item_price(
  p_pricing_type TEXT, p_unit_price NUMERIC, p_weight NUMERIC, p_quantity NUMERIC
) RETURNS NUMERIC
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bundle_kg NUMERIC; v_bundle_price NUMERIC; v_excess NUMERIC;
BEGIN
  IF p_pricing_type = 'bundle' THEN
    SELECT bundlekg, bundleprice, excesskgprice INTO v_bundle_kg, v_bundle_price, v_excess FROM public.settings LIMIT 1;
    v_bundle_kg := GREATEST(COALESCE(v_bundle_kg, 8), 1);
    RETURN ROUND(GREATEST(COALESCE(v_bundle_price, 0), 0) +
      CEIL(GREATEST(COALESCE(p_weight, 0) - v_bundle_kg, 0)) * GREATEST(COALESCE(v_excess, 0), 0), 2);
  ELSIF p_pricing_type = 'per_kg' THEN
    RETURN ROUND(GREATEST(COALESCE(p_weight, 0), 0) * GREATEST(COALESCE(p_unit_price, 0), 0), 2);
  ELSIF p_pricing_type = 'per_piece' THEN
    RETURN ROUND(GREATEST(COALESCE(p_quantity, 0), 0) * GREATEST(COALESCE(p_unit_price, 0), 0), 2);
  ELSIF p_pricing_type = 'fixed' THEN
    RETURN ROUND(GREATEST(COALESCE(p_unit_price, 0), 0), 2);
  END IF;
  RAISE EXCEPTION 'Unknown service pricing type';
END $$;

-- The existing RPC signature is preserved. New clients send p_order.items;
-- old callers still create one item from service_type_id and weight_kg.
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
    v_quantity := COALESCE(NULLIF(v_entry->>'quantity', '')::NUMERIC, 1);
    IF v_service.pricing_type IN ('bundle', 'per_kg') AND COALESCE(v_weight, 0) <= 0 THEN
      RAISE EXCEPTION '% requires a weight greater than zero', v_service.name;
    END IF;
    IF v_service.pricing_type = 'per_piece' AND (v_quantity <= 0 OR v_quantity <> floor(v_quantity)) THEN
      RAISE EXCEPTION '% requires a whole quantity greater than zero', v_service.name;
    END IF;
    IF v_service.pricing_type = 'fixed' THEN v_quantity := 1; v_weight := NULL; END IF;
    IF v_service.pricing_type <> 'bundle' AND COALESCE(v_service.unit_price, 0) <= 0 THEN
      RAISE EXCEPTION '% has no configured price. Ask an administrator to configure it first.', v_service.name;
    END IF;
    v_subtotal := public.order_item_price(v_service.pricing_type, v_service.unit_price, v_weight, v_quantity);
    v_raw_total := v_raw_total + v_subtotal;
    v_total_weight := v_total_weight + COALESCE(v_weight, 0);
    v_eta_minutes := GREATEST(v_eta_minutes, COALESCE(v_service.estimated_minutes, 0));
    v_first_service := COALESCE(v_first_service, v_service.id);
    v_resolved := v_resolved || jsonb_build_array(jsonb_build_object(
      'service_type_id', v_service.id, 'name', v_service.name, 'pricing_type', v_service.pricing_type,
      'processing_type', v_service.processing_type, 'weight_kg', v_weight, 'quantity', v_quantity,
      'unit_price', CASE WHEN v_service.pricing_type = 'bundle' THEN public.order_item_price('bundle', 0, LEAST(v_weight, COALESCE((SELECT bundlekg FROM public.settings LIMIT 1), 8)), 1) ELSE v_service.unit_price END,
      'subtotal', v_subtotal, 'notes', NULLIF(trim(v_entry->>'notes'), '')
    ));
  END LOOP;
  SELECT COALESCE(SUM(value::NUMERIC), 0) INTO v_addon_units FROM jsonb_each_text(COALESCE(p_addons, '{}'::JSONB));
  IF v_addon_units < 0 THEN RAISE EXCEPTION 'Add-on quantities cannot be negative'; END IF;
  SELECT COALESCE(addonprice, 0) INTO v_addon_price FROM public.settings LIMIT 1;
  v_raw_total := ROUND(v_raw_total + v_addon_units * v_addon_price, 2);
  v_final_total := v_raw_total;
  -- Existing loyalty semantics remain one reward/one order, not one reward/item.
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
    GREATEST(v_eta_minutes, 1), 'service_configuration_max_duration',
    now() + make_interval(mins => GREATEST(v_eta_minutes, 1)), v_raw_total, v_discount)
  RETURNING * INTO v_order;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_resolved) LOOP
    INSERT INTO public.order_items(order_id, service_type_id, service_name_snapshot, pricing_type_snapshot,
      processing_type_snapshot, weight_kg, quantity, unit_price_snapshot, subtotal, notes)
    VALUES (v_order.id, (v_entry->>'service_type_id')::UUID, v_entry->>'name', v_entry->>'pricing_type',
      v_entry->>'processing_type', NULLIF(v_entry->>'weight_kg', '')::NUMERIC,
      (v_entry->>'quantity')::NUMERIC, (v_entry->>'unit_price')::NUMERIC,
      (v_entry->>'subtotal')::NUMERIC, NULLIF(v_entry->>'notes', ''));
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

CREATE OR REPLACE FUNCTION public.transition_order_item(
  p_order_item_id UUID, p_staff_id UUID, p_new_status TEXT
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item public.order_items; v_order public.orders; v_actor RECORD; v_requirement RECORD; v_addon RECORD;
  v_required NUMERIC(12,4); v_available NUMERIC(12,4); v_addon_name TEXT; v_addon_unit TEXT;
  v_problem TEXT := ''; v_result public.orders;
BEGIN
  SELECT * INTO v_item FROM public.order_items WHERE id = p_order_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Service item not found'; END IF;
  SELECT * INTO v_order FROM public.orders WHERE id = v_item.order_id FOR UPDATE;
  IF v_order.status IN ('released', 'cancelled') THEN RAISE EXCEPTION 'Released and cancelled orders are locked'; END IF;
  SELECT id, role, branch_id INTO v_actor FROM public.staff WHERE id = p_staff_id AND deleted_at IS NULL;
  IF v_actor.id IS NULL OR (lower(COALESCE(v_actor.role, 'staff')) <> 'admin' AND v_actor.branch_id IS DISTINCT FROM v_order.branch_id) THEN
    RAISE EXCEPTION 'You can only process service items assigned to your branch';
  END IF;
  IF p_new_status = 'on_process' AND v_item.status = 'received' THEN
    -- Lock and validate every configured requirement before changing stock.
    FOR v_requirement IN SELECT r.*, i.name, i.unit, i.current_stock FROM public.service_inventory_requirements r
      JOIN public.inventory_items i ON i.id = r.inventory_item_id
      WHERE r.branch_id = v_order.branch_id AND r.service_type_id = v_item.service_type_id AND r.is_active
      FOR UPDATE OF i LOOP
      v_required := CASE v_requirement.usage_basis WHEN 'per_kg' THEN COALESCE(v_item.weight_kg, 0) * v_requirement.quantity_per_unit
        WHEN 'per_piece' THEN v_item.quantity * v_requirement.quantity_per_unit ELSE v_requirement.quantity_per_unit END;
      IF NOT EXISTS (SELECT 1 FROM public.inventory_usage_log u WHERE u.deduction_key = 'item:' || v_item.id || ':requirement:' || v_requirement.id)
        AND v_required > v_requirement.current_stock THEN
        v_problem := v_problem || format('%s (required %s %s, available %s %s); ', v_requirement.name, v_required, v_requirement.unit, v_requirement.current_stock, v_requirement.unit);
      END IF;
    END LOOP;
    -- Order-level add-ons retain their legacy meaning and are deducted once,
    -- when the first service item of the order begins processing.
    FOR v_addon IN SELECT key AS item_id, value::NUMERIC AS quantity FROM jsonb_each_text(COALESCE(v_order.addons, '{}'::JSONB)) LOOP
      SELECT current_stock, name, unit INTO v_available, v_addon_name, v_addon_unit FROM public.inventory_items
       WHERE id = v_addon.item_id::UUID AND branch_id = v_order.branch_id FOR UPDATE;
      SELECT COALESCE(SUM(CASE r.usage_basis
        WHEN 'per_kg' THEN COALESCE(v_item.weight_kg, 0) * r.quantity_per_unit
        WHEN 'per_piece' THEN v_item.quantity * r.quantity_per_unit
        ELSE r.quantity_per_unit END), 0) INTO v_required
      FROM public.service_inventory_requirements r
      WHERE r.branch_id = v_order.branch_id AND r.service_type_id = v_item.service_type_id
        AND r.inventory_item_id = v_addon.item_id::UUID AND r.is_active
        AND NOT EXISTS (SELECT 1 FROM public.inventory_usage_log u WHERE u.deduction_key = 'item:' || v_item.id || ':requirement:' || r.id);
      IF NOT EXISTS (SELECT 1 FROM public.inventory_usage_log u WHERE u.deduction_key = 'order:' || v_order.id || ':addon:' || v_addon.item_id)
        AND v_addon.quantity + v_required > COALESCE(v_available, 0) THEN
        v_problem := v_problem || format('%s (required %s %s, available %s %s); ', COALESCE(v_addon_name, 'Add-on item'), v_addon.quantity + v_required, COALESCE(v_addon_unit, ''), COALESCE(v_available, 0), COALESCE(v_addon_unit, ''));
      END IF;
    END LOOP;
    IF v_problem <> '' THEN RAISE EXCEPTION 'Unable to start processing. Insufficient inventory: %', v_problem; END IF;
    FOR v_requirement IN SELECT r.*, i.current_stock FROM public.service_inventory_requirements r JOIN public.inventory_items i ON i.id = r.inventory_item_id
      WHERE r.branch_id = v_order.branch_id AND r.service_type_id = v_item.service_type_id AND r.is_active FOR UPDATE OF i LOOP
      v_required := CASE v_requirement.usage_basis WHEN 'per_kg' THEN COALESCE(v_item.weight_kg, 0) * v_requirement.quantity_per_unit
        WHEN 'per_piece' THEN v_item.quantity * v_requirement.quantity_per_unit ELSE v_requirement.quantity_per_unit END;
      IF v_required > 0 THEN
        INSERT INTO public.inventory_usage_log(item_id, quantity_used, order_id, order_item_id, service_inventory_requirement_id, deduction_key, reason)
        VALUES (v_requirement.inventory_item_id, v_required, v_order.id, v_item.id, v_requirement.id,
          'item:' || v_item.id || ':requirement:' || v_requirement.id, 'Automatic service consumption') ON CONFLICT (deduction_key) WHERE deduction_key IS NOT NULL DO NOTHING;
        IF FOUND THEN UPDATE public.inventory_items SET current_stock = current_stock - v_required WHERE id = v_requirement.inventory_item_id; END IF;
      END IF;
    END LOOP;
    FOR v_addon IN SELECT key AS item_id, value::NUMERIC AS quantity FROM jsonb_each_text(COALESCE(v_order.addons, '{}'::JSONB)) LOOP
      INSERT INTO public.inventory_usage_log(item_id, quantity_used, order_id, deduction_key, reason)
      VALUES (v_addon.item_id::UUID, v_addon.quantity, v_order.id, 'order:' || v_order.id || ':addon:' || v_addon.item_id, 'Order add-on consumption')
      ON CONFLICT (deduction_key) WHERE deduction_key IS NOT NULL DO NOTHING;
      IF FOUND THEN UPDATE public.inventory_items SET current_stock = current_stock - v_addon.quantity WHERE id = v_addon.item_id::UUID; END IF;
    END LOOP;
    UPDATE public.order_items SET status = 'on_process', processing_started_at = COALESCE(processing_started_at, now()), updated_at = now() WHERE id = v_item.id;
    UPDATE public.orders SET status = 'on_process', processing_started_at = COALESCE(processing_started_at, now()), last_updated_by_staff_id = p_staff_id, updated_at = now() WHERE id = v_order.id RETURNING * INTO v_result;
    RETURN v_result;
  ELSIF p_new_status = 'completed' AND v_item.status = 'on_process' THEN
    UPDATE public.order_items SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = v_item.id;
    IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_order.id AND status NOT IN ('completed', 'cancelled')) THEN
      UPDATE public.orders SET status = 'ready', ready_at = now(), actual_completion = now(), last_updated_by_staff_id = p_staff_id, updated_at = now() WHERE id = v_order.id RETURNING * INTO v_result;
    ELSE
      SELECT * INTO v_result FROM public.orders WHERE id = v_order.id;
    END IF;
    RETURN v_result;
  END IF;
  RAISE EXCEPTION 'Service items can only move from Received to On Process, then Completed';
END $$;

CREATE OR REPLACE FUNCTION public.transition_all_order_items(
  p_order_id UUID, p_staff_id UUID, p_new_status TEXT
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item RECORD; v_result public.orders;
BEGIN
  FOR v_item IN SELECT id FROM public.order_items WHERE order_id = p_order_id
    AND status = CASE WHEN p_new_status = 'on_process' THEN 'received' WHEN p_new_status = 'completed' THEN 'on_process' ELSE NULL END ORDER BY created_at LOOP
    SELECT * INTO v_result FROM public.transition_order_item(v_item.id, p_staff_id, p_new_status);
  END LOOP;
  IF v_result.id IS NULL THEN SELECT * INTO v_result FROM public.orders WHERE id = p_order_id; END IF;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_branch_order(UUID, UUID, JSONB, JSONB, JSONB, INTEGER, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.transition_order_item(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.transition_all_order_items(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_branch_order(UUID, UUID, JSONB, JSONB, JSONB, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_order_item(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_all_order_items(UUID, UUID, TEXT) TO service_role;
COMMIT;
