-- Run after 20260922_reenable_multi_service_orders.sql.
-- Hardens the configurable multi-service model: recipes can never consume
-- stock from another branch, and service price fields always have usable
-- values for the order-creation workflow.
BEGIN;

UPDATE public.service_types
SET pricing_type = COALESCE(NULLIF(pricing_type, ''), 'per_kg'),
    processing_type = COALESCE(NULLIF(processing_type, ''), 'full_service'),
    unit_price = COALESCE(unit_price, price_per_kg, 0)
WHERE pricing_type IS NULL
   OR pricing_type = ''
   OR processing_type IS NULL
   OR processing_type = ''
   OR unit_price IS NULL;

CREATE OR REPLACE FUNCTION public.validate_service_inventory_requirement()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_inventory_branch_id UUID;
BEGIN
  SELECT branch_id INTO v_inventory_branch_id
  FROM public.inventory_items
  WHERE id = NEW.inventory_item_id;

  IF v_inventory_branch_id IS NULL THEN
    RAISE EXCEPTION 'The selected inventory item does not exist';
  END IF;
  IF v_inventory_branch_id IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'A service recipe can only use inventory from the same branch';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tr_validate_service_inventory_requirement
  ON public.service_inventory_requirements;
CREATE TRIGGER tr_validate_service_inventory_requirement
BEFORE INSERT OR UPDATE OF branch_id, inventory_item_id, service_type_id, usage_basis, quantity_per_unit, is_active
ON public.service_inventory_requirements
FOR EACH ROW EXECUTE FUNCTION public.validate_service_inventory_requirement();

COMMIT;
