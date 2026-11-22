-- Distinguish genuine live transactions, aggregate-reconstruction rows, and
-- demonstration data so transaction-level analytics never present synthetic
-- customer, staff, service, or turnaround details as real operational facts.
BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS data_origin TEXT NOT NULL DEFAULT 'live';
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS data_origin TEXT NOT NULL DEFAULT 'live';
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS data_origin TEXT NOT NULL DEFAULT 'live';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_data_origin_check') THEN
    ALTER TABLE public.orders ADD CONSTRAINT orders_data_origin_check
      CHECK (data_origin IN ('live', 'aggregate_reconstruction', 'demo'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_data_origin_check') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_data_origin_check
      CHECK (data_origin IN ('live', 'aggregate_reconstruction', 'demo'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_data_origin_check') THEN
    ALTER TABLE public.expenses ADD CONSTRAINT expenses_data_origin_check
      CHECK (data_origin IN ('live', 'aggregate_reconstruction', 'demo'));
  END IF;
END $$;

-- Backfill only records whose existing seed markers prove they are demo data.
-- No date-based mass update is performed because a cutoff could misclassify
-- genuine transactions.
UPDATE public.customers
SET data_origin = 'demo'
WHERE lower(COALESCE(email, '')) LIKE '%@forecast.example.test';

UPDATE public.orders AS o
SET data_origin = 'demo'
FROM public.customers AS c
WHERE c.id = o.customer_id
  AND c.data_origin = 'demo';

UPDATE public.orders AS o
SET data_origin = 'demo'
WHERE EXISTS (
  SELECT 1
  FROM public.payments AS p
  WHERE p.order_id = o.id
    AND p.source = 'demo_forecast_seed'
);

UPDATE public.expenses
SET data_origin = 'demo'
WHERE description LIKE 'Demo forecast history:%';

CREATE INDEX IF NOT EXISTS idx_orders_data_origin_created_at
  ON public.orders(data_origin, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_data_origin_created_at
  ON public.customers(data_origin, created_at DESC);

COMMENT ON COLUMN public.orders.data_origin IS
  'live = genuine operational transaction; aggregate_reconstruction = synthetic detail calibrated to verified client aggregates; demo = artificial test/demo record';
COMMENT ON COLUMN public.customers.data_origin IS
  'Origin of the customer profile for analytics filtering';
COMMENT ON COLUMN public.expenses.data_origin IS
  'Origin of the expense record for analytics filtering';

-- Keep a minimal, access-restricted rollback map before classifying the
-- client-approved reconstructed period. It stores only record IDs and their
-- previous origin; no customer names or contact details are copied.
CREATE TABLE IF NOT EXISTS public.analytics_data_origin_backup_20261122 (
  record_type TEXT NOT NULL CHECK (record_type IN ('order', 'customer')),
  record_id UUID NOT NULL,
  previous_origin TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (record_type, record_id)
);
ALTER TABLE public.analytics_data_origin_backup_20261122 ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.analytics_data_origin_backup_20261122 FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.analytics_data_origin_backup_20261122 FROM authenticated;
  END IF;
END $$;

INSERT INTO public.analytics_data_origin_backup_20261122(record_type, record_id, previous_origin)
SELECT 'order', id, data_origin
FROM public.orders
WHERE (created_at AT TIME ZONE 'Asia/Manila')::DATE
  BETWEEN DATE '2026-08-01' AND DATE '2026-11-05'
ON CONFLICT (record_type, record_id) DO NOTHING;

INSERT INTO public.analytics_data_origin_backup_20261122(record_type, record_id, previous_origin)
SELECT 'customer', c.id, c.data_origin
FROM public.customers AS c
WHERE (c.created_at AT TIME ZONE 'Asia/Manila')::DATE
    BETWEEN DATE '2026-08-01' AND DATE '2026-11-05'
   OR EXISTS (
     SELECT 1
     FROM public.orders AS o
     WHERE o.customer_id = c.id
       AND (o.created_at AT TIME ZONE 'Asia/Manila')::DATE
         BETWEEN DATE '2026-08-01' AND DATE '2026-11-05'
   )
ON CONFLICT (record_type, record_id) DO NOTHING;

-- The project owner confirmed that every transaction dated August 1 through
-- November 5, 2026 is a reconstructed row calibrated to real branch-level
-- daily order and cash totals. November 6 onward remains live.
UPDATE public.orders
SET data_origin = 'aggregate_reconstruction'
WHERE (created_at AT TIME ZONE 'Asia/Manila')::DATE
  BETWEEN DATE '2026-08-01' AND DATE '2026-11-05'
  AND data_origin <> 'demo';

UPDATE public.customers AS c
SET data_origin = 'aggregate_reconstruction'
WHERE c.data_origin <> 'demo'
  AND (
    (c.created_at AT TIME ZONE 'Asia/Manila')::DATE
      BETWEEN DATE '2026-08-01' AND DATE '2026-11-05'
    OR EXISTS (
      SELECT 1
      FROM public.orders AS o
      WHERE o.customer_id = c.id
        AND o.data_origin = 'aggregate_reconstruction'
    )
  );

COMMIT;
