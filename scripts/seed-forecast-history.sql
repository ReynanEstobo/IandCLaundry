-- Supplemental SYNTHETIC history for the demo database. Run after the reset
-- seed, as one execution in Supabase SQL Editor. No existing rows are deleted.
-- Adds 90 previous Manila calendar days for each active branch: 3 orders/day,
-- 5 on Friday/Saturday. Uses the Demo services and their inventory recipes.
-- Keep this artificial history out of real evaluation/forecast accuracy claims.
-- Existing demo customers, loyalty settings, users and active orders are retained.
BEGIN;

DO $$
DECLARE
  v_admin UUID;
  v_branch RECORD;
  v_service public.service_types;
  v_order public.orders;
  v_day DATE;
  v_start TIMESTAMPTZ;
  v_ready TIMESTAMPTZ;
  v_days INTEGER;
  v_slot INTEGER;
  v_daily_count INTEGER;
  v_sequence INTEGER := 0;
  v_branch_count INTEGER := 0;
  v_branch_orders INTEGER;
  v_weight NUMERIC;
  v_total NUMERIC;
  v_addon UUID;
  v_addon_price NUMERIC;
  v_addons JSONB;
  v_previous_sync TEXT := current_setting('app.payment_ledger_sync', true);
BEGIN
  -- Prevent two editor sessions from seeding the same history concurrently.
  PERFORM pg_advisory_xact_lock(hashtextextended('demo-forecast-history-v1', 0));
  IF EXISTS (SELECT 1 FROM public.customers WHERE email LIKE '%@forecast.example.test') THEN
    RAISE EXCEPTION 'Forecast demo history already exists. Do not run this supplement twice.';
  END IF;
  SELECT id INTO v_admin FROM public.staff
  WHERE lower(role) = 'admin' AND deleted_at IS NULL ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'An active administrator is required.'; END IF;
  IF (SELECT count(*) FROM public.service_types
      WHERE name IN ('Wash & Fold Demo', 'Comforter Demo', 'Air Dry Demo')
        AND is_active IS TRUE AND deleted_at IS NULL) <> 3 THEN
    RAISE EXCEPTION 'Expected the three active Demo services from reset-and-seed-test-data.sql.';
  END IF;
  PERFORM set_config('app.audit_actor_staff_id', v_admin::TEXT, true);

  FOR v_branch IN SELECT id, name FROM public.branches
    WHERE is_active IS TRUE AND name IS NOT NULL ORDER BY name, id
  LOOP
    v_branch_count := v_branch_count + 1;
    v_branch_orders := 0;
    -- Refuse unconfigured branches instead of silently making history with no usage.
    IF NOT EXISTS (SELECT 1 FROM public.service_inventory_requirements r
      JOIN public.service_types s ON s.id = r.service_type_id
      JOIN public.inventory_items i ON i.id = r.inventory_item_id
      WHERE r.branch_id = v_branch.id AND r.is_active IS TRUE
        AND s.name = 'Wash & Fold Demo' AND i.deleted_at IS NULL
        AND i.branch_id = v_branch.id) THEN
      RAISE EXCEPTION 'Branch % needs the Demo Wash & Fold inventory recipe first.', v_branch.name;
    END IF;

    FOR v_days IN REVERSE 90..1 LOOP
      v_day := (now() AT TIME ZONE 'Asia/Manila')::DATE - v_days;
      v_daily_count := CASE WHEN extract(isodow FROM v_day) IN (5, 6) THEN 5 ELSE 3 END;
      FOR v_slot IN 1..v_daily_count LOOP
        v_sequence := v_sequence + 1;
        v_branch_orders := v_branch_orders + 1;
        SELECT * INTO STRICT v_service FROM public.service_types
        WHERE name = CASE (v_slot - 1) % 3
          WHEN 0 THEN 'Wash & Fold Demo' WHEN 1 THEN 'Comforter Demo' ELSE 'Air Dry Demo' END
          AND is_active IS TRUE AND deleted_at IS NULL;
        -- Rotate weight buckets so 8 kg and 11 kg orders both have ETA samples.
        v_weight := CASE WHEN v_days % 2 = 0 THEN 8 ELSE 11 END;
        v_total := v_service.bundle_price
          + GREATEST(v_weight - v_service.bundle_kg, 0) * v_service.excess_kg_price;
        v_addons := '{}'::JSONB;
        IF v_service.name = 'Wash & Fold Demo' AND v_days % 3 = 0 THEN
          SELECT a.id, a.unit_price INTO v_addon, v_addon_price
          FROM public.service_addon_items a JOIN public.inventory_items i ON i.id = a.inventory_item_id
          WHERE a.branch_id = v_branch.id AND a.service_type_id = v_service.id
            AND a.is_active IS TRUE AND i.deleted_at IS NULL AND i.branch_id = v_branch.id
            AND i.name = 'Demo Garment Bag' ORDER BY a.id LIMIT 1;
          IF v_addon IS NULL THEN RAISE EXCEPTION 'Missing Demo Garment Bag add-on in %.', v_branch.name; END IF;
          v_addons := jsonb_build_object(v_addon::TEXT, 1);
          v_total := v_total + v_addon_price;
        END IF;
        v_start := (v_day + make_time(8 + v_slot, 0, 0)) AT TIME ZONE 'Asia/Manila';
        v_ready := v_start + make_interval(mins => 15 + v_service.estimated_minutes
          + CASE WHEN v_weight > 8 THEN 20 ELSE 0 END + (v_days % 5) * 5);

        -- Use the normal order RPC for price/stock validation and deductions.
        -- Suppress its automatic today's-date payment, then append two dated
        -- ledger entries. Never UPDATE an append-only payment or disable guards.
        PERFORM set_config('app.payment_ledger_sync', 'true', true);
        v_order := public.create_branch_order(v_branch.id, v_admin,
          jsonb_build_object('name', 'Demo Forecast Customer ' || v_sequence,
            'phone', '0988' || lpad(v_sequence::TEXT, 7, '0'),
            'email', 'demo-' || v_sequence || '@forecast.example.test'),
          jsonb_build_object('client_request_id', gen_random_uuid(), 'amount_paid', round(v_total / 2, 2),
            'payment_method', 'cash', 'items', jsonb_build_array(jsonb_build_object(
              'service_type_id', v_service.id, 'weight_kg', v_weight))),
          v_addons, 1, NULL);
        IF EXISTS (SELECT 1 FROM public.payments WHERE order_id = v_order.id) THEN
          RAISE EXCEPTION 'Unexpected automatic payment; payment sync behavior differs. Seed rolled back.';
        END IF;
        INSERT INTO public.payments(order_id, amount, payment_method, payment_status,
          payment_date, paid_at, created_at, received_by_staff_id, source)
        VALUES
          (v_order.id, round(v_total / 2, 2), 'cash', 'partial', v_start, v_start, v_start,
            v_admin, 'demo_forecast_seed'),
          (v_order.id, v_total - round(v_total / 2, 2), 'cash', 'paid',
            v_ready + interval '30 minutes', v_ready + interval '30 minutes',
            v_ready + interval '30 minutes', v_admin, 'demo_forecast_seed');
        PERFORM public.transition_all_order_items(v_order.id, v_admin, 'on_process');
        PERFORM public.transition_all_order_items(v_order.id, v_admin, 'completed');
        PERFORM public.transition_branch_order(v_order.id, v_admin, 'released', NULL);

        -- Backdate only records created by this iteration. Audit logs retain the
        -- true import time; operational timestamps describe synthetic activity.
        UPDATE public.orders SET created_at = v_start,
          processing_started_at = v_start + interval '15 minutes', ready_at = v_ready,
          actual_completion = v_ready, picked_up_at = v_ready + interval '30 minutes',
          stage_started_at = v_ready + interval '30 minutes',
          estimated_ready_at = v_start + make_interval(mins => estimated_processing_minutes)
        WHERE id = v_order.id;
        UPDATE public.order_items SET created_at = v_start,
          processing_started_at = v_start + interval '15 minutes', completed_at = v_ready
        WHERE order_id = v_order.id;
        UPDATE public.inventory_usage_log SET logged_at = v_start WHERE order_id = v_order.id;
        UPDATE public.order_item_addons SET created_at = v_start
        WHERE order_item_id IN (SELECT id FROM public.order_items WHERE order_id = v_order.id);
        UPDATE public.order_stage_history SET changed_at = CASE status
          WHEN 'received' THEN v_start WHEN 'on_process' THEN v_start + interval '15 minutes'
          WHEN 'ready' THEN v_ready WHEN 'released' THEN v_ready + interval '30 minutes'
          ELSE changed_at END WHERE order_id = v_order.id;
        UPDATE public.customers SET created_at = v_start WHERE id = v_order.customer_id;
        UPDATE public.customer_branches SET first_served_at = v_start, last_served_at = v_start
        WHERE customer_id = v_order.customer_id AND branch_id = v_branch.id;
      END LOOP;
      IF v_days % 7 = 0 THEN
        INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
        VALUES ('Utilities', 'Demo forecast history: weekly utilities',
          700 + v_branch_count * 50 + (v_days % 4) * 25, v_day, v_branch.name, v_branch.id);
      END IF;
    END LOOP;
    RAISE NOTICE 'Added % historical orders for %', v_branch_orders, v_branch.name;
  END LOOP;
  IF v_branch_count = 0 THEN RAISE EXCEPTION 'No active branches found.'; END IF;
  IF EXISTS (SELECT 1 FROM public.orders o JOIN public.customers c ON c.id = o.customer_id
    WHERE c.email LIKE '%@forecast.example.test' AND (o.status <> 'released'
      OR o.amount_paid IS DISTINCT FROM o.total_price
      OR o.total_price IS DISTINCT FROM (SELECT SUM(p.amount) FROM public.payments p WHERE p.order_id = o.id)
      OR o.ready_at <= o.processing_started_at)) THEN
    RAISE EXCEPTION 'Historical order/payment validation failed; seed rolled back.';
  END IF;
  PERFORM set_config('app.payment_ledger_sync', COALESCE(v_previous_sync, 'false'), true);
END;
$$;

-- Verification output: each branch should have 90 days and 300+ orders.
SELECT o.branch, count(*) AS historical_orders,
  count(DISTINCT (o.created_at AT TIME ZONE 'Asia/Manila')::DATE) AS history_days,
  min(o.created_at) AS first_order, max(o.created_at) AS last_order,
  sum(o.total_price) AS historical_order_value
FROM public.orders o JOIN public.customers c ON c.id = o.customer_id
WHERE c.email LIKE '%@forecast.example.test'
GROUP BY o.branch ORDER BY o.branch;
COMMIT;
