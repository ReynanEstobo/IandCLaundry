-- Run once after the branch-operation and audit-log migrations.
-- Cancels an unreleased order atomically, reverses its stock exactly once,
-- and preserves payment and inventory audit history.
BEGIN;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancelled_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE public.inventory_usage_log ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE public.inventory_usage_log ADD COLUMN IF NOT EXISTS reversed_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.inventory_adjustments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE RESTRICT,
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  quantity_change NUMERIC(10,4) NOT NULL,
  reason TEXT NOT NULL,
  created_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_order ON public.inventory_adjustments(order_id, created_at DESC);

-- Extend the Recycle Bin audit table to also record order cancellation.
ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_action_check
CHECK (action IN ('delete', 'restore', 'cancel'));

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

  -- Different orders can use the same inventory items. Lock those item rows in
  -- one deterministic order before restoring anything to avoid deadlocks.
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
    UPDATE public.inventory_items
    SET current_stock = current_stock + v_usage.quantity_used
    WHERE id = v_usage.item_id;
    INSERT INTO public.inventory_adjustments(item_id, order_id, branch_id, quantity_change, reason, created_by_staff_id)
    VALUES (v_usage.item_id, p_order_id, v_order.branch_id, v_usage.quantity_used, 'Order cancellation stock return', p_staff_id);
    UPDATE public.inventory_usage_log
    SET reversed_at = now(), reversed_by_staff_id = p_staff_id
    WHERE id = v_usage.id;
  END LOOP;

  -- The stage-history trigger reads this transaction-local metadata.
  PERFORM set_config('app.order_transition_type', 'cancel', true);
  PERFORM set_config('app.order_correction_reason', trim(p_reason), true);
  PERFORM set_config('app.order_eta_before', COALESCE(v_order.estimated_ready_at::TEXT, ''), true);
  UPDATE public.orders
  SET status = 'cancelled', cancelled_at = now(), cancelled_by_staff_id = p_staff_id,
      cancellation_reason = trim(p_reason), last_updated_by_staff_id = p_staff_id,
      stage_started_at = NULL, updated_at = now()
  WHERE id = p_order_id
  RETURNING * INTO v_order;

  INSERT INTO public.audit_logs(action, table_name, record_id, actor_staff_id, branch_id, before_data, after_data)
  VALUES ('cancel', 'orders', p_order_id, p_staff_id, v_order.branch_id,
    v_before, to_jsonb(v_order));
  RETURN v_order;
END $$;

REVOKE EXECUTE ON FUNCTION public.cancel_branch_order(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.cancel_branch_order(UUID, UUID, TEXT) TO service_role;

CREATE INDEX IF NOT EXISTS idx_orders_cancelled_at ON public.orders(cancelled_at) WHERE cancelled_at IS NOT NULL;
COMMIT;
