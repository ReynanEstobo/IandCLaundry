-- Create an inventory item and record its opening stock/cost atomically.
BEGIN;

CREATE OR REPLACE FUNCTION public.create_branch_inventory_item(
  p_branch_id UUID,
  p_staff_id UUID,
  p_name TEXT,
  p_unit TEXT,
  p_quantity NUMERIC,
  p_minimum_stock NUMERIC,
  p_cost_total NUMERIC,
  p_supplier TEXT
) RETURNS public.inventory_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_branch public.branches;
  v_item public.inventory_items;
  v_name TEXT := btrim(COALESCE(p_name, ''));
  v_cost NUMERIC := COALESCE(p_cost_total, 0);
  v_quantity NUMERIC := COALESCE(p_quantity, 0);
BEGIN
  IF p_branch_id IS NULL OR p_staff_id IS NULL THEN
    RAISE EXCEPTION 'A branch and authenticated staff profile are required.';
  END IF;
  IF v_name = '' OR char_length(v_name) > 120 THEN
    RAISE EXCEPTION 'Inventory item name is required and must be at most 120 characters.';
  END IF;
  IF p_unit NOT IN ('pcs', 'kg', 'L', 'mL', 'g', 'packs', 'bottles', 'sachets') THEN
    RAISE EXCEPTION 'Choose a valid inventory unit.';
  END IF;
  IF v_quantity < 0 OR COALESCE(p_minimum_stock, 0) < 0 OR v_cost < 0 THEN
    RAISE EXCEPTION 'Stock quantities and total cost cannot be negative.';
  END IF;
  IF v_cost > 0 AND v_quantity <= 0 THEN
    RAISE EXCEPTION 'Initial stock must be greater than zero when a cost is recorded.';
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = p_branch_id;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'The selected branch does not exist.';
  END IF;

  PERFORM set_config('app.audit_actor_staff_id', p_staff_id::TEXT, true);

  INSERT INTO public.inventory_items
    (name, unit, current_stock, minimum_stock, cost_per_unit, branch_id, branch)
  VALUES (
    v_name, p_unit, v_quantity, COALESCE(p_minimum_stock, 0),
    CASE WHEN v_quantity > 0 THEN round(v_cost / v_quantity, 2) ELSE 0 END,
    v_branch.id, v_branch.name
  )
  RETURNING * INTO v_item;

  IF v_quantity > 0 THEN
    INSERT INTO public.inventory_restocks(item_id, quantity_added, cost_total, supplier)
    VALUES (v_item.id, v_quantity, NULLIF(v_cost, 0), NULLIF(btrim(COALESCE(p_supplier, '')), ''));
  END IF;

  IF v_cost > 0 THEN
    INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
    VALUES (
      'inventory',
      format('Initial stock: %s (%s %s)', v_item.name, v_quantity, v_item.unit),
      v_cost, CURRENT_DATE, v_branch.name, v_branch.id
    );
  END IF;

  RETURN v_item;
END;
$$;

REVOKE ALL ON FUNCTION public.create_branch_inventory_item(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_branch_inventory_item(UUID, UUID, TEXT, TEXT, NUMERIC, NUMERIC, NUMERIC, TEXT) TO service_role;

COMMIT;
