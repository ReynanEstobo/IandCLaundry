-- DESTRUCTIVE TEST-DATA RESET for the I&C Laundry Supabase project.
-- Before running: export a backup, review this entire file, and replace the
-- confirmation text below with RESET_TEST_DATA_ONLY.
--
-- Preserved: public.staff (including admin/staff profiles), auth.users,
-- public.branches, and public.settings. Branches are retained because staff
-- profiles and branch-scoped records depend on them. Settings are reset only
-- for the loyalty test scenario below. Other business/test rows are removed.
-- Run the whole file in Supabase SQL Editor as one execution.

DO $$
DECLARE
  v_confirmation TEXT := 'RESET_TEST_DATA_ONLY';
BEGIN
  IF v_confirmation <> 'RESET_TEST_DATA_ONLY' THEN
    RAISE EXCEPTION 'Reset stopped. Review this script and replace the confirmation text before running.';
  END IF;
END;
$$;

BEGIN;

DO $$
DECLARE
  v_admin_id UUID;
  v_active_branches INTEGER;
BEGIN
  SELECT id INTO v_admin_id
  FROM public.staff
  WHERE lower(role) = 'admin' AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1;

  SELECT count(*) INTO v_active_branches
  FROM public.branches
  WHERE is_active IS TRUE AND name IS NOT NULL;

  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'Reset stopped: an active admin staff profile is required.';
  END IF;
  IF v_active_branches < 3 THEN
    RAISE EXCEPTION 'Reset stopped: expected at least three active named branches, found %.', v_active_branches;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.settings) THEN
    RAISE EXCEPTION 'Reset stopped: the settings row is missing.';
  END IF;

  PERFORM set_config('app.audit_actor_staff_id', v_admin_id::TEXT, TRUE);
END;
$$;

-- Delete dependent operational/test records together. TRUNCATE is used here
-- to clear append-only audit tables without disabling or changing their guards.
-- No CASCADE is used: if the live schema has an unexpected dependency, the
-- transaction fails and rolls back instead of deleting an unlisted table.
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
  public.order_stage_history,
  public.orders,
  public.password_change_otps,
  public.payments,
  public.service_addon_items,
  public.service_inventory_requirements,
  public.service_types,
  public.sms_log
RESTART IDENTITY;

DO $$
DECLARE
  v_admin_id UUID;
  v_branch RECORD;
  v_branch_index INTEGER := 0;
  v_first_branch_id UUID;
  v_first_branch_name TEXT;
  v_wash_service_id UUID;
  v_comforter_service_id UUID;
  v_air_dry_service_id UUID;
  v_detergent_category_id UUID;
  v_supply_category_id UUID;
  v_detergent_id UUID;
  v_softener_id UUID;
  v_bag_id UUID;
  v_low_stock_id UUID;
  v_addon_id UUID;
  v_first_addon_id UUID;
  v_customer JSONB;
  v_order_payload JSONB;
  v_order public.orders;
  v_completed_order public.orders;
  v_seed_phone TEXT := '09999991000';
BEGIN
  SELECT id INTO v_admin_id
  FROM public.staff
  WHERE lower(role) = 'admin' AND deleted_at IS NULL
  ORDER BY created_at
  LIMIT 1;
  PERFORM set_config('app.audit_actor_staff_id', v_admin_id::TEXT, TRUE);

  -- Deterministic loyalty test: orders 1-4 can be completed normally; order 5
  -- receives the configured 50% discount and a 50% downpayment of its reduced total.
  UPDATE public.settings
  SET loyalty_enabled = TRUE,
      loyalty_discount_milestone = 5,
      loyalty_free_load_milestone = 10,
      loyalty_discount_percent = 50,
      loyalty_reward_expiry_days = 180,
      loyalty_program_started_at = now() - interval '1 day',
      updated_at = now();

  INSERT INTO public.inventory_categories(name) VALUES ('Cleaning supplies')
  RETURNING id INTO v_detergent_category_id;
  INSERT INTO public.inventory_categories(name) VALUES ('Packaging')
  RETURNING id INTO v_supply_category_id;

  INSERT INTO public.service_types
    (name, price_per_kg, estimated_minutes, description, is_active,
     bundle_kg, bundle_price, excess_kg_price, processing_type)
  VALUES
    ('Wash & Fold Demo', 37.50, 120, 'Seeded service for order and inventory testing.', TRUE, 8, 300, 35, 'full_service')
  RETURNING id INTO v_wash_service_id;
  INSERT INTO public.service_types
    (name, price_per_kg, estimated_minutes, description, is_active,
     bundle_kg, bundle_price, excess_kg_price, processing_type)
  VALUES
    ('Comforter Demo', 56.25, 180, 'Seeded bulky-item service for testing.', TRUE, 8, 450, 50, 'full_service')
  RETURNING id INTO v_comforter_service_id;
  INSERT INTO public.service_types
    (name, price_per_kg, estimated_minutes, description, is_active,
     bundle_kg, bundle_price, excess_kg_price, processing_type)
  VALUES
    ('Air Dry Demo', 32.50, 90, 'Seeded air-dry service for testing.', TRUE, 8, 260, 25, 'air_dry_only')
  RETURNING id INTO v_air_dry_service_id;

  -- Seed inventory, recipes, and one configurable add-on at each active branch.
  FOR v_branch IN
    SELECT id, name FROM public.branches WHERE is_active IS TRUE ORDER BY name LIMIT 3
  LOOP
    v_branch_index := v_branch_index + 1;
    IF v_branch_index = 1 THEN
      v_first_branch_id := v_branch.id;
      v_first_branch_name := v_branch.name;
    END IF;

    INSERT INTO public.inventory_items
      (category_id, name, unit, current_stock, minimum_stock, cost_per_unit, branch, branch_id)
    VALUES (v_detergent_category_id, 'Demo Detergent', 'L', 500, 40, 1.20, v_branch.name, v_branch.id)
    RETURNING id INTO v_detergent_id;
    INSERT INTO public.inventory_items
      (category_id, name, unit, current_stock, minimum_stock, cost_per_unit, branch, branch_id)
    VALUES (v_detergent_category_id, 'Demo Fabric Softener', 'L', 250, 25, 1.00, v_branch.name, v_branch.id)
    RETURNING id INTO v_softener_id;
    INSERT INTO public.inventory_items
      (category_id, name, unit, current_stock, minimum_stock, cost_per_unit, branch, branch_id)
    VALUES (v_supply_category_id, 'Demo Garment Bag', 'pcs', 100, 15, 3.00, v_branch.name, v_branch.id)
    RETURNING id INTO v_bag_id;
    INSERT INTO public.inventory_items
      (category_id, name, unit, current_stock, minimum_stock, cost_per_unit, branch, branch_id)
    VALUES (v_detergent_category_id, 'Demo Ariel Low Stock', 'bottles', 2, 10, 1.00, v_branch.name, v_branch.id)
    RETURNING id INTO v_low_stock_id;

    INSERT INTO public.inventory_restocks(item_id, quantity_added, cost_total, supplier, branch, branch_id)
    VALUES (v_detergent_id, 500, 600, NULL, v_branch.name, v_branch.id);

    INSERT INTO public.service_inventory_requirements
      (branch_id, service_type_id, inventory_item_id, quantity_per_load, is_active)
    VALUES
      (v_branch.id, v_wash_service_id, v_detergent_id, 0.10, TRUE),
      (v_branch.id, v_wash_service_id, v_softener_id, 0.05, TRUE),
      (v_branch.id, v_comforter_service_id, v_detergent_id, 0.15, TRUE);

    INSERT INTO public.service_addon_items
      (branch_id, service_type_id, inventory_item_id, unit_price, is_active)
    VALUES (v_branch.id, v_wash_service_id, v_bag_id, 20, TRUE)
    RETURNING id INTO v_addon_id;
    IF v_branch_index = 1 THEN
      v_first_addon_id := v_addon_id;
    END IF;

    INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
    VALUES ('Utilities', 'Demo monthly utility expense', 1250 + (v_branch_index * 100), CURRENT_DATE - 3, v_branch.name, v_branch.id);
  END LOOP;

  -- Create four completed, fully paid orders for one demo customer using the
  -- actual application RPC and transitions. This makes their fifth order a
  -- real 50%-reward order, not a hand-written fake order row.
  v_branch.id := v_first_branch_id;
  v_branch.name := v_first_branch_name;
  v_addon_id := v_first_addon_id;
  v_customer := jsonb_build_object(
    'name', 'Demo Loyalty Customer',
    'phone', v_seed_phone,
    'email', 'loyalty-customer@example.test'
  );

  FOR v_branch_index IN 1..4 LOOP
    v_order_payload := jsonb_build_object(
      'client_request_id', gen_random_uuid(),
      'amount_paid', 300,
      'payment_method', 'cash',
      'items', jsonb_build_array(jsonb_build_object('service_type_id', v_wash_service_id, 'weight_kg', 8))
    );
    v_completed_order := public.create_branch_order(
      v_branch.id, v_admin_id, v_customer, v_order_payload, '{}'::JSONB, 1, NULL
    );
    PERFORM public.transition_all_order_items(v_completed_order.id, v_admin_id, 'on_process');
    PERFORM public.transition_all_order_items(v_completed_order.id, v_admin_id, 'completed');
    PERFORM public.transition_branch_order(v_completed_order.id, v_admin_id, 'released', NULL);
  END LOOP;

  -- This fifth loyalty order has a raw total of 300, discounted total of 150,
  -- and a 75 deposit (exactly 50% of the discounted total). It remains active
  -- so it is easy to inspect in Orders and the loyalty-reward history.
  v_order_payload := jsonb_build_object(
    'client_request_id', gen_random_uuid(),
    'amount_paid', 75,
    'payment_method', 'cash',
    'items', jsonb_build_array(jsonb_build_object('service_type_id', v_wash_service_id, 'weight_kg', 8))
  );
  v_order := public.create_branch_order(
    v_branch.id, v_admin_id, v_customer, v_order_payload, '{}'::JSONB, 1, NULL
  );
  IF v_order.total_price <> 150 OR v_order.amount_paid <> 75 OR v_order.loyalty_discount_amount <> 150 THEN
    RAISE EXCEPTION 'Seed validation failed: expected the fifth demo loyalty order to be 150 total with a 75 deposit.';
  END IF;

  -- Additional order examples: add-on + deposit (received), processing, ready,
  -- and cancelled. These populate the main order/status/payment workflows.
  v_order_payload := jsonb_build_object(
    'client_request_id', gen_random_uuid(), 'amount_paid', 160, 'payment_method', 'cash',
    'items', jsonb_build_array(jsonb_build_object('service_type_id', v_wash_service_id, 'weight_kg', 8))
  );
  v_order := public.create_branch_order(
    v_branch.id, v_admin_id,
    jsonb_build_object('name','Demo Add-on Customer','phone','09999992001','email','addon-customer@example.test'),
    v_order_payload, jsonb_build_object(v_addon_id::TEXT, 1), 1, NULL
  );

  v_order_payload := jsonb_build_object(
    'client_request_id', gen_random_uuid(), 'amount_paid', 450, 'payment_method', 'cash',
    'items', jsonb_build_array(jsonb_build_object('service_type_id', v_comforter_service_id, 'weight_kg', 8))
  );
  v_order := public.create_branch_order(
    v_branch.id, v_admin_id,
    jsonb_build_object('name','Demo Processing Customer','phone','09999992002','email','processing-customer@example.test'),
    v_order_payload, '{}'::JSONB, 1, NULL
  );
  PERFORM public.transition_all_order_items(v_order.id, v_admin_id, 'on_process');

  v_order_payload := jsonb_build_object(
    'client_request_id', gen_random_uuid(), 'amount_paid', 300, 'payment_method', 'cash',
    'items', jsonb_build_array(jsonb_build_object('service_type_id', v_wash_service_id, 'weight_kg', 8))
  );
  v_order := public.create_branch_order(
    v_branch.id, v_admin_id,
    jsonb_build_object('name','Demo Ready Customer','phone','09999992003','email','ready-customer@example.test'),
    v_order_payload, '{}'::JSONB, 1, NULL
  );
  PERFORM public.transition_all_order_items(v_order.id, v_admin_id, 'on_process');
  PERFORM public.transition_all_order_items(v_order.id, v_admin_id, 'completed');

  v_order_payload := jsonb_build_object(
    'client_request_id', gen_random_uuid(), 'amount_paid', 150, 'payment_method', 'cash',
    'items', jsonb_build_array(jsonb_build_object('service_type_id', v_wash_service_id, 'weight_kg', 8))
  );
  v_order := public.create_branch_order(
    v_branch.id, v_admin_id,
    jsonb_build_object('name','Demo Cancelled Customer','phone','09999992004','email','cancelled-customer@example.test'),
    v_order_payload, '{}'::JSONB, 1, NULL
  );
  PERFORM public.cancel_branch_order(v_order.id, v_admin_id, 'Seeded cancelled order for test demonstrations');

  -- Commit-time sanity checks ensure the dataset is useful before commit.
  IF (SELECT count(*) FROM public.orders) < 8
     OR (SELECT count(*) FROM public.inventory_items) < 12
     OR (SELECT count(*) FROM public.expenses) < 3 THEN
    RAISE EXCEPTION 'Seed validation failed: expected demo orders, branch inventory, and expenses.';
  END IF;
END;
$$;

COMMIT;
