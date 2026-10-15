-- Archiving or moving configured inventory automatically disables its active
-- service links. Disabled legacy links may be stale and must remain editable.
BEGIN;

CREATE OR REPLACE FUNCTION public.validate_service_inventory_configuration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_item_branch UUID;
BEGIN
  NEW.updated_at := now();
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  SELECT branch_id INTO v_item_branch
  FROM public.inventory_items
  WHERE id = NEW.inventory_item_id AND deleted_at IS NULL;
  IF v_item_branch IS NULL THEN
    RAISE EXCEPTION 'The selected inventory item is archived or does not exist.';
  END IF;
  IF v_item_branch IS DISTINCT FROM NEW.branch_id THEN
    RAISE EXCEPTION 'Service inventory must belong to the selected branch.';
  END IF;
  RETURN NEW;
END;
$$;

-- Repair stale active links created before this lifecycle rule was installed.
UPDATE public.service_inventory_requirements r
SET is_active = FALSE, updated_at = now()
FROM public.inventory_items i
WHERE i.id = r.inventory_item_id
  AND r.is_active IS TRUE
  AND (i.deleted_at IS NOT NULL OR i.branch_id IS DISTINCT FROM r.branch_id);

UPDATE public.service_addon_items a
SET is_active = FALSE, updated_at = now()
FROM public.inventory_items i
WHERE i.id = a.inventory_item_id
  AND a.is_active IS TRUE
  AND (i.deleted_at IS NOT NULL OR i.branch_id IS DISTINCT FROM a.branch_id);

CREATE OR REPLACE FUNCTION public.delink_configured_inventory_before_archive_or_move()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.branch_id IS DISTINCT FROM OLD.branch_id)
     OR (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL) THEN
    UPDATE public.service_inventory_requirements
    SET is_active = FALSE, updated_at = now()
    WHERE inventory_item_id = OLD.id AND is_active IS TRUE;

    UPDATE public.service_addon_items
    SET is_active = FALSE, updated_at = now()
    WHERE inventory_item_id = OLD.id AND is_active IS TRUE;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_prevent_configured_inventory_archive_or_move ON public.inventory_items;
DROP TRIGGER IF EXISTS tr_delink_configured_inventory_before_archive_or_move ON public.inventory_items;
CREATE TRIGGER tr_delink_configured_inventory_before_archive_or_move
BEFORE UPDATE OF branch_id, deleted_at ON public.inventory_items
FOR EACH ROW EXECUTE FUNCTION public.delink_configured_inventory_before_archive_or_move();

COMMIT;
