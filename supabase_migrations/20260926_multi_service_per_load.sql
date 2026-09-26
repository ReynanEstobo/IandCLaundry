-- Run after 20260925_rollback_to_single_service_orders.sql.
-- Adds multi-service orders with service-specific per-load pricing,
-- branch-specific inventory recipes/add-ons, and idempotent stock deduction.
BEGIN;

CREATE TEMP TABLE multi_service_migration_state ON COMMIT DROP AS
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'service_types' AND column_name = 'bundle_price'
) AS initialise_existing_service_prices;

ALTER TABLE public.service_types
  ADD COLUMN IF NOT EXISTS bundle_kg NUMERIC(10,2) NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS bundle_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS excess_kg_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS processing_type TEXT NOT NULL DEFAULT 'full_service',
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.service_types DROP CONSTRAINT IF EXISTS service_types_bundle_kg_check;
ALTER TABLE public.service_types ADD CONSTRAINT service_types_bundle_kg_check CHECK (bundle_kg > 0);
ALTER TABLE public.service_types DROP CONSTRAINT IF EXISTS service_types_bundle_price_check;
ALTER TABLE public.service_types ADD CONSTRAINT service_types_bundle_price_check CHECK (bundle_price >= 0);
ALTER TABLE public.service_types DROP CONSTRAINT IF EXISTS service_types_excess_kg_price_check;
ALTER TABLE public.service_types ADD CONSTRAINT service_types_excess_kg_price_check CHECK (excess_kg_price >= 0);
ALTER TABLE public.service_types DROP CONSTRAINT IF EXISTS service_types_processing_type_check;
ALTER TABLE public.service_types ADD CONSTRAINT service_types_processing_type_check
  CHECK (processing_type IN ('full_service', 'air_dry_only'));

-- Use the old Settings price to initialise existing services. Administrators
-- can then customise every service without changing historical orders.
UPDATE public.service_types s
SET bundle_kg = COALESCE(NULLIF(s.bundle_kg, 0), cfg.bundlekg, 8),
    bundle_price = CASE WHEN s.bundle_price = 0 THEN COALESCE(cfg.bundleprice, 200) ELSE s.bundle_price END,
    excess_kg_price = CASE WHEN s.excess_kg_price = 0 THEN COALESCE(cfg.excesskgprice, 30) ELSE s.excess_kg_price END,
    updated_at = now()
FROM (SELECT bundlekg, bundleprice, excesskgprice FROM public.settings LIMIT 1) cfg
WHERE (SELECT initialise_existing_service_prices FROM multi_service_migration_state);

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS client_request_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS orders_client_request_id_unique
  ON public.orders(client_request_id) WHERE client_request_id IS NOT NULL;

-- Preserve historical clients while requiring every new or edited client to
-- have a valid email address.
ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_email_format_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_email_format_check
  CHECK (email IS NOT NULL AND trim(email) <> ''
    AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') NOT VALID;

CREATE TABLE IF NOT EXISTS public.order_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  service_type_id UUID REFERENCES public.service_types(id) ON DELETE RESTRICT,
  service_name_snapshot TEXT NOT NULL,
  pricing_type_snapshot TEXT NOT NULL DEFAULT 'bundle' CHECK (pricing_type_snapshot IN ('bundle', 'legacy')),
  bundle_kg_snapshot NUMERIC(10,2) NOT NULL,
  bundle_price_snapshot NUMERIC(12,2) NOT NULL,
  excess_kg_price_snapshot NUMERIC(12,2) NOT NULL,
  processing_type_snapshot TEXT NOT NULL CHECK (processing_type_snapshot IN ('full_service', 'air_dry_only', 'legacy')),
  weight_kg NUMERIC(10,2) NOT NULL CHECK (weight_kg > 0),
  quantity NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  loads INTEGER NOT NULL CHECK (loads > 0),
  unit_price_snapshot NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price_snapshot >= 0),
  subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'on_process', 'completed', 'cancelled')),
  notes TEXT,
  processing_started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_updated_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_branch_status ON public.order_items(branch_id, status);

CREATE TABLE IF NOT EXISTS public.service_inventory_requirements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  service_type_id UUID NOT NULL REFERENCES public.service_types(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  quantity_per_load NUMERIC(12,4) NOT NULL CHECK (quantity_per_load > 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(branch_id, service_type_id, inventory_item_id)
);
CREATE INDEX IF NOT EXISTS idx_service_inventory_requirements_lookup
  ON public.service_inventory_requirements(branch_id, service_type_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.service_addon_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  service_type_id UUID NOT NULL REFERENCES public.service_types(id) ON DELETE CASCADE,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  unit_price NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(branch_id, service_type_id, inventory_item_id)
);
CREATE INDEX IF NOT EXISTS idx_service_addon_items_lookup
  ON public.service_addon_items(branch_id, service_type_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.order_item_addons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_item_id UUID NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  service_addon_item_id UUID REFERENCES public.service_addon_items(id) ON DELETE SET NULL,
  inventory_item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  item_name_snapshot TEXT NOT NULL,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  unit_price_snapshot NUMERIC(12,2) NOT NULL CHECK (unit_price_snapshot >= 0),
  subtotal NUMERIC(12,2) NOT NULL CHECK (subtotal >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.inventory_usage_log
  ADD COLUMN IF NOT EXISTS order_item_id UUID REFERENCES public.order_items(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS service_inventory_requirement_id UUID REFERENCES public.service_inventory_requirements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deduction_key TEXT,
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'Automatic service consumption';
CREATE UNIQUE INDEX IF NOT EXISTS inventory_usage_log_deduction_key_unique
  ON public.inventory_usage_log(deduction_key) WHERE deduction_key IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_service_inventory_configuration()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item_branch UUID;
BEGIN
  SELECT branch_id INTO v_item_branch FROM public.inventory_items
  WHERE id = NEW.inventory_item_id AND deleted_at IS NULL;
  IF v_item_branch IS NULL THEN RAISE EXCEPTION 'The selected inventory item does not exist'; END IF;
  IF v_item_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'Service inventory must belong to the selected branch';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tr_validate_service_inventory_requirement ON public.service_inventory_requirements;
CREATE TRIGGER tr_validate_service_inventory_requirement
BEFORE INSERT OR UPDATE ON public.service_inventory_requirements
FOR EACH ROW EXECUTE FUNCTION public.validate_service_inventory_configuration();
DROP TRIGGER IF EXISTS tr_validate_service_addon_item ON public.service_addon_items;
CREATE TRIGGER tr_validate_service_addon_item
BEFORE INSERT OR UPDATE ON public.service_addon_items
FOR EACH ROW EXECUTE FUNCTION public.validate_service_inventory_configuration();

ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_item_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_inventory_requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_addon_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated order item read access" ON public.order_items;
CREATE POLICY "Authenticated order item read access" ON public.order_items FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Authenticated order item add-on read access" ON public.order_item_addons;
CREATE POLICY "Authenticated order item add-on read access" ON public.order_item_addons FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Authenticated service recipe read access" ON public.service_inventory_requirements;
CREATE POLICY "Authenticated service recipe read access" ON public.service_inventory_requirements FOR SELECT USING (auth.role() = 'authenticated');
DROP POLICY IF EXISTS "Authenticated service add-on read access" ON public.service_addon_items;
CREATE POLICY "Authenticated service add-on read access" ON public.service_addon_items FOR SELECT USING (auth.role() = 'authenticated');

DROP TRIGGER IF EXISTS tr_audit_order_items ON public.order_items;
CREATE TRIGGER tr_audit_order_items AFTER INSERT OR UPDATE OR DELETE ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_service_inventory_requirements ON public.service_inventory_requirements;
CREATE TRIGGER tr_audit_service_inventory_requirements AFTER INSERT OR UPDATE OR DELETE ON public.service_inventory_requirements
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_service_addon_items ON public.service_addon_items;
CREATE TRIGGER tr_audit_service_addon_items AFTER INSERT OR UPDATE OR DELETE ON public.service_addon_items
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();

-- Existing orders become immutable legacy items and are never deducted again.
INSERT INTO public.order_items(order_id, branch_id, service_type_id, service_name_snapshot, pricing_type_snapshot,
  bundle_kg_snapshot, bundle_price_snapshot, excess_kg_price_snapshot, processing_type_snapshot,
  weight_kg, quantity, loads, unit_price_snapshot, subtotal, status, processing_started_at, completed_at,
  last_updated_by_staff_id, created_at, updated_at)
SELECT o.id, o.branch_id, o.service_type_id, COALESCE(s.name, 'Legacy laundry service'), 'legacy',
  GREATEST(COALESCE(cfg.bundlekg, 8), 1), COALESCE(o.total_price, 0), 0, 'legacy',
  GREATEST(COALESCE(NULLIF(o.weight_kg, 0), 1), 0.01), 1, 1, COALESCE(o.total_price, 0), COALESCE(o.total_price, 0),
  CASE o.status WHEN 'on_process' THEN 'on_process' WHEN 'ready' THEN 'completed'
    WHEN 'released' THEN 'completed' WHEN 'cancelled' THEN 'cancelled' ELSE 'received' END,
  o.processing_started_at,
  CASE WHEN o.status IN ('ready', 'released') THEN COALESCE(o.ready_at, o.actual_completion, o.updated_at) END,
  COALESCE(o.last_updated_by_staff_id, o.created_by_staff_id), o.created_at, COALESCE(o.updated_at, o.created_at)
FROM public.orders o
LEFT JOIN public.service_types s ON s.id = o.service_type_id
CROSS JOIN (SELECT bundlekg FROM public.settings LIMIT 1) cfg
WHERE o.branch_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.order_id = o.id);

CREATE OR REPLACE FUNCTION public.cancel_order_service_items()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE public.order_items SET status = 'cancelled', updated_at = now(),
      last_updated_by_staff_id = NEW.cancelled_by_staff_id
    WHERE order_id = NEW.id AND status <> 'cancelled';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tr_cancel_order_service_items ON public.orders;
CREATE TRIGGER tr_cancel_order_service_items AFTER UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.cancel_order_service_items();

-- Keep service-item stages aligned when an authorised order-stage correction
-- moves the parent order backward. Inventory is deducted when the order is
-- created, so a stage correction must not deduct or restore stock.
CREATE OR REPLACE FUNCTION public.sync_order_service_items_after_correction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old_rank INTEGER; v_new_rank INTEGER;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status OR NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  v_old_rank := CASE OLD.status WHEN 'received' THEN 1 WHEN 'on_process' THEN 2 WHEN 'ready' THEN 3 WHEN 'released' THEN 4 ELSE 0 END;
  v_new_rank := CASE NEW.status WHEN 'received' THEN 1 WHEN 'on_process' THEN 2 WHEN 'ready' THEN 3 WHEN 'released' THEN 4 ELSE 0 END;
  IF v_new_rank >= v_old_rank THEN RETURN NEW; END IF;

  IF NEW.status = 'received' THEN
    UPDATE public.order_items
    SET status = 'received', processing_started_at = NULL, completed_at = NULL,
        last_updated_by_staff_id = NEW.last_updated_by_staff_id, updated_at = now()
    WHERE order_id = NEW.id AND status <> 'cancelled';
  ELSIF NEW.status = 'on_process' THEN
    UPDATE public.order_items
    SET status = 'on_process', processing_started_at = COALESCE(processing_started_at, now()),
        completed_at = NULL, last_updated_by_staff_id = NEW.last_updated_by_staff_id, updated_at = now()
    WHERE order_id = NEW.id AND status = 'completed';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tr_sync_order_service_items_after_correction ON public.orders;
CREATE TRIGGER tr_sync_order_service_items_after_correction
AFTER UPDATE OF status ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.sync_order_service_items_after_correction();

CREATE OR REPLACE FUNCTION public.register_branch_customer(
  p_branch_id UUID, p_staff_id UUID, p_name TEXT, p_phone TEXT,
  p_email TEXT, p_notes TEXT
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
    RAISE EXCEPTION 'You can only register clients for your assigned branch';
  END IF;
  SELECT name INTO v_branch_name FROM public.branches
  WHERE id = p_branch_id AND is_active IS TRUE;
  IF v_branch_name IS NULL THEN RAISE EXCEPTION 'Selected branch does not exist or is inactive'; END IF;

  SELECT * INTO v_customer FROM public.customers
  WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(p_phone, '[^0-9]', '', 'g')
  LIMIT 1 FOR UPDATE;
  IF v_customer.id IS NULL THEN
    INSERT INTO public.customers(name, phone, email, notes, branch, branch_id, created_by_staff_id)
    VALUES (trim(p_name), trim(p_phone), lower(trim(p_email)), NULLIF(trim(p_notes), ''),
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

-- Reinstall cancellation with database-level staff authorization, deterministic
-- inventory locking, and explicit stage-history metadata. The audit row and all
-- stock returns are in the same transaction, so either all of them commit or
-- none of them do.
CREATE OR REPLACE FUNCTION public.cancel_branch_order(
  p_order_id UUID, p_staff_id UUID, p_reason TEXT
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_order public.orders; v_usage RECORD; v_item RECORD; v_actor RECORD; v_before JSONB;
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

  FOR v_item IN
    SELECT i.id FROM public.inventory_items i
    WHERE i.id IN (
      SELECT u.item_id FROM public.inventory_usage_log u
      WHERE u.order_id = p_order_id AND u.reversed_at IS NULL
    )
    ORDER BY i.id FOR UPDATE OF i
  LOOP NULL; END LOOP;

  FOR v_usage IN
    SELECT * FROM public.inventory_usage_log
    WHERE order_id = p_order_id AND reversed_at IS NULL
    ORDER BY item_id, id FOR UPDATE
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
      stage_started_at = NULL, updated_at = now()
  WHERE id = p_order_id RETURNING * INTO v_order;

  INSERT INTO public.audit_logs(action, table_name, record_id, actor_staff_id, branch_id, before_data, after_data)
  VALUES ('cancel', 'orders', p_order_id, p_staff_id, v_order.branch_id, v_before, to_jsonb(v_order));
  RETURN v_order;
END $$;

CREATE OR REPLACE FUNCTION public.create_branch_order(
  p_branch_id UUID, p_staff_id UUID, p_customer JSONB, p_order JSONB,
  p_addons JSONB, p_loads INTEGER, p_loyalty_reward_id UUID DEFAULT NULL
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_customer_id UUID; v_customer_email TEXT; v_branch_name TEXT; v_order public.orders; v_service public.service_types;
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
  IF COALESCE(trim(p_customer->>'phone'), '') = '' OR COALESCE(trim(p_customer->>'name'), '') = ''
    OR COALESCE(trim(p_customer->>'email'), '') = '' THEN
    RAISE EXCEPTION 'Customer name, phone, and email are required';
  END IF;
  IF trim(p_customer->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
    RAISE EXCEPTION 'Enter a valid customer email';
  END IF;
  v_amount_paid := COALESCE(NULLIF(p_order->>'amount_paid', '')::NUMERIC, 0);
  IF v_amount_paid < 0 THEN RAISE EXCEPTION 'A valid payment amount is required'; END IF;

  SELECT id, email INTO v_customer_id, v_customer_email FROM public.customers
  WHERE regexp_replace(phone, '[^0-9]', '', 'g') = regexp_replace(trim(p_customer->>'phone'), '[^0-9]', '', 'g')
  LIMIT 1 FOR UPDATE;
  IF v_customer_id IS NULL THEN
    INSERT INTO public.customers(name, phone, email, notes, branch, branch_id, created_by_staff_id)
    VALUES (trim(p_customer->>'name'), trim(p_customer->>'phone'), NULLIF(trim(p_customer->>'email'), ''),
      NULLIF(trim(p_customer->>'notes'), ''), v_branch_name, p_branch_id, p_staff_id)
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
      'subtotal', v_subtotal, 'notes', NULLIF(trim(v_entry->>'notes'), '')
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

  INSERT INTO public.orders(customer_id, service_type_id, weight_kg, total_price, addons, notes, payment_method,
    payment_status, amount_paid, branch, branch_id, created_by_staff_id, last_updated_by_staff_id, status,
    estimated_processing_minutes, eta_source, estimated_ready_at, loyalty_original_total,
    loyalty_discount_amount, client_request_id)
  VALUES (v_customer_id, v_first_service, v_total_weight, v_final_total, COALESCE(p_addons, '{}'::JSONB),
    NULLIF(p_order->>'notes', ''), COALESCE(NULLIF(p_order->>'payment_method', ''), 'cash'),
    CASE WHEN v_amount_paid >= v_final_total THEN 'paid' ELSE 'partial' END, v_amount_paid,
    v_branch_name, p_branch_id, p_staff_id, p_staff_id, 'received', GREATEST(v_eta_minutes, 1),
    v_eta_source, now() + make_interval(mins => GREATEST(v_eta_minutes, 1)), v_raw_total,
    v_discount, v_request_id)
  RETURNING * INTO v_order;

  FOR v_entry IN SELECT value FROM jsonb_array_elements(v_resolved) LOOP
    INSERT INTO public.order_items(order_id, branch_id, service_type_id, service_name_snapshot, pricing_type_snapshot,
      bundle_kg_snapshot, bundle_price_snapshot, excess_kg_price_snapshot, processing_type_snapshot,
      weight_kg, quantity, loads, unit_price_snapshot, subtotal, notes, last_updated_by_staff_id)
    VALUES (v_order.id, p_branch_id, (v_entry->>'service_type_id')::UUID, v_entry->>'name', 'bundle',
      (v_entry->>'bundle_kg')::NUMERIC, (v_entry->>'bundle_price')::NUMERIC,
      (v_entry->>'excess_kg_price')::NUMERIC, v_entry->>'processing_type',
      (v_entry->>'weight_kg')::NUMERIC, 1, (v_entry->>'loads')::INTEGER,
      (v_entry->>'bundle_price')::NUMERIC, (v_entry->>'subtotal')::NUMERIC,
      NULLIF(v_entry->>'notes', ''), p_staff_id)
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

CREATE OR REPLACE FUNCTION public.transition_order_item(
  p_order_item_id UUID, p_staff_id UUID, p_new_status TEXT
) RETURNS public.orders
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_item public.order_items; v_order public.orders; v_actor RECORD; v_result public.orders;
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
    UPDATE public.order_items SET status = 'on_process', processing_started_at = COALESCE(processing_started_at, now()),
      updated_at = now(), last_updated_by_staff_id = p_staff_id WHERE id = v_item.id;
    UPDATE public.orders SET status = 'on_process', processing_started_at = COALESCE(processing_started_at, now()),
      last_updated_by_staff_id = p_staff_id, updated_at = now() WHERE id = v_order.id RETURNING * INTO v_result;
    RETURN v_result;
  ELSIF p_new_status = 'completed' AND v_item.status = 'on_process' THEN
    UPDATE public.order_items SET status = 'completed', completed_at = now(), updated_at = now(),
      last_updated_by_staff_id = p_staff_id WHERE id = v_item.id;
    IF NOT EXISTS (SELECT 1 FROM public.order_items WHERE order_id = v_order.id AND status NOT IN ('completed', 'cancelled')) THEN
      UPDATE public.orders SET status = 'ready', ready_at = now(), actual_completion = now(),
        last_updated_by_staff_id = p_staff_id, updated_at = now() WHERE id = v_order.id RETURNING * INTO v_result;
    ELSE SELECT * INTO v_result FROM public.orders WHERE id = v_order.id; END IF;
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
    AND status = CASE WHEN p_new_status = 'on_process' THEN 'received'
      WHEN p_new_status = 'completed' THEN 'on_process' ELSE NULL END ORDER BY created_at
  LOOP SELECT * INTO v_result FROM public.transition_order_item(v_item.id, p_staff_id, p_new_status); END LOOP;
  IF v_result.id IS NULL THEN SELECT * INTO v_result FROM public.orders WHERE id = p_order_id; END IF;
  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.create_branch_order(UUID, UUID, JSONB, JSONB, JSONB, INTEGER, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.cancel_branch_order(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.transition_order_item(UUID, UUID, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.transition_all_order_items(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_branch_order(UUID, UUID, JSONB, JSONB, JSONB, INTEGER, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_branch_customer(UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_branch_order(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_order_item(UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.transition_all_order_items(UUID, UUID, TEXT) TO service_role;

COMMIT;
