-- Read-only query paths for high-volume operational screens. These functions
-- do not change order, inventory, payment, loyalty, or archive business data.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_customer_branches_branch_customer
  ON public.customer_branches (branch_id, customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_branches_branch_last_served
  ON public.customer_branches (branch_id, last_served_at DESC, customer_id);
CREATE INDEX IF NOT EXISTS idx_customers_active_created_desc
  ON public.customers (created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_phone_search
  ON public.customers USING gin (lower(phone) gin_trgm_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_customers_email_search
  ON public.customers USING gin (lower(email) gin_trgm_ops)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_items_active_branch_name
  ON public.inventory_items (branch, name, id)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_payments_paid_at
  ON public.payments (paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_branch_paid_at
  ON public.payments (branch_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_payment_date
  ON public.payments (payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_date
  ON public.expenses (branch_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_branch_created
  ON public.order_items (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_usage_item_logged
  ON public.inventory_usage_log (item_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_active_created_desc
  ON public.orders (created_at DESC)
  WHERE status NOT IN ('released', 'cancelled');
CREATE INDEX IF NOT EXISTS idx_orders_unpaid_created_desc
  ON public.orders (created_at DESC)
  WHERE status <> 'cancelled' AND payment_status = 'unpaid';

CREATE OR REPLACE FUNCTION public.list_customers_page(
  p_branch_id UUID DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 10,
  p_offset INTEGER DEFAULT 0
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
  paged AS (
    SELECT * FROM visible
    ORDER BY COALESCE(visibility_last_served_at, created_at) DESC, id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 50)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'data', COALESCE(jsonb_agg(
      (to_jsonb(p) - 'visibility_last_served_at') || jsonb_build_object('loyaltyRewards', COALESCE((
        SELECT jsonb_agg(to_jsonb(r) ORDER BY r.earned_at DESC)
        FROM public.loyalty_rewards r
        WHERE r.customer_id = p.id
      ), '[]'::jsonb))
      ORDER BY COALESCE(p.visibility_last_served_at, p.created_at) DESC, p.id DESC
    ), '[]'::jsonb),
    'count', (SELECT count(*) FROM visible)
  )
  FROM paged p;
$$;

CREATE OR REPLACE FUNCTION public.list_inventory_page(
  p_branch TEXT DEFAULT NULL,
  p_search TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 25,
  p_offset INTEGER DEFAULT 0
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH visible AS (
    SELECT i.*
    FROM public.inventory_items i
    WHERE i.deleted_at IS NULL
      AND (NULLIF(btrim(COALESCE(p_branch, '')), '') IS NULL OR i.branch = p_branch)
      AND (
        NULLIF(btrim(COALESCE(p_search, '')), '') IS NULL
        OR lower(i.name) LIKE '%' || lower(btrim(p_search)) || '%'
      )
  ),
  paged AS (
    SELECT * FROM visible
    ORDER BY name ASC, id ASC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT jsonb_build_object(
    'data', COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.name ASC, p.id ASC), '[]'::jsonb),
    'count', (SELECT count(*) FROM visible)
  )
  FROM paged p;
$$;

REVOKE ALL ON FUNCTION public.list_customers_page(UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.list_inventory_page(TEXT, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_customers_page(UUID, TEXT, INTEGER, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_inventory_page(TEXT, TEXT, INTEGER, INTEGER) TO service_role;

COMMIT;
