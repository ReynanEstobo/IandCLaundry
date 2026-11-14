-- START CLEAN for the LIVE I&C Laundry project.
--
-- On 14 November 2026 scripts/reset-and-seed-test-data.sql was run on the live
-- project by mistake. It replaced the business data with demo data. This
-- script removes that demo data and leaves a clean starting point.
--
-- Deletes: every customer, order (with its items, add-ons, stage history,
-- payments and refunds), loyalty reward, expense, inventory record (items,
-- categories, restocks, usage, adjustments, service recipes and add-ons),
-- AI forecast, email and SMS log, pending email/password code and audit-log
-- entry.
-- Keeps: staff accounts and their logins, branches, and the Settings page.
-- Re-creates: the 10 services with the prices they had before the reset.
-- Loyalty stays on and counts orders from the moment this script runs.
-- Order numbers start again from 00000001.
--
-- How to run:
--   1. Run supabase_migrations/20261114_zz_payment_ledger_per_order.sql first.
--   2. Paste this whole file into the live project's SQL Editor.
--   3. Replace the empty confirmation text below with START_CLEAN.
--   4. Run it once. Everything happens in one step: if anything fails, nothing
--      is changed.
--   5. Add your inventory items again on the Inventory page, and any service
--      descriptions on the Services page.

DO $$
DECLARE
  v_confirmation TEXT := '';
  v_admin_id UUID;
BEGIN
  IF v_confirmation <> 'START_CLEAN' THEN
    RAISE EXCEPTION 'Start clean stopped: replace the empty confirmation text with START_CLEAN, then run again. Nothing was changed.';
  END IF;

  SELECT id INTO v_admin_id
  FROM public.staff
  WHERE lower(role) = 'admin' AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Start clean stopped: an active administrator is required. Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.settings) THEN
    RAISE EXCEPTION 'Start clean stopped: the settings row is missing. Nothing was changed.';
  END IF;
  PERFORM set_config('app.audit_actor_staff_id', v_admin_id::TEXT, TRUE);

  -- No CASCADE: if the database has a dependency this list does not expect,
  -- the whole script fails and nothing is deleted.
  TRUNCATE TABLE
    public.ai_forecasts,
    public.audit_logs,
    public.customer_branches,
    public.customers,
    public.email_change_otps,
    public.email_delivery_audit,
    public.expenses,
    public.inventory_adjustments,
    public.inventory_categories,
    public.inventory_items,
    public.inventory_restocks,
    public.inventory_usage_log,
    public.loyalty_rewards,
    public.order_item_addons,
    public.order_items,
    public.order_refunds,
    public.order_stage_history,
    public.orders,
    public.password_change_otps,
    public.payments,
    public.service_addon_items,
    public.service_inventory_requirements,
    public.service_types,
    public.sms_log
  RESTART IDENTITY;

  -- The services as they were before the reset: name, price for one 8 kg load,
  -- price per excess kg, and workflow. 120 minutes is what the Services page
  -- saves for every service.
  INSERT INTO public.service_types
    (name, description, bundle_kg, bundle_price, excess_kg_price, price_per_kg,
     estimated_minutes, processing_type, is_active)
  SELECT name, NULL, 8, load_price, excess_price, round(load_price / 8, 2),
         120, workflow, TRUE
  FROM (VALUES
    ('Air Dry Demo',     260::NUMERIC,  25::NUMERIC, 'air_dry_only'),
    ('Blanket Cleaning', 300,  35, 'full_service'),
    ('Comforter Demo',   450,  50, 'full_service'),
    ('Curtain Cleaning', 350,  40, 'full_service'),
    ('downy',            350,  40, 'full_service'),
    ('Pillowcases',      250, 100, 'full_service'),
    ('Trash Bag Large',  200, 100, 'full_service'),
    ('Uniform & Palda',  350, 300, 'full_service'),
    ('Wash & Fold',      300,  35, 'full_service'),
    ('Wash & Fold Demo', 300,  35, 'full_service')
  ) AS service(name, load_price, excess_price, workflow);

  -- Keep loyalty on. Customers start earning from now, with the current
  -- milestones (discount at 5 orders, free load at 10).
  UPDATE public.settings
  SET loyalty_enabled = TRUE,
      loyalty_program_started_at = now(),
      updated_at = now();

  -- Last step, so it only happens once everything above has worked.
  PERFORM setval('public.order_number_sequence', 1, false);
END;
$$;

SELECT
  (SELECT count(*) FROM public.service_types) AS services,
  (SELECT count(*) FROM public.orders) AS orders,
  (SELECT count(*) FROM public.customers) AS customers,
  (SELECT count(*) FROM public.inventory_items) AS inventory_items,
  (SELECT count(*) FROM public.staff WHERE deleted_at IS NULL) AS active_staff,
  (SELECT count(*) FROM public.branches WHERE is_active) AS active_branches,
  (SELECT loyalty_enabled FROM public.settings LIMIT 1) AS loyalty_on;
