-- Keep the authenticated staff/admin identity attached to inventory edits and
-- restocks so their audit entries do not appear as automatic System changes.
BEGIN;

CREATE OR REPLACE FUNCTION public.update_inventory_item_with_actor(
  p_item_id UUID,
  p_updates JSONB,
  p_staff_id UUID
) RETURNS public.inventory_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory_items;
BEGIN
  IF p_item_id IS NULL OR p_staff_id IS NULL THEN
    RAISE EXCEPTION 'Inventory item and staff account are required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.staff
    WHERE id = p_staff_id AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'An active staff account is required';
  END IF;

  PERFORM set_config('app.audit_actor_staff_id', p_staff_id::TEXT, true);

  UPDATE public.inventory_items
  SET
    name = CASE WHEN p_updates ? 'name' THEN p_updates ->> 'name' ELSE name END,
    branch = CASE WHEN p_updates ? 'branch' THEN p_updates ->> 'branch' ELSE branch END,
    branch_id = CASE WHEN p_updates ? 'branch_id' THEN (p_updates ->> 'branch_id')::UUID ELSE branch_id END,
    unit = CASE WHEN p_updates ? 'unit' THEN p_updates ->> 'unit' ELSE unit END,
    current_stock = CASE WHEN p_updates ? 'current_stock' THEN (p_updates ->> 'current_stock')::NUMERIC ELSE current_stock END,
    minimum_stock = CASE WHEN p_updates ? 'minimum_stock' THEN (p_updates ->> 'minimum_stock')::NUMERIC ELSE minimum_stock END,
    cost_per_unit = CASE WHEN p_updates ? 'cost_per_unit' THEN (p_updates ->> 'cost_per_unit')::NUMERIC ELSE cost_per_unit END,
    updated_at = now()
  WHERE id = p_item_id
  RETURNING * INTO v_item;

  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Inventory item not found'; END IF;
  RETURN v_item;
END $$;

-- This actor-aware overload replaces the application's use of the older
-- four-argument restock function without breaking historical callers.
CREATE OR REPLACE FUNCTION public.restock_branch_inventory(
  p_item_id UUID,
  p_quantity NUMERIC,
  p_cost_total NUMERIC,
  p_supplier TEXT,
  p_staff_id UUID
) RETURNS public.inventory_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item public.inventory_items;
BEGIN
  IF p_quantity IS NULL OR p_quantity <= 0 THEN RAISE EXCEPTION 'Restock quantity must be greater than zero'; END IF;
  IF p_staff_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.staff WHERE id = p_staff_id AND deleted_at IS NULL
  ) THEN RAISE EXCEPTION 'An active staff account is required'; END IF;

  PERFORM set_config('app.audit_actor_staff_id', p_staff_id::TEXT, true);
  SELECT * INTO v_item FROM public.inventory_items WHERE id = p_item_id FOR UPDATE;
  IF v_item.id IS NULL THEN RAISE EXCEPTION 'Inventory item not found'; END IF;

  UPDATE public.inventory_items
  SET current_stock = current_stock + p_quantity
  WHERE id = p_item_id
  RETURNING * INTO v_item;

  INSERT INTO public.inventory_restocks(item_id, quantity_added, cost_total, supplier)
  VALUES (p_item_id, p_quantity, NULLIF(p_cost_total, 0), NULLIF(p_supplier, ''));

  IF COALESCE(p_cost_total, 0) > 0 THEN
    INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
    VALUES ('inventory', format('Restock: %s (%s %s)', v_item.name, p_quantity, v_item.unit),
      p_cost_total, CURRENT_DATE, v_item.branch, v_item.branch_id);
  END IF;
  RETURN v_item;
END $$;

REVOKE ALL ON FUNCTION public.update_inventory_item_with_actor(UUID, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restock_branch_inventory(UUID, NUMERIC, NUMERIC, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_inventory_item_with_actor(UUID, JSONB, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.restock_branch_inventory(UUID, NUMERIC, NUMERIC, TEXT, UUID) TO service_role;

COMMIT;
