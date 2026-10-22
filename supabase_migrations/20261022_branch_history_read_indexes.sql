-- Read-speed indexes for history screens (Dashboard, Staff Dashboard,
-- Analytics, Inventory forecast). Staff access and the per-branch analytics
-- filter use the text `branch` column, which the existing branch_id indexes
-- cannot serve. Indexes change no data and no query result; they only let
-- these filtered, date-ranged reads stay fast as the history grows.
BEGIN;

-- Per-branch history windows: orders, payments (both timestamps the
-- dashboards read), expenses, and new customers by date.
CREATE INDEX IF NOT EXISTS idx_orders_branch_name_created
  ON public.orders (branch, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_branch_name_paid_at
  ON public.payments (branch, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_payments_branch_name_payment_date
  ON public.payments (branch, payment_date DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_branch_name_date
  ON public.expenses (branch, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_customers_branch_name_created
  ON public.customers (branch, created_at DESC);

-- All-branch reads by date (administrator views).
CREATE INDEX IF NOT EXISTS idx_expenses_date
  ON public.expenses (expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_order_items_created
  ON public.order_items (created_at DESC);

-- "Latest 500 usage entries" on the dashboards, for all branches and for
-- a staff member's branch.
CREATE INDEX IF NOT EXISTS idx_inventory_usage_logged
  ON public.inventory_usage_log (logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_inventory_usage_branch_name_logged
  ON public.inventory_usage_log (branch, logged_at DESC);

COMMIT;
