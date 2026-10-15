-- Keep order add-on snapshots when the optional service configuration is
-- deleted. Inventory archive remains a soft delete, so inventory references
-- and historical order rows remain intact.
BEGIN;

DO $$
DECLARE
  v_delete_action "char";
BEGIN
  SELECT confdeltype
  INTO v_delete_action
  FROM pg_constraint
  WHERE conrelid = 'public.order_item_addons'::regclass
    AND conname = 'order_item_addons_service_addon_item_id_fkey'
    AND contype = 'f';

  IF v_delete_action IS NULL THEN
    RAISE EXCEPTION 'Expected foreign key order_item_addons_service_addon_item_id_fkey was not found.';
  END IF;

  -- PostgreSQL uses 'n' for ON DELETE SET NULL.
  IF v_delete_action <> 'n' THEN
    ALTER TABLE public.order_item_addons
      DROP CONSTRAINT order_item_addons_service_addon_item_id_fkey;

    ALTER TABLE public.order_item_addons
      ADD CONSTRAINT order_item_addons_service_addon_item_id_fkey
      FOREIGN KEY (service_addon_item_id)
      REFERENCES public.service_addon_items(id)
      ON DELETE SET NULL;
  END IF;
END;
$$;

COMMIT;
