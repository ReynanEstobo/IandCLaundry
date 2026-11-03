-- Order ETAs use each branch's own history before the shared default.
-- When a new order is estimated, each service is timed from, in order:
--   1. completed orders at the same branch for the same service and a similar
--      weight (unchanged);
--   2. completed orders at the same branch for the same service at any weight,
--      when step 1 has too few (new);
--   3. the processing time in Settings, shared by all branches (unchanged).
-- The minimum number of completed orders and the buffer still come from
-- Settings. Saved ETAs on existing orders are not recalculated.
BEGIN;

CREATE OR REPLACE FUNCTION public.estimate_order_processing_minutes(
  p_branch_id UUID,
  p_service_type_id UUID,
  p_weight_kg NUMERIC
) RETURNS TABLE(minutes INTEGER, source TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_default INTEGER;
  v_buffer INTEGER;
  v_min_samples INTEGER;
  v_bucket_average NUMERIC;
  v_bucket_count INTEGER;
  v_service_average NUMERIC;
  v_service_count INTEGER;
  v_weight_bucket INTEGER := GREATEST(1, CEIL(COALESCE(p_weight_kg, 1) / 4.0));
BEGIN
  SELECT default_processing_minutes, eta_buffer_minutes, eta_min_completed_orders
  INTO v_default, v_buffer, v_min_samples FROM public.settings LIMIT 1;
  v_default := GREATEST(COALESCE(v_default, 100), 1);
  v_buffer := GREATEST(COALESCE(v_buffer, 15), 0);
  v_min_samples := GREATEST(COALESCE(v_min_samples, 5), 1);

  SELECT
    AVG(EXTRACT(EPOCH FROM (ready_at - processing_started_at)) / 60.0)
      FILTER (WHERE CEIL(COALESCE(weight_kg, 1) / 4.0) = v_weight_bucket),
    COUNT(*) FILTER (WHERE CEIL(COALESCE(weight_kg, 1) / 4.0) = v_weight_bucket),
    AVG(EXTRACT(EPOCH FROM (ready_at - processing_started_at)) / 60.0),
    COUNT(*)
  INTO v_bucket_average, v_bucket_count, v_service_average, v_service_count
  FROM public.orders
  WHERE branch_id = p_branch_id
    AND service_type_id IS NOT DISTINCT FROM p_service_type_id
    AND status IN ('ready', 'released')
    AND processing_started_at IS NOT NULL
    AND ready_at IS NOT NULL
    AND ready_at > processing_started_at;

  IF COALESCE(v_bucket_count, 0) >= v_min_samples AND v_bucket_average IS NOT NULL THEN
    RETURN QUERY SELECT GREATEST(1, CEIL(v_bucket_average)::INTEGER + v_buffer), 'historical_service_branch'::TEXT;
  ELSIF COALESCE(v_service_count, 0) >= v_min_samples AND v_service_average IS NOT NULL THEN
    RETURN QUERY SELECT GREATEST(1, CEIL(v_service_average)::INTEGER + v_buffer), 'historical_service_branch_any_weight'::TEXT;
  ELSE
    RETURN QUERY SELECT v_default + v_buffer, 'branch_default'::TEXT;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.estimate_order_processing_minutes(UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.estimate_order_processing_minutes(UUID, UUID, NUMERIC) TO service_role;

-- The order RPC labels an order as history-based only for the exact step 1
-- source. Count the new any-weight step as history too. Nothing else in the
-- order RPC changes.
DO $$
DECLARE
  v_definition TEXT;
  v_exact_check TEXT := 'IF v_item_eta_source = ''historical_service_branch'' THEN';
  v_history_check TEXT := 'IF v_item_eta_source LIKE ''historical_service_branch%'' THEN';
BEGIN
  SELECT pg_get_functiondef('public.create_branch_order(uuid,uuid,jsonb,jsonb,jsonb,integer,uuid)'::regprocedure)
  INTO v_definition;
  IF v_definition IS NULL OR (position(v_exact_check IN v_definition) = 0 AND position(v_history_check IN v_definition) = 0) THEN
    RAISE EXCEPTION 'ETA migration stopped because the expected create_branch_order ETA source check was not found.';
  END IF;
  IF position(v_exact_check IN v_definition) > 0 THEN
    EXECUTE replace(v_definition, v_exact_check, v_history_check);
  END IF;
END;
$$;

COMMIT;
