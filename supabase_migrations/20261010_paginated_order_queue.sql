-- Serve the Orders page in bounded pages instead of transferring its complete
-- history to the browser. The returned JSON preserves the current UI shape.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_orders_branch_status_created_desc
  ON public.orders (branch_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created_desc
  ON public.orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_order_number_search
  ON public.orders USING gin (lower(order_number) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customers_name_search
  ON public.customers USING gin (lower(name) gin_trgm_ops)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.list_orders_page(
  p_branch_id UUID DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 10,
  p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT o.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
    FROM public.orders o
    LEFT JOIN public.customers c ON c.id = o.customer_id
    WHERE (p_branch_id IS NULL OR o.branch_id = p_branch_id)
      AND (NULLIF(btrim(COALESCE(p_status, '')), '') IS NULL OR o.status = p_status)
      AND (
        NULLIF(btrim(COALESCE(p_search, '')), '') IS NULL
        OR lower(o.order_number) LIKE '%' || lower(btrim(p_search)) || '%'
        OR lower(c.name) LIKE '%' || lower(btrim(p_search)) || '%'
      )
  ),
  paged AS (
    SELECT *
    FROM filtered
    ORDER BY
      CASE WHEN status = 'cancelled' THEN 2 WHEN status = 'released' THEN 1 ELSE 0 END,
      CASE
        WHEN status NOT IN ('released', 'cancelled')
         AND (created_at AT TIME ZONE 'Asia/Manila')::DATE = (now() AT TIME ZONE 'Asia/Manila')::DATE
        THEN 0
        ELSE 1
      END,
      COALESCE(priority_order, 0),
      CASE
        WHEN status NOT IN ('released', 'cancelled')
         AND (created_at AT TIME ZONE 'Asia/Manila')::DATE = (now() AT TIME ZONE 'Asia/Manila')::DATE
        THEN created_at
      END DESC NULLS LAST,
      CASE
        WHEN status NOT IN ('released', 'cancelled')
         AND (created_at AT TIME ZONE 'Asia/Manila')::DATE <> (now() AT TIME ZONE 'Asia/Manila')::DATE
        THEN created_at
      END ASC NULLS LAST,
      CASE WHEN status IN ('released', 'cancelled') THEN created_at END DESC NULLS LAST,
      id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'data', COALESCE(jsonb_agg(
      (to_jsonb(p) - 'customer_id' - 'customer_name' - 'customer_phone' - 'customer_email')
      || jsonb_build_object(
        'customers', CASE WHEN p.customer_id IS NULL THEN NULL ELSE jsonb_build_object(
          'name', p.customer_name, 'phone', p.customer_phone, 'email', p.customer_email
        ) END,
        'order_items', COALESCE((
          SELECT jsonb_agg(
            to_jsonb(oi) || jsonb_build_object('order_item_addons', COALESCE((
              SELECT jsonb_agg(to_jsonb(oa) ORDER BY oa.created_at)
              FROM public.order_item_addons oa
              WHERE oa.order_item_id = oi.id
            ), '[]'::jsonb))
            ORDER BY oi.created_at
          )
          FROM public.order_items oi
          WHERE oi.order_id = p.id
        ), '[]'::jsonb)
      )
    ), '[]'::jsonb),
    'count', (SELECT count(*) FROM filtered)
  )
  FROM paged p;
$$;

REVOKE ALL ON FUNCTION public.list_orders_page(UUID, TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_orders_page(UUID, TEXT, TEXT, INTEGER, INTEGER) TO service_role;

COMMIT;
