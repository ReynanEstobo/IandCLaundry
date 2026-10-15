-- Preserve historical order add-ons if their service configuration is removed.
-- The FK uses ON DELETE SET NULL; that cleanup must not be rejected by the
-- order add-on integrity trigger. New or changed non-NULL links stay validated.
BEGIN;

CREATE OR REPLACE FUNCTION public.validate_order_item_addon_branch()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Allow the FK's ON DELETE SET NULL action to detach historical order rows
  -- only when no other order add-on field is changed. Snapshots remain intact.
  IF TG_OP = 'UPDATE'
     AND OLD.service_addon_item_id IS NOT NULL
     AND NEW.service_addon_item_id IS NULL
     AND (to_jsonb(NEW) - 'service_addon_item_id')
         IS NOT DISTINCT FROM
         (to_jsonb(OLD) - 'service_addon_item_id') THEN
    RETURN NEW;
  END IF;

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

COMMIT;
