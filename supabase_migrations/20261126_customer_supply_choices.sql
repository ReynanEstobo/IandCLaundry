-- Customer supply choices (panel suggestion, 26 November 2026).
--
-- A customer may want different supplies used on their laundry: another item
-- the shop stocks (for example a different detergent), their own supplies, or
-- none at all (for example no fabric conditioner). Each service still uses its
-- usual supplies unless staff change them on that order.
--
-- 1. order_item_supplies records each supply that was changed on an order.
-- 2. create_branch_order reads the changes sent with each service and takes
--    from stock only what is used. A replacement is any other item in the
--    same branch's stock. One counted in the same unit uses the usual amount;
--    one counted differently (for example mL instead of sachets) uses the
--    amount staff enter. With no changes the function works exactly as before.
-- 3. list_orders_page returns the changes with each service.
--
-- Prices do not change. Cancelling an order already returns every item taken
-- for it, replacements included. Safe to run more than once.
BEGIN;

-- 1. The supplies changed on each service of an order. Only changes are
--    stored; a service with no row here used its usual supplies.
CREATE TABLE IF NOT EXISTS public.order_item_supplies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_item_id UUID NOT NULL REFERENCES public.order_items(id) ON DELETE RESTRICT,
  branch_id UUID NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
  service_inventory_requirement_id UUID REFERENCES public.service_inventory_requirements(id) ON DELETE SET NULL,
  default_item_id UUID REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  default_item_name_snapshot TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('substitute', 'customer_own', 'none')),
  used_item_id UUID REFERENCES public.inventory_items(id) ON DELETE SET NULL,
  used_item_name_snapshot TEXT,
  quantity NUMERIC(12,2) NOT NULL CHECK (quantity >= 0),
  unit_snapshot TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT order_item_supplies_replacement_named CHECK ((choice = 'substitute') = (used_item_name_snapshot IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_order_item_supplies_order_item ON public.order_item_supplies(order_item_id);
ALTER TABLE public.order_item_supplies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_item_supplies FROM anon, authenticated;
GRANT SELECT, INSERT ON public.order_item_supplies TO service_role;

-- 2a. Checks the changes sent with one service and returns them in full:
--     which usual item is changed, what replaces it, and how much one load uses.
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
  v_requirement_id UUID; v_quantity NUMERIC;
  v_default_id UUID; v_default_name TEXT; v_default_unit TEXT;
  v_item_id UUID; v_item_name TEXT; v_item_unit TEXT; v_amount NUMERIC;
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

    SELECT r.id, r.quantity_per_load, i.id, i.name, i.unit
    INTO v_requirement_id, v_quantity, v_default_id, v_default_name, v_default_unit
    FROM public.service_inventory_requirements r
    JOIN public.inventory_items i ON i.id = r.inventory_item_id
    WHERE r.id = NULLIF(v_entry->>'requirement_id', '')::UUID
      AND r.branch_id = p_branch_id
      AND r.service_type_id = p_service_type_id
      AND r.is_active IS TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'A supply choice no longer matches this service. Refresh the order form and try again.';
    END IF;
    IF v_requirement_id = ANY(v_seen) THEN
      RAISE EXCEPTION '% was changed more than once for the same service', v_default_name;
    END IF;
    v_seen := v_seen || v_requirement_id;

    v_item_id := NULL; v_item_name := NULL; v_item_unit := v_default_unit; v_amount := NULL;
    IF v_choice = 'substitute' THEN
      SELECT i.id, i.name, i.unit
      INTO v_item_id, v_item_name, v_item_unit
      FROM public.inventory_items i
      WHERE i.id = NULLIF(v_entry->>'item_id', '')::UUID
        AND i.branch_id = p_branch_id
        AND i.deleted_at IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'The replacement for % is not available at this branch', v_default_name;
      END IF;
      IF v_item_id = v_default_id THEN
        RAISE EXCEPTION 'Choose an item other than % to replace it', v_default_name;
      END IF;
      IF EXISTS (
        SELECT 1 FROM public.service_inventory_requirements other
        WHERE other.branch_id = p_branch_id AND other.service_type_id = p_service_type_id
          AND other.is_active IS TRUE AND other.inventory_item_id = v_item_id
      ) THEN
        RAISE EXCEPTION '% is already one of this service''s usual supplies. Choose another item to replace %',
          v_item_name, v_default_name;
      END IF;
      -- An item counted like the usual one uses the usual amount unless staff
      -- enter another; one counted differently needs the amount entered.
      v_amount := NULLIF(btrim(COALESCE(v_entry->>'quantity', '')), '')::NUMERIC;
      IF v_amount IS NULL AND v_item_unit IS DISTINCT FROM v_default_unit THEN
        RAISE EXCEPTION '% is counted in %, not %. Enter how much % to use.',
          v_item_name, v_item_unit, v_default_unit, v_item_name;
      END IF;
      IF v_amount IS NOT NULL AND v_amount <= 0 THEN
        RAISE EXCEPTION 'Enter an amount of % greater than zero', v_item_name;
      END IF;
      IF v_amount IS NOT NULL AND lower(btrim(v_item_unit)) IN ('pcs', 'packs', 'bottles', 'sachets')
        AND v_amount <> trunc(v_amount) THEN
        RAISE EXCEPTION 'The amount of % must be a whole number because it is counted in %',
          v_item_name, v_item_unit;
      END IF;
    END IF;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'requirement_id', v_requirement_id, 'choice', v_choice,
      'default_item_id', v_default_id, 'default_item_name', v_default_name,
      'item_id', v_item_id, 'item_name', v_item_name,
      'quantity_per_load', v_quantity, 'quantity', v_amount, 'unit', v_item_unit
    ));
  END LOOP;
  RETURN v_result;
END $$;

-- 2b. The item to take from stock for one usual supply: the usual item, its
--     replacement, or nothing when the customer brought their own or left it out.
CREATE OR REPLACE FUNCTION public.order_supply_item_to_deduct(
  p_supplies JSONB,
  p_requirement_id UUID,
  p_default_item_id UUID
) RETURNS UUID
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN chosen.supply IS NULL THEN p_default_item_id
    WHEN chosen.supply->>'choice' = 'substitute' THEN NULLIF(chosen.supply->>'item_id', '')::UUID
    ELSE NULL
  END
  FROM (
    SELECT (
      SELECT value
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_supplies) = 'array' THEN p_supplies ELSE '[]'::JSONB END)
      WHERE value->>'requirement_id' = p_requirement_id::TEXT
      LIMIT 1
    ) AS supply
  ) AS chosen
$$;

-- 2c. How much to take for one usual supply on this service: the amount
--     entered for a replacement, otherwise the usual amount.
CREATE OR REPLACE FUNCTION public.order_supply_quantity(
  p_supplies JSONB,
  p_requirement_id UUID,
  p_usual_quantity NUMERIC
) RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    (
      SELECT NULLIF(value->>'quantity', '')::NUMERIC
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_supplies) = 'array' THEN p_supplies ELSE '[]'::JSONB END)
      WHERE value->>'requirement_id' = p_requirement_id::TEXT AND value->>'choice' = 'substitute'
      LIMIT 1
    ),
    p_usual_quantity
  )
$$;

REVOKE ALL ON FUNCTION public.resolve_order_item_supplies(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_supply_item_to_deduct(JSONB, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_supply_quantity(JSONB, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_order_item_supplies(UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_supply_item_to_deduct(JSONB, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.order_supply_quantity(JSONB, UUID, NUMERIC) TO service_role;

-- 2d. Order creation. Four parts of the current function change; each must be
--     found exactly once or nothing is changed.
DO $$
DECLARE
  v_signature CONSTANT TEXT := 'public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)';
  v_definition TEXT;
  v_old TEXT; v_new TEXT;
  v_parts TEXT[][] := ARRAY[
    -- Keep each service's checked supply changes with the service.
    ARRAY[$old1$      'subtotal', v_subtotal
    ));$old1$,
    $new1$      'subtotal', v_subtotal,
      'supplies', public.resolve_order_item_supplies(p_branch_id, v_service.id, v_entry->'supplies')
    ));$new1$],
    -- Check stock for the items actually used.
    ARRAY[$old2$        SELECT r.inventory_item_id,
          r.quantity_per_load * (resolved.item->>'loads')::INTEGER AS required_quantity
        FROM jsonb_array_elements(v_resolved) AS resolved(item)
        JOIN public.service_inventory_requirements r
          ON r.service_type_id = (resolved.item->>'service_type_id')::UUID
         AND r.branch_id = p_branch_id
         AND r.is_active IS TRUE
        UNION ALL$old2$,
    $new2$        SELECT supply.item_id AS inventory_item_id,
          public.order_supply_quantity(resolved.item->'supplies', r.id,
            r.quantity_per_load * (resolved.item->>'loads')::INTEGER) AS required_quantity
        FROM jsonb_array_elements(v_resolved) AS resolved(item)
        JOIN public.service_inventory_requirements r
          ON r.service_type_id = (resolved.item->>'service_type_id')::UUID
         AND r.branch_id = p_branch_id
         AND r.is_active IS TRUE
        CROSS JOIN LATERAL (
          SELECT public.order_supply_item_to_deduct(resolved.item->'supplies', r.id, r.inventory_item_id) AS item_id
        ) supply
        WHERE supply.item_id IS NOT NULL
        UNION ALL$new2$],
    -- Take from stock only the items actually used.
    ARRAY[$old3$    FOR v_requirement IN
      SELECT r.*, i.name, i.unit, i.current_stock FROM public.service_inventory_requirements r
      JOIN public.inventory_items i ON i.id = r.inventory_item_id
      WHERE r.branch_id = p_branch_id AND r.service_type_id = (v_entry->>'service_type_id')::UUID
        AND r.is_active IS TRUE AND i.deleted_at IS NULL FOR UPDATE OF i
    LOOP
      v_required := v_requirement.quantity_per_load * (v_entry->>'loads')::INTEGER;$old3$,
    $new3$    FOR v_requirement IN
      SELECT r.id, r.quantity_per_load, i.id AS inventory_item_id, i.name, i.unit, i.current_stock
      FROM public.service_inventory_requirements r
      CROSS JOIN LATERAL (
        SELECT public.order_supply_item_to_deduct(v_entry->'supplies', r.id, r.inventory_item_id) AS item_id
      ) supply
      JOIN public.inventory_items i ON i.id = supply.item_id
      WHERE r.branch_id = p_branch_id AND r.service_type_id = (v_entry->>'service_type_id')::UUID
        AND r.is_active IS TRUE AND i.deleted_at IS NULL FOR UPDATE OF i
    LOOP
      v_required := public.order_supply_quantity(v_entry->'supplies', v_requirement.id,
        v_requirement.quantity_per_load * (v_entry->>'loads')::INTEGER);$new3$],
    -- Record the changes made to this service.
    ARRAY[$old4$        'Automatic service consumption');
    END LOOP;
  END LOOP;$old4$,
    $new4$        'Automatic service consumption');
    END LOOP;
    INSERT INTO public.order_item_supplies(order_item_id, branch_id, service_inventory_requirement_id,
      default_item_id, default_item_name_snapshot, choice, used_item_id, used_item_name_snapshot,
      quantity, unit_snapshot)
    SELECT v_order_item_id, p_branch_id, (chosen.supply->>'requirement_id')::UUID,
      (chosen.supply->>'default_item_id')::UUID, chosen.supply->>'default_item_name', chosen.supply->>'choice',
      NULLIF(chosen.supply->>'item_id', '')::UUID, NULLIF(chosen.supply->>'item_name', ''),
      COALESCE(NULLIF(chosen.supply->>'quantity', '')::NUMERIC,
        (chosen.supply->>'quantity_per_load')::NUMERIC * (v_entry->>'loads')::INTEGER), chosen.supply->>'unit'
    FROM jsonb_array_elements(COALESCE(v_entry->'supplies', '[]'::JSONB)) AS chosen(supply);
  END LOOP;$new4$]
  ];
  v_part INTEGER;
BEGIN
  IF to_regprocedure(v_signature) IS NULL THEN RETURN; END IF;
  v_definition := replace(pg_get_functiondef(v_signature::regprocedure), E'\r', '');
  IF position('order_item_supplies' IN v_definition) > 0 THEN RETURN; END IF;
  FOR v_part IN 1 .. array_length(v_parts, 1) LOOP
    v_old := replace(v_parts[v_part][1], E'\r', '');
    v_new := replace(v_parts[v_part][2], E'\r', '');
    IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'Stopped: part % of create_branch_order was not found exactly once. Nothing was changed.', v_part;
    END IF;
    v_definition := replace(v_definition, v_old, v_new);
  END LOOP;
  EXECUTE v_definition;
END $$;

-- 3. The Orders list returns each service's supply changes beside its add-ons.
DO $$
DECLARE
  v_signature CONSTANT TEXT := 'public.list_orders_page(uuid,text,text,integer,integer)';
  v_old CONSTANT TEXT := 'to_jsonb(oi) || jsonb_build_object(''order_item_addons'', COALESCE((';
  v_new CONSTANT TEXT := 'to_jsonb(oi) || jsonb_build_object(''order_item_supplies'', COALESCE((
              SELECT jsonb_agg(to_jsonb(os) ORDER BY os.created_at)
              FROM public.order_item_supplies os
              WHERE os.order_item_id = oi.id
            ), ''[]''::jsonb), ''order_item_addons'', COALESCE((';
  v_definition TEXT;
BEGIN
  IF to_regprocedure(v_signature) IS NULL THEN RETURN; END IF;
  v_definition := replace(pg_get_functiondef(v_signature::regprocedure), E'\r', '');
  IF position('order_item_supplies' IN v_definition) > 0 THEN RETURN; END IF;
  IF position(v_old IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Stopped: the expected add-on list in list_orders_page was not found. Nothing was changed.';
  END IF;
  EXECUTE replace(v_definition, v_old, replace(v_new, E'\r', ''));
END $$;

COMMIT;
