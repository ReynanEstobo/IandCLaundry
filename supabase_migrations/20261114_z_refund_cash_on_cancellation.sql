-- Cancelling an order that already took cash now records a refund of
-- everything paid. Before this, the cash stayed recorded as collected on the
-- cancelled order with no record of whether it was returned.
--
-- * order_refunds is an append-only ledger: one full refund per cancelled
--   order, recorded under the staff member who cancelled it.
-- * orders.refunded_amount shows the refund on the order itself.
-- * Payments are unchanged: they still show the cash that was received.
-- * Orders cancelled before this migration are left as they are
--   (refunded_amount 0, no refund record), because it is not known whether
--   their cash was returned.
--
-- Safe to run more than once.
BEGIN;

CREATE TABLE IF NOT EXISTS public.order_refunds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  branch TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  refunded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  refunded_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'order_cancellation' CHECK (source IN ('order_cancellation'))
);
CREATE UNIQUE INDEX IF NOT EXISTS order_refunds_one_per_order ON public.order_refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_order_refunds_branch_date ON public.order_refunds(branch, refunded_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_refunds_date ON public.order_refunds(refunded_at DESC);

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS refunded_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.prevent_order_refund_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Refund records cannot be changed or deleted';
END $$;
DROP TRIGGER IF EXISTS tr_order_refunds_append_only ON public.order_refunds;
CREATE TRIGGER tr_order_refunds_append_only BEFORE UPDATE OR DELETE ON public.order_refunds
FOR EACH ROW EXECUTE FUNCTION public.prevent_order_refund_mutation();

-- Same as the previous cancel_branch_order, plus the refund of the cash paid.
CREATE OR REPLACE FUNCTION public.cancel_branch_order(p_order_id uuid, p_staff_id uuid, p_reason text)
RETURNS public.orders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_order public.orders; v_usage RECORD; v_item RECORD; v_actor RECORD; v_before JSONB; v_refund NUMERIC(12,2);
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
  v_refund := GREATEST(COALESCE(v_order.amount_paid, 0) - COALESCE(v_order.refunded_amount, 0), 0);

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
      stage_started_at = NULL, refunded_amount = COALESCE(refunded_amount, 0) + v_refund,
      updated_at = now()
  WHERE id = p_order_id RETURNING * INTO v_order;

  IF v_refund > 0 THEN
    INSERT INTO public.order_refunds(order_id, branch_id, branch, amount, refunded_by_staff_id, reason)
    VALUES (p_order_id, v_order.branch_id, v_order.branch, v_refund, p_staff_id, trim(p_reason));
  END IF;

  INSERT INTO public.audit_logs(action, table_name, record_id, actor_staff_id, branch_id, before_data, after_data)
  VALUES ('cancel', 'orders', p_order_id, p_staff_id, v_order.branch_id, v_before, to_jsonb(v_order));
  RETURN v_order;
END $function$;

-- Only the Worker (service_role) reads refunds or runs these functions.
ALTER TABLE public.order_refunds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_refunds FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.order_refunds TO service_role;
REVOKE ALL ON FUNCTION public.prevent_order_refund_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_branch_order(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_branch_order(uuid, uuid, text) TO service_role;

COMMIT;
