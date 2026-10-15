-- Keep service inventory configurations branch-safe throughout their lifecycle
-- and validate add-on rows at the final database write boundary.
BEGIN;

CREATE OR REPLACE FUNCTION public.delink_configured_inventory_before_archive_or_move()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.branch_id IS DISTINCT FROM OLD.branch_id)
     OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN
    IF EXISTS (
      SELECT 1 FROM public.service_inventory_requirements r
      WHERE r.inventory_item_id = OLD.id AND r.is_active IS TRUE
      UNION ALL
      SELECT 1 FROM public.service_addon_items a
      WHERE a.inventory_item_id = OLD.id AND a.is_active IS TRUE
    ) THEN
      UPDATE public.service_inventory_requirements
      SET is_active = FALSE, updated_at = now()
      WHERE inventory_item_id = OLD.id AND is_active IS TRUE;

      UPDATE public.service_addon_items
      SET is_active = FALSE, updated_at = now()
      WHERE inventory_item_id = OLD.id AND is_active IS TRUE;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_prevent_configured_inventory_archive_or_move ON public.inventory_items;
DROP TRIGGER IF EXISTS tr_delink_configured_inventory_before_archive_or_move ON public.inventory_items;
CREATE TRIGGER tr_delink_configured_inventory_before_archive_or_move
BEFORE UPDATE OF branch_id, deleted_at ON public.inventory_items
FOR EACH ROW EXECUTE FUNCTION public.delink_configured_inventory_before_archive_or_move();

CREATE OR REPLACE FUNCTION public.validate_order_item_addon_branch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.service_addon_item_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.order_items oi
    JOIN public.service_addon_items a
      ON a.id = NEW.service_addon_item_id
     AND a.branch_id = NEW.branch_id
     AND a.service_type_id = oi.service_type_id
     AND a.inventory_item_id = NEW.inventory_item_id
     AND a.is_active IS TRUE
    JOIN public.inventory_items i
      ON i.id = NEW.inventory_item_id
     AND i.branch_id = NEW.branch_id
     AND i.deleted_at IS NULL
    WHERE oi.id = NEW.order_item_id
      AND oi.branch_id = NEW.branch_id
  ) THEN
    RAISE EXCEPTION 'The selected add-on configuration or inventory item is unavailable for this order branch and service.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_validate_order_item_addon_branch ON public.order_item_addons;
CREATE TRIGGER tr_validate_order_item_addon_branch
BEFORE INSERT OR UPDATE ON public.order_item_addons
FOR EACH ROW EXECUTE FUNCTION public.validate_order_item_addon_branch();

COMMIT;
