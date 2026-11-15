-- Fixes found in the 2026-11-15 system test. Run after
-- 20261115_recovery_email_rules.sql. Safe to run more than once.
--
-- 1. Pickup estimates after a stage correction.
--    A correction used to set the new estimate to half of the order's current
--    estimate and save it, so every further correction halved it again (down
--    to 15 minutes). Moving an order back to Received, where the work starts
--    again, also promised the customer an earlier pickup than before.
--    Now a correction works the estimate out afresh, the same way as for a new
--    order (each service's branch history, or the Settings fallback; the
--    longest service decides):
--      * back to Received: the whole estimate, from now;
--      * back from Ready to On Process: half of it, never below 15 minutes.
--    The first promise is still kept in original_estimated_ready_at.
--
-- 2. Customer list sorting covers every page.
--    list_customers_page takes an optional sort column and direction, so the
--    Customers page can sort all customers instead of only the 10 on screen.
--    Without a sort column the order is unchanged (most recently served first).
--
-- 3. Staff see "Move back" only when the database will allow it.
--    Staff may undo only their own most recent stage change, within the undo
--    window in Settings. The Orders page used to guess this from who last
--    updated the order, which a payment also changes, and from the computer's
--    own clock. Each order in the list now carries `stage_undo`: the staff
--    member who made the latest stage change and how many seconds remain to
--    undo it, worked out with the same rule and the database's clock. It is
--    null when that change cannot be undone by staff.
BEGIN;

-- 1. Pickup estimates after a stage correction --------------------------------
DO $$
DECLARE
  v_definition TEXT;
  v_old_block TEXT := '  -- A correction creates a new, transparent customer promise. Use half of the
  -- original estimate as a conservative remaining-time baseline, never below
  -- 15 minutes. The original promise remains preserved for audit purposes.
  v_revised_minutes := GREATEST(15, CEIL(COALESCE(v_order.estimated_processing_minutes, 100) / 2.0)::INTEGER);';
  v_old_line TEXT := '  v_revised_minutes := GREATEST(15, CEIL(COALESCE(v_order.estimated_processing_minutes, 100) / 2.0)::INTEGER);';
  v_new_block TEXT := '  -- A correction gives the customer a new estimate, worked out afresh the same
  -- way as for a new order (each service''s branch history or the Settings
  -- fallback; the longest service decides), so repeated corrections never keep
  -- shortening it. Back to Received restarts the work: the whole estimate.
  -- Back from Ready to On Process: half of it, never below 15 minutes. The
  -- first promise stays in original_estimated_ready_at.
  SELECT MAX(e.minutes) INTO v_revised_minutes
  FROM public.order_items oi
  CROSS JOIN LATERAL public.estimate_order_processing_minutes(v_order.branch_id, oi.service_type_id, oi.weight_kg) e
  WHERE oi.order_id = v_order.id AND oi.status <> ''cancelled'';
  IF COALESCE(v_revised_minutes, 0) <= 0 THEN
    SELECT e.minutes INTO v_revised_minutes
    FROM public.estimate_order_processing_minutes(v_order.branch_id, v_order.service_type_id, v_order.weight_kg) e;
  END IF;
  v_revised_minutes := GREATEST(COALESCE(v_revised_minutes, 100), 1);
  IF p_new_status = ''on_process'' THEN
    v_revised_minutes := GREATEST(15, CEIL(v_revised_minutes / 2.0)::INTEGER);
  END IF;';
BEGIN
  SELECT pg_get_functiondef('public.transition_branch_order(uuid,uuid,text,text)'::regprocedure)
  INTO v_definition;
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Correction ETA fix stopped: transition_branch_order was not found.';
  END IF;
  IF position('estimate_order_processing_minutes(v_order.branch_id, oi.service_type_id' IN v_definition) > 0 THEN
    RAISE NOTICE 'Correction ETA fix is already applied.';
  ELSIF position(v_old_block IN v_definition) > 0 THEN
    EXECUTE replace(v_definition, v_old_block, v_new_block);
  ELSIF position(v_old_line IN v_definition) > 0 THEN
    EXECUTE replace(v_definition, v_old_line, v_new_block);
  ELSE
    RAISE EXCEPTION 'Correction ETA fix stopped: the expected estimate line was not found in transition_branch_order.';
  END IF;
END;
$$;

-- 2. Customer list sorting covers every page -----------------------------------
DROP FUNCTION IF EXISTS public.list_customers_page(UUID, TEXT, INTEGER, INTEGER);
CREATE OR REPLACE FUNCTION public.list_customers_page(
  p_branch_id UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 10,
  p_offset INTEGER DEFAULT 0,
  p_sort TEXT DEFAULT NULL,
  p_direction TEXT DEFAULT 'asc'
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH visible AS (
    SELECT c.*, CASE WHEN p_branch_id IS NULL THEN NULL ELSE (
      SELECT cb.last_served_at
      FROM public.customer_branches cb
      WHERE cb.customer_id = c.id AND cb.branch_id = p_branch_id
      ORDER BY cb.last_served_at DESC NULLS LAST
      LIMIT 1
    ) END AS visibility_last_served_at
    FROM public.customers c
    WHERE c.deleted_at IS NULL
      AND (p_branch_id IS NULL OR EXISTS (
        SELECT 1 FROM public.customer_branches cb
        WHERE cb.customer_id = c.id AND cb.branch_id = p_branch_id
      ))
      AND (
        NULLIF(btrim(COALESCE(p_search, '')), '') IS NULL
        OR lower(c.name) LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(c.phone) LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(COALESCE(c.email, '')) LIKE '%' || lower(btrim(p_search)) || '%'
      )
  ),
  keyed AS (
    SELECT v.*,
      CASE lower(COALESCE(p_sort, ''))
        WHEN 'name' THEN lower(v.name)
        WHEN 'phone' THEN v.phone
        WHEN 'email' THEN NULLIF(lower(COALESCE(v.email, '')), '')
        WHEN 'branch' THEN NULLIF(lower(COALESCE(v.branch, '')), '')
      END AS sort_text,
      CASE lower(COALESCE(p_sort, ''))
        WHEN 'rewards' THEN (SELECT count(*) FROM public.loyalty_rewards r WHERE r.customer_id = v.id)::NUMERIC
        WHEN 'added' THEN extract(epoch FROM v.created_at)::NUMERIC
      END AS sort_number,
      lower(COALESCE(p_direction, 'asc')) = 'desc' AS sort_descending
    FROM visible v
  ),
  ranked AS (
    SELECT k.*, row_number() OVER (ORDER BY
      CASE WHEN k.sort_descending THEN NULL ELSE k.sort_text END ASC NULLS LAST,
      CASE WHEN k.sort_descending THEN k.sort_text END DESC NULLS LAST,
      CASE WHEN k.sort_descending THEN NULL ELSE k.sort_number END ASC NULLS LAST,
      CASE WHEN k.sort_descending THEN k.sort_number END DESC NULLS LAST,
      COALESCE(k.visibility_last_served_at, k.created_at) DESC, k.id DESC
    ) AS list_position
    FROM keyed k
  ),
  paged AS (
    SELECT * FROM ranked
    ORDER BY list_position
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'data', COALESCE(jsonb_agg(
      (to_jsonb(p) - 'visibility_last_served_at' - 'sort_text' - 'sort_number' - 'sort_descending' - 'list_position')
      || jsonb_build_object('loyaltyRewards', COALESCE((
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.earned_at DESC)
        FROM public.loyalty_rewards r
        WHERE r.customer_id = p.id
      ), '[]'::jsonb))
      ORDER BY p.list_position
    ), '[]'::jsonb),
    'count', (SELECT count(*) FROM visible)
  )
  FROM paged p;
$$;

REVOKE ALL ON FUNCTION public.list_customers_page(UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_customers_page(UUID, TEXT, INTEGER, INTEGER, TEXT, TEXT) TO service_role;

-- 3. Staff see "Move back" only when the database will allow it ---------------
-- The same test transition_branch_order applies to a staff correction: the
-- latest stage change moved the order from the stage before into its current
-- stage, and happened within the undo window. Only the time left is computed
-- here; who may use it is compared with the signed-in staff member.
DO $$
DECLARE
  v_definition TEXT;
  v_anchor TEXT := '      (to_jsonb(p) - ''customer_name'' - ''customer_phone'' - ''customer_email'' - ''list_position'')
      || jsonb_build_object(
        ''customers'',';
  v_with_undo TEXT := '      (to_jsonb(p) - ''customer_name'' - ''customer_phone'' - ''customer_email'' - ''list_position'')
      || jsonb_build_object(''stage_undo'', (
        SELECT jsonb_build_object(
          ''staff_id'', h.staff_id,
          ''seconds_left'', GREATEST(0, FLOOR(
            GREATEST(COALESCE((SELECT s.status_undo_seconds FROM public.settings s LIMIT 1), 60), 1)
            - extract(epoch FROM (now() - h.changed_at))
          ))::INTEGER
        )
        FROM (
          SELECT sh.staff_id, sh.status, sh.previous_status, sh.changed_at
          FROM public.order_stage_history sh
          WHERE sh.order_id = p.id
          ORDER BY sh.changed_at DESC
          LIMIT 1
        ) h
        WHERE h.status = p.status
          AND h.previous_status IS NOT DISTINCT FROM CASE p.status WHEN ''on_process'' THEN ''received'' WHEN ''ready'' THEN ''on_process'' END
          AND p.status IN (''on_process'', ''ready'')
          AND h.staff_id IS NOT NULL
          AND h.changed_at >= now() - make_interval(secs => GREATEST(COALESCE((SELECT s.status_undo_seconds FROM public.settings s LIMIT 1), 60), 1))
      ))
      || jsonb_build_object(
        ''customers'',';
BEGIN
  SELECT pg_get_functiondef('public.list_orders_page(uuid,text,text,integer,integer)'::regprocedure)
  INTO v_definition;
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Move back fix stopped: list_orders_page was not found.';
  END IF;
  IF position('''stage_undo''' IN v_definition) > 0 THEN
    RAISE NOTICE 'Move back fix is already applied.';
  ELSIF position(v_anchor IN v_definition) > 0 THEN
    EXECUTE replace(v_definition, v_anchor, v_with_undo);
  ELSE
    RAISE EXCEPTION 'Move back fix stopped: the expected order fields were not found in list_orders_page.';
  END IF;
END;
$$;

COMMIT;
