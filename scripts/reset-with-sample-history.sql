-- RESET WITH SAMPLE HISTORY for the I&C Laundry database — BEFORE LAUNCH ONLY.
--
-- Deletes every customer, order, payment, refund, supply, expense, AI
-- forecast, email/SMS log, pending email/password code and audit-log entry,
-- then rebuilds the shop with 60 days of realistic history at every active
-- branch. 60 days of daily history puts the Analytics forecast at medium
-- confidence (28–89 days of history).
--
-- Keeps: staff accounts and their logins, branches and the Settings page.
-- Creates:
--   * 9 services (Wash & Fold, Wash & Fold with Downy, Air Dry, Comforter,
--     Blanket Cleaning, Curtain Cleaning, Pillowcases, Uniform & Palda,
--     Trash Bag Large) at their current prices.
--   * At every branch: supplies, automatic per-load deductions and 5 paid
--     add-ons (extra fabric conditioner, color-safe bleach, stain remover,
--     scent booster, hangers).
--   * About 1,400 orders over 60 days, made through the real order function so
--     prices, loyalty discounts and stock deductions follow the shop's rules;
--     cash payments at drop-off and pickup; restocks when supplies run low;
--     rent, utilities, LPG and salaries; and today's orders still in progress.
--   Customer emails are left blank, so the system never emails these customers.
--
-- This history is generated. Do not report it as real business results.
--
-- How to run: paste the whole file into the SQL Editor, replace the empty
-- confirmation text below with RESET_WITH_SAMPLE_HISTORY, and run it once.
-- It runs as one step: if anything fails, nothing is changed. Never run it
-- after the shop has started recording real orders.

DO $$
DECLARE
  v_confirmation TEXT := '';
  v_days CONSTANT INTEGER := 60;
  v_admin UUID;
  v_today DATE := (now() AT TIME ZONE 'Asia/Manila')::DATE;
  v_first_day DATE;
  v_day DATE;
  v_day_index INTEGER;
  v_branch RECORD;
  v_item RECORD;
  v_order public.orders;
  v_order_id UUID;
  v_staff UUID[];
  v_creator UUID; v_worker UUID; v_releaser UUID;
  v_count INTEGER;
  v_multiplier NUMERIC;
  v_minute INTEGER;
  v_start TIMESTAMPTZ; v_proc TIMESTAMPTZ; v_ready TIMESTAMPTZ; v_pickup TIMESTAMPTZ; v_cancel TIMESTAMPTZ; v_last TIMESTAMPTZ;
  v_stage TEXT;
  v_plan TEXT;
  v_paid_now NUMERIC;
  v_total NUMERIC;
  v_items JSONB; v_addons JSONB;
  v_service TEXT; v_second TEXT; v_weight NUMERIC;
  v_addon_kind TEXT; v_addon UUID; v_qty INTEGER;
  v_global INTEGER := 0;
  v_pool INTEGER;
  v_pick INTEGER;
  v_phone TEXT; v_name TEXT;
  v_r NUMERIC;
  v_eta INTEGER;
  v_local TIME;
  v_reason TEXT;
  v_id UUID;
  v_prefixes TEXT[] := ARRAY['0917','0918','0919','0920','0921','0927','0928','0939','0945','0947','0950','0956','0961','0966','0977','0995','0998'];
  v_first_names TEXT[] := ARRAY['Maria','Jose','Ana','Juan','Mark','Angelica','Kristine','John Paul','Princess','Jerome','Rhea','Carlo',
    'Liza','Ramon','Joy','Patrick','Shiela','Arnel','Cristina','Michael','Rowena','Jayson','Lorna','Kevin','Marites','Paolo',
    'Jennifer','Rodel','Camille','Ernesto','Grace','Nikki','Rolando','Aileen','Vincent','Marissa','Dennis','Hazel','Francis',
    'Lovely','Edgar','Janine','Ricardo','Mae','Christian','Teresita','Allan','Kimberly','Romeo','Jasmine','Ferdinand','Aira',
    'Benjie','Charmaine','Eduardo','Bea','Gilbert','Danica','Reynaldo','Trisha','Noel','Clarisse','Wilfredo','Erica','Junjun','Abigail'];
  v_last_names TEXT[] := ARRAY['Santos','Reyes','Cruz','Bautista','Ocampo','Garcia','Mendoza','Torres','Castillo','Flores',
    'Villanueva','Ramos','Aquino','Dela Cruz','Gonzales','Lopez','Hernandez','Perez','Marasigan','Macalintal','Ilagan',
    'Panganiban','Mercado','Comia','Dimaculangan','Atienza','Magsino','Malabanan','Landicho','Arellano','Delos Reyes',
    'Ramirez','Navarro','Salazar','Pascual','Valdez','Manalo','Dimayuga','Rosales','Aguilar','Evangelista','De Castro',
    'Medina','Umali','Katigbak','Mendiola','Ebora','Coronel','Silang','Gutierrez','Morales','Soriano','Javier','Agustin',
    'Mangubat','Lualhati','Alcantara','Briones','Caringal','Dela Rosa','Leynes','Matienzo','Tolentino','Yap','Sy'];
  v_cancel_reasons TEXT[] := ARRAY['Customer changed their mind', 'Customer will bring the laundry another day', 'Entered twice by mistake'];
  v_bad INTEGER;
BEGIN
  IF v_confirmation <> 'RESET_WITH_SAMPLE_HISTORY' THEN
    RAISE EXCEPTION 'Stopped: replace the empty confirmation text with RESET_WITH_SAMPLE_HISTORY, then run again. Nothing was changed.';
  END IF;
  SELECT id INTO v_admin FROM public.staff
  WHERE lower(role) = 'admin' AND deleted_at IS NULL ORDER BY created_at LIMIT 1;
  IF v_admin IS NULL THEN RAISE EXCEPTION 'Stopped: an active administrator is required. Nothing was changed.'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.branches WHERE is_active IS TRUE AND name IS NOT NULL) THEN
    RAISE EXCEPTION 'Stopped: no active branches. Nothing was changed.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.settings) THEN RAISE EXCEPTION 'Stopped: the settings row is missing. Nothing was changed.'; END IF;
  -- Some 10th-order free loads cost nothing; they can be released only with this fix.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'zz_zero_total_orders_are_paid' AND tgrelid = 'public.orders'::regclass) THEN
    RAISE EXCEPTION 'Stopped: run supabase_migrations/20261114_zzzz_free_orders_count_as_paid.sql first. Nothing was changed.';
  END IF;

  PERFORM setseed(0.2026);
  PERFORM set_config('app.audit_actor_staff_id', v_admin::TEXT, TRUE);
  v_first_day := v_today - v_days;

  -- ---------- 1. Start clean ----------
  TRUNCATE TABLE
    public.ai_forecasts, public.audit_logs, public.customer_branches, public.customers,
    public.email_change_otps, public.email_delivery_audit, public.expenses,
    public.inventory_adjustments, public.inventory_categories, public.inventory_items,
    public.inventory_restocks, public.inventory_usage_log, public.loyalty_rewards,
    public.order_item_addons, public.order_items, public.order_refunds, public.order_stage_history,
    public.orders, public.password_change_otps, public.payments, public.service_addon_items,
    public.service_inventory_requirements, public.service_types, public.sms_log
  RESTART IDENTITY;
  PERFORM setval('public.order_number_sequence', 1, false);

  -- Loyalty counts orders from the start of the history.
  UPDATE public.settings
  SET loyalty_enabled = TRUE,
      loyalty_program_started_at = ((v_first_day - 1)::TIMESTAMP AT TIME ZONE 'Asia/Manila'),
      updated_at = now();

  -- ---------- 2. Services ----------
  CREATE TEMP TABLE seed_services (name TEXT PRIMARY KEY, id UUID, share NUMERIC, units INTEGER, washes BOOLEAN,
    min_kg NUMERIC, max_kg NUMERIC) ON COMMIT DROP;
  INSERT INTO public.service_types
    (name, description, bundle_kg, bundle_price, excess_kg_price, price_per_kg, estimated_minutes, processing_type, is_active)
  VALUES
    ('Wash & Fold', 'Washed, dried and neatly folded. The price covers one 8 kg load.', 8, 300, 35, 37.50, 120, 'full_service', TRUE),
    ('Wash & Fold with Downy', 'Wash & Fold with extra Downy fabric conditioner for a longer-lasting scent.', 8, 350, 40, 43.75, 120, 'full_service', TRUE),
    ('Air Dry', 'Air-drying only, for items that are already washed.', 8, 260, 25, 32.50, 120, 'air_dry_only', TRUE),
    ('Comforter', 'Comforters and duvets, washed and dried.', 8, 450, 50, 56.25, 120, 'full_service', TRUE),
    ('Blanket Cleaning', 'Blankets and throws, washed and dried.', 8, 300, 35, 37.50, 120, 'full_service', TRUE),
    ('Curtain Cleaning', 'Curtains and drapes, washed, dried and folded.', 8, 350, 40, 43.75, 120, 'full_service', TRUE),
    ('Pillowcases', 'Pillowcases and pillow covers.', 8, 250, 100, 31.25, 120, 'full_service', TRUE),
    ('Uniform & Palda', 'School and office uniforms and skirts, washed and neatly hung.', 8, 350, 300, 43.75, 120, 'full_service', TRUE),
    ('Trash Bag Large', 'One large bag of mixed laundry, washed, dried and folded.', 8, 200, 100, 25.00, 120, 'full_service', TRUE);
  -- share: how often each service is ordered; units: detergent and conditioner per load.
  INSERT INTO seed_services(name, share, units, washes, min_kg, max_kg) VALUES
    ('Wash & Fold', 0.50, 1, TRUE, 4, 14), ('Wash & Fold with Downy', 0.12, 1, TRUE, 4, 12),
    ('Air Dry', 0.04, 0, FALSE, 4, 10), ('Comforter', 0.07, 2, TRUE, 3, 7),
    ('Blanket Cleaning', 0.06, 2, TRUE, 3, 8), ('Curtain Cleaning', 0.05, 2, TRUE, 3, 9),
    ('Pillowcases', 0.04, 1, TRUE, 1, 4), ('Uniform & Palda', 0.07, 1, TRUE, 2, 6),
    ('Trash Bag Large', 0.05, 1, TRUE, 5, 12);
  UPDATE seed_services s SET id = t.id FROM public.service_types t WHERE t.name = s.name;

  -- ---------- 3. Branches, staff, supplies, deductions and add-ons ----------
  CREATE TEMP TABLE seed_branches (id UUID PRIMARY KEY, name TEXT, branch_no INTEGER, base NUMERIC, staff UUID[]) ON COMMIT DROP;
  INSERT INTO seed_branches(id, name, branch_no, base)
  SELECT id, name, row_number() OVER (ORDER BY name, id),
    CASE WHEN name ILIKE 'Main%' THEN 11 WHEN name ILIKE '%Calzada%' THEN 8 ELSE 6 END
  FROM public.branches WHERE is_active IS TRUE AND name IS NOT NULL;
  UPDATE seed_branches b SET staff = COALESCE((SELECT array_agg(s.id ORDER BY s.created_at) FROM public.staff s
    WHERE s.branch_id = b.id AND lower(s.role) = 'staff' AND s.deleted_at IS NULL), ARRAY[v_admin]);

  CREATE TEMP TABLE seed_items (branch_id UUID, kind TEXT, id UUID, par NUMERIC, reorder NUMERIC, unit_cost NUMERIC,
    hold_from INTEGER, PRIMARY KEY (branch_id, kind)) ON COMMIT DROP;
  CREATE TEMP TABLE seed_addons (branch_id UUID, service_id UUID, kind TEXT, id UUID, price NUMERIC) ON COMMIT DROP;
  CREATE TEMP TABLE seed_pool (branch_id UUID, n INTEGER, phone TEXT, name TEXT, PRIMARY KEY (branch_id, n)) ON COMMIT DROP;

  FOR v_branch IN SELECT * FROM seed_branches ORDER BY branch_no LOOP
    FOR v_item IN SELECT * FROM (VALUES
        ('detergent', 'Powder Detergent', 'sachets', 25, 0.45, 9),
        ('conditioner', 'Fabric Conditioner', 'sachets', 26, 0.45, 8),
        ('bag', 'Plastic Laundry Bag', 'pcs', 22, 0.45, 2),
        ('bleach', 'Color-Safe Bleach', 'sachets', 4, 0.30, 7),
        ('stain', 'Stain Remover', 'sachets', 4, 0.30, 12),
        ('scent', 'Scent Booster', 'sachets', 4, 0.30, 9),
        ('hanger', 'Hanger', 'pcs', 12, 0.30, 4)
      ) AS t(kind, label, unit, par_per_order, reorder_share, unit_cost)
    LOOP
      SELECT id INTO v_id FROM public.create_branch_inventory_item(v_branch.id, v_admin, v_item.label, v_item.unit,
        round(v_branch.base * v_item.par_per_order), round(v_branch.base * v_item.par_per_order * CASE WHEN v_item.reorder_share > 0.4 THEN 0.2 ELSE 0.25 END),
        round(v_branch.base * v_item.par_per_order) * v_item.unit_cost, '');
      INSERT INTO seed_items VALUES (v_branch.id, v_item.kind, v_id, round(v_branch.base * v_item.par_per_order),
        round(v_branch.base * v_item.par_per_order * v_item.reorder_share), v_item.unit_cost,
        -- Two add-on supplies are left to run low in the last days, as happens in a real shop.
        CASE WHEN v_branch.name ILIKE '%Calzada%' AND v_item.kind = 'hanger' THEN v_days - 25
          WHEN v_branch.name ILIKE '%Nasugbu%' AND v_item.kind = 'bleach' THEN 10 ELSE NULL END);
    END LOOP;

    -- Automatic deductions per load.
    INSERT INTO public.service_inventory_requirements(branch_id, service_type_id, inventory_item_id, quantity_per_load, is_active)
    SELECT v_branch.id, s.id, i.id, CASE WHEN i.kind = 'bag' THEN 1 ELSE s.units + CASE WHEN s.name = 'Wash & Fold with Downy' AND i.kind = 'conditioner' THEN 1 ELSE 0 END END, TRUE
    FROM seed_services s JOIN seed_items i ON i.branch_id = v_branch.id
    WHERE i.kind = 'bag' OR (s.washes AND i.kind IN ('detergent', 'conditioner'));

    -- Paid add-ons.
    INSERT INTO public.service_addon_items(branch_id, service_type_id, inventory_item_id, unit_price, is_active)
    SELECT v_branch.id, s.id, i.id, a.price, TRUE
    FROM seed_services s
    JOIN (VALUES ('conditioner', 15), ('bleach', 15), ('stain', 20), ('scent', 15), ('hanger', 5)) AS a(kind, price) ON TRUE
    JOIN seed_items i ON i.branch_id = v_branch.id AND i.kind = a.kind
    WHERE (a.kind <> 'hanger' AND s.washes) OR (a.kind = 'hanger' AND s.name IN ('Uniform & Palda', 'Curtain Cleaning'));
    INSERT INTO seed_addons
    SELECT a.branch_id, a.service_type_id, i.kind, a.id, a.unit_price
    FROM public.service_addon_items a JOIN seed_items i ON i.id = a.inventory_item_id
    WHERE a.branch_id = v_branch.id;
  END LOOP;

  -- Opening stock, and what it cost, is dated the morning the history starts.
  UPDATE public.inventory_items SET created_at = ((v_first_day + time '07:00')::TIMESTAMP AT TIME ZONE 'Asia/Manila');
  UPDATE public.inventory_restocks SET restocked_at = ((v_first_day + time '07:00')::TIMESTAMP AT TIME ZONE 'Asia/Manila');
  UPDATE public.expenses SET expense_date = v_first_day WHERE category = 'inventory';

  -- ---------- 4. Day by day ----------
  FOR v_day_index IN 0..v_days LOOP
    v_day := v_first_day + v_day_index;
    FOR v_branch IN SELECT * FROM seed_branches ORDER BY branch_no LOOP

      -- Morning restock of anything below its reorder level.
      FOR v_item IN SELECT * FROM seed_items WHERE branch_id = v_branch.id LOOP
        IF v_item.hold_from IS NOT NULL AND v_day_index >= v_item.hold_from THEN CONTINUE; END IF;
        IF (SELECT current_stock FROM public.inventory_items WHERE id = v_item.id) < v_item.reorder THEN
          PERFORM public.restock_branch_inventory(v_item.id,
            v_item.par - (SELECT current_stock FROM public.inventory_items WHERE id = v_item.id),
            (v_item.par - (SELECT current_stock FROM public.inventory_items WHERE id = v_item.id)) * v_item.unit_cost, '');
          UPDATE public.inventory_restocks SET restocked_at = ((v_day + time '07:30')::TIMESTAMP AT TIME ZONE 'Asia/Manila')
          WHERE item_id = v_item.id AND restocked_at >= now();
          -- The restock records its cost as an expense dated today; date it on the restock day.
          UPDATE public.expenses SET expense_date = v_day
          WHERE category = 'inventory' AND branch_id = v_branch.id AND expense_date = CURRENT_DATE AND description LIKE 'Restock:%';
        END IF;
      END LOOP;

      -- Running costs.
      IF extract(day FROM v_day) = 1 THEN
        INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
        VALUES ('Rent', 'Monthly space rental', CASE v_branch.branch_no WHEN 1 THEN 6500 WHEN 2 THEN 5500 ELSE 8000 END, v_day, v_branch.name, v_branch.id);
      END IF;
      IF extract(day FROM v_day) = 10 THEN
        INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
        VALUES ('Utilities', 'Electricity bill', round(v_branch.base * 520 + random() * 900), v_day, v_branch.name, v_branch.id);
      END IF;
      IF extract(day FROM v_day) = 12 THEN
        INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
        VALUES ('Utilities', 'Water bill', round(v_branch.base * 95 + random() * 200), v_day, v_branch.name, v_branch.id);
      END IF;
      IF extract(isodow FROM v_day) = 1 THEN
        INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
        VALUES ('Fuel', 'LPG refill for the dryers', round(v_branch.base * 80 + random() * 150), v_day, v_branch.name, v_branch.id);
      END IF;
      IF extract(day FROM v_day) IN (15, 30) THEN
        INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
        VALUES ('Salaries', 'Staff salaries (half month)', 5500 * cardinality(v_branch.staff), v_day, v_branch.name, v_branch.id);
      END IF;
      IF v_day_index = 27 AND v_branch.branch_no = 3 THEN
        INSERT INTO public.expenses(category, description, amount, expense_date, branch, branch_id)
        VALUES ('Maintenance', 'Dryer belt replacement', 1850, v_day, v_branch.name, v_branch.id);
      END IF;

      -- How busy the day is: weekends are busiest, Undas is quiet, and the shop grows slowly.
      v_multiplier := CASE extract(isodow FROM v_day)::INT WHEN 1 THEN 0.85 WHEN 2 THEN 0.80 WHEN 3 THEN 0.90
        WHEN 4 THEN 0.95 WHEN 5 THEN 1.10 WHEN 6 THEN 1.35 ELSE 1.25 END
        * (0.92 + 0.16 * v_day_index / v_days)
        * CASE WHEN to_char(v_day, 'MM-DD') IN ('11-01', '11-02') THEN 0.55 ELSE 1 END
        * (0.80 + 0.40 * random());
      v_count := GREATEST(1, round(v_branch.base * v_multiplier));

      FOR v_minute IN
        SELECT m FROM (SELECT CASE WHEN r < 0.35 THEN 420 + floor(random() * 180) WHEN r < 0.60 THEN 600 + floor(random() * 240)
          ELSE 840 + floor(random() * 270) END::INT AS m FROM (SELECT random() AS r FROM generate_series(1, v_count)) x) y ORDER BY m
      LOOP
        v_start := ((v_day + make_interval(mins => v_minute))::TIMESTAMP AT TIME ZONE 'Asia/Manila');
        IF v_start > now() - interval '10 minutes' THEN CONTINUE; END IF;

        -- Who: a new walk-in or a returning customer; a few are served at two branches.
        SELECT count(*) INTO v_pool FROM seed_pool WHERE branch_id = v_branch.id;
        IF v_pool = 0 OR random() < (CASE WHEN v_day_index < 7 THEN 0.75 WHEN v_day_index < 21 THEN 0.45 ELSE 0.28 END) THEN
          v_global := v_global + 1;
          v_phone := v_prefixes[1 + v_global % 17] || lpad((1000000 + (v_global::BIGINT * 104729) % 9000000)::TEXT, 7, '0');
          v_name := v_first_names[1 + (v_global * 37) % cardinality(v_first_names)] || ' '
            || v_last_names[1 + (v_global * 53 + v_global / 11) % cardinality(v_last_names)];
          INSERT INTO seed_pool VALUES (v_branch.id, v_pool + 1, v_phone, v_name);
        ELSIF random() < 0.04 AND EXISTS (SELECT 1 FROM seed_pool WHERE branch_id <> v_branch.id) THEN
          SELECT phone, name INTO v_phone, v_name FROM seed_pool WHERE branch_id <> v_branch.id ORDER BY random() LIMIT 1;
        ELSE
          v_pick := 1 + floor(v_pool * power(random(), 1.35))::INT;
          SELECT phone, name INTO v_phone, v_name FROM seed_pool WHERE branch_id = v_branch.id AND n = LEAST(v_pick, v_pool);
        END IF;

        -- What: services, weights and add-ons.
        v_r := random();
        SELECT name INTO v_service FROM (SELECT name, sum(share) OVER (ORDER BY share DESC, name) AS upto FROM seed_services) c
        WHERE upto >= v_r ORDER BY upto LIMIT 1;
        v_service := COALESCE(v_service, 'Wash & Fold');
        SELECT round((min_kg + (max_kg - min_kg) * (random() + random()) / 2) * 2) / 2 INTO v_weight FROM seed_services WHERE name = v_service;
        v_items := jsonb_build_array(jsonb_build_object('service_type_id', (SELECT id FROM seed_services WHERE name = v_service), 'weight_kg', v_weight));
        IF random() < 0.13 THEN
          SELECT name INTO v_second FROM seed_services WHERE name IN ('Comforter', 'Blanket Cleaning', 'Curtain Cleaning', 'Pillowcases', 'Uniform & Palda')
            AND name <> v_service ORDER BY random() LIMIT 1;
          SELECT round((min_kg + (max_kg - min_kg) * random()) * 2) / 2 INTO v_weight FROM seed_services WHERE name = v_second;
          v_items := v_items || jsonb_build_object('service_type_id', (SELECT id FROM seed_services WHERE name = v_second), 'weight_kg', v_weight);
        END IF;
        v_addons := '{}'::JSONB;
        IF v_service NOT IN ('Air Dry') AND random() < 0.22 THEN
          v_r := random();
          v_addon_kind := CASE WHEN v_r < 0.40 THEN 'conditioner' WHEN v_r < 0.65 THEN 'bleach' WHEN v_r < 0.85 THEN 'stain' ELSE 'scent' END;
          v_qty := CASE WHEN random() < 0.1 THEN 2 ELSE 1 END;
          SELECT a.id INTO v_addon FROM seed_addons a JOIN seed_items i ON i.branch_id = a.branch_id AND i.kind = a.kind
          JOIN public.inventory_items inv ON inv.id = i.id
          WHERE a.branch_id = v_branch.id AND a.service_id = (SELECT id FROM seed_services WHERE name = v_service)
            AND a.kind = v_addon_kind AND inv.current_stock >= v_qty + 1;
          IF v_addon IS NOT NULL THEN v_addons := jsonb_build_object(v_addon::TEXT, v_qty); END IF;
        END IF;
        IF v_service IN ('Uniform & Palda', 'Curtain Cleaning') AND random() < 0.4 THEN
          v_qty := 2 + floor(random() * 7)::INT;
          SELECT a.id INTO v_addon FROM seed_addons a JOIN seed_items i ON i.branch_id = a.branch_id AND i.kind = a.kind
          JOIN public.inventory_items inv ON inv.id = i.id
          WHERE a.branch_id = v_branch.id AND a.service_id = (SELECT id FROM seed_services WHERE name = v_service)
            AND a.kind = 'hanger' AND inv.current_stock >= v_qty + 1;
          IF v_addon IS NOT NULL THEN v_addons := v_addons || jsonb_build_object(v_addon::TEXT, v_qty); END IF;
        END IF;

        -- Who handles it.
        v_creator := CASE WHEN random() < 0.05 THEN v_admin ELSE v_branch.staff[1 + floor(random() * cardinality(v_branch.staff))::INT] END;
        v_worker := v_branch.staff[1 + floor(random() * cardinality(v_branch.staff))::INT];
        v_releaser := v_branch.staff[1 + floor(random() * cardinality(v_branch.staff))::INT];

        v_order := public.create_branch_order(v_branch.id, v_creator,
          jsonb_build_object('name', v_name, 'phone', v_phone, 'email', ''),
          jsonb_build_object('client_request_id', gen_random_uuid(), 'amount_paid', 0, 'payment_method', 'cash', 'items', v_items),
          v_addons, 0, NULL);
        v_order_id := v_order.id;
        v_total := v_order.total_price;
        -- Order numbers carry the date the order was taken.
        UPDATE public.orders SET order_number = 'IC-' || to_char(v_start AT TIME ZONE 'Asia/Manila', 'YYYYMMDD') || substr(order_number, 12)
        WHERE id = v_order_id;

        -- When: washing starts soon after drop-off; most customers collect the same or next day.
        v_eta := COALESCE(v_order.estimated_processing_minutes, 120);
        v_proc := v_start + make_interval(mins => 10 + floor(random() * 40)::INT);
        v_ready := v_proc + make_interval(mins => GREATEST(45, v_eta - 15 + floor(random() * 55)::INT));
        v_r := random();
        IF v_r < 0.55 THEN
          v_pickup := v_ready + make_interval(mins => 30 + floor(random() * 150)::INT);
          v_local := (v_pickup AT TIME ZONE 'Asia/Manila')::TIME;
          IF v_local > time '20:00' OR v_local < time '07:00' THEN
            v_pickup := (((v_ready AT TIME ZONE 'Asia/Manila')::DATE + 1 + time '08:30')::TIMESTAMP AT TIME ZONE 'Asia/Manila')
              + make_interval(mins => floor(random() * 210)::INT);
          END IF;
        ELSIF v_r < 0.90 THEN
          v_pickup := (((v_ready AT TIME ZONE 'Asia/Manila')::DATE + 1 + time '09:00')::TIMESTAMP AT TIME ZONE 'Asia/Manila')
            + make_interval(mins => floor(random() * 540)::INT);
        ELSE
          v_pickup := (((v_ready AT TIME ZONE 'Asia/Manila')::DATE + 2 + floor(random() * 2)::INT + time '10:00')::TIMESTAMP AT TIME ZONE 'Asia/Manila')
            + make_interval(mins => floor(random() * 420)::INT);
        END IF;
        v_stage := CASE WHEN v_proc > now() THEN 'received' WHEN v_ready > now() THEN 'on_process'
          WHEN v_pickup > now() THEN 'ready' ELSE 'released' END;

        -- How they pay: in full at drop-off, a deposit, or everything at pickup.
        v_r := random();
        v_plan := CASE WHEN v_total <= 0 THEN 'free' WHEN v_r < 0.45 THEN 'full' WHEN v_r < 0.75 THEN 'deposit' ELSE 'pickup' END;

        IF v_plan = 'pickup' AND v_stage = 'released' AND v_day_index < v_days - 1 AND random() < 0.03 THEN
          -- A few unpaid orders are cancelled before washing.
          v_cancel := v_start + make_interval(mins => 20 + floor(random() * 120)::INT);
          v_reason := v_cancel_reasons[1 + floor(random() * cardinality(v_cancel_reasons))::INT];
          PERFORM public.cancel_branch_order(v_order_id, v_creator, v_reason);
          UPDATE public.orders SET created_at = v_start, cancelled_at = v_cancel, updated_at = v_cancel, stage_started_at = v_cancel,
            last_status_changed_at = v_cancel, estimated_ready_at = v_start + make_interval(mins => v_eta),
            original_estimated_ready_at = v_start + make_interval(mins => v_eta)
          WHERE id = v_order_id;
          UPDATE public.order_items SET created_at = v_start, updated_at = v_cancel WHERE order_id = v_order_id;
          UPDATE public.inventory_usage_log SET logged_at = v_start, reversed_at = v_cancel WHERE order_id = v_order_id;
          UPDATE public.inventory_adjustments SET created_at = v_cancel WHERE order_id = v_order_id;
          UPDATE public.order_item_addons SET created_at = v_start WHERE order_item_id IN (SELECT id FROM public.order_items WHERE order_id = v_order_id);
          UPDATE public.order_stage_history SET changed_at = CASE WHEN status = 'received' THEN v_start ELSE v_cancel END WHERE order_id = v_order_id;
          UPDATE public.loyalty_rewards SET created_at = v_start WHERE earned_order_id = v_order_id AND created_at >= now();
          UPDATE public.customers SET created_at = LEAST(created_at, v_start) WHERE id = v_order.customer_id;
          UPDATE public.customer_branches SET first_served_at = LEAST(first_served_at, v_start), last_served_at = v_start
          WHERE customer_id = v_order.customer_id AND branch_id = v_branch.id;
          CONTINUE;
        END IF;

        v_paid_now := CASE v_plan WHEN 'full' THEN v_total
          WHEN 'deposit' THEN LEAST(v_total, CASE WHEN random() < 0.5 THEN round(v_total / 2) WHEN v_total >= 300 THEN 200 ELSE 100 END)
          ELSE 0 END;
        IF v_paid_now > 0 THEN
          INSERT INTO public.payments(order_id, amount, payment_method, payment_status, payment_date, paid_at, created_at, received_by_staff_id, source)
          VALUES (v_order_id, v_paid_now, 'cash', CASE WHEN v_paid_now >= v_total THEN 'paid' ELSE 'partial' END,
            v_start + interval '2 minutes', v_start + interval '2 minutes', v_start + interval '2 minutes', v_creator, 'order_summary_sync');
        END IF;
        IF v_stage IN ('on_process', 'ready', 'released') THEN
          PERFORM public.transition_all_order_items(v_order_id, v_worker, 'on_process');
        END IF;
        IF v_stage IN ('ready', 'released') THEN
          PERFORM public.transition_all_order_items(v_order_id, v_worker, 'completed');
        END IF;
        IF v_stage = 'released' THEN
          IF v_total - v_paid_now > 0 THEN
            INSERT INTO public.payments(order_id, amount, payment_method, payment_status, payment_date, paid_at, created_at, received_by_staff_id, source)
            VALUES (v_order_id, v_total - v_paid_now, 'cash', 'paid', v_pickup, v_pickup, v_pickup, v_releaser, 'release_collection');
          END IF;
          PERFORM public.transition_branch_order(v_order_id, v_releaser, 'released', NULL);
        END IF;

        -- Date everything this order created.
        v_last := CASE v_stage WHEN 'received' THEN v_start WHEN 'on_process' THEN v_proc WHEN 'ready' THEN v_ready ELSE v_pickup END;
        UPDATE public.orders SET created_at = v_start, updated_at = v_last, stage_started_at = v_last, last_status_changed_at = v_last,
          processing_started_at = CASE WHEN v_stage <> 'received' THEN v_proc END,
          ready_at = CASE WHEN v_stage IN ('ready', 'released') THEN v_ready END,
          actual_completion = CASE WHEN v_stage IN ('ready', 'released') THEN v_ready END,
          picked_up_at = CASE WHEN v_stage = 'released' THEN v_pickup END,
          estimated_ready_at = v_start + make_interval(mins => v_eta),
          original_estimated_ready_at = v_start + make_interval(mins => v_eta)
        WHERE id = v_order_id;
        UPDATE public.order_items SET created_at = v_start, updated_at = v_last,
          processing_started_at = CASE WHEN v_stage <> 'received' THEN v_proc END,
          completed_at = CASE WHEN v_stage IN ('ready', 'released') THEN v_ready END
        WHERE order_id = v_order_id;
        UPDATE public.inventory_usage_log SET logged_at = v_start WHERE order_id = v_order_id;
        UPDATE public.order_item_addons SET created_at = v_start WHERE order_item_id IN (SELECT id FROM public.order_items WHERE order_id = v_order_id);
        UPDATE public.order_stage_history SET changed_at = CASE status WHEN 'received' THEN v_start WHEN 'on_process' THEN v_proc
          WHEN 'ready' THEN v_ready WHEN 'released' THEN v_pickup ELSE changed_at END WHERE order_id = v_order_id;
        UPDATE public.loyalty_rewards SET created_at = v_start WHERE earned_order_id = v_order_id AND created_at >= now();
        UPDATE public.customers SET created_at = LEAST(created_at, v_start) WHERE id = v_order.customer_id;
        UPDATE public.customer_branches SET first_served_at = LEAST(first_served_at, v_start), last_served_at = v_start
        WHERE customer_id = v_order.customer_id AND branch_id = v_branch.id;
      END LOOP;
    END LOOP;
  END LOOP;

  UPDATE public.expenses SET created_at = ((expense_date + time '18:00')::TIMESTAMP AT TIME ZONE 'Asia/Manila');

  -- ---------- 5. Checks: anything wrong undoes everything ----------
  SELECT count(*) INTO v_bad FROM public.orders o
  WHERE o.amount_paid IS DISTINCT FROM (SELECT COALESCE(sum(p.amount), 0) FROM public.payments p WHERE p.order_id = o.id)
     OR (o.status = 'released' AND ((o.payment_status <> 'paid' AND o.total_price > 0) OR o.amount_paid < o.total_price
       OR o.picked_up_at IS NULL OR o.ready_at IS NULL OR o.picked_up_at < o.ready_at))
     OR (o.ready_at IS NOT NULL AND o.ready_at <= o.processing_started_at)
     OR o.created_at > now()
     OR o.order_number NOT LIKE 'IC-' || to_char(o.created_at AT TIME ZONE 'Asia/Manila', 'YYYYMMDD') || '-%';
  IF v_bad > 0 THEN RAISE EXCEPTION 'Stopped: % generated orders failed the consistency check. Nothing was changed.', v_bad; END IF;
  IF EXISTS (SELECT 1 FROM public.inventory_items WHERE current_stock < 0) THEN
    RAISE EXCEPTION 'Stopped: a supply went below zero. Nothing was changed.';
  END IF;
  IF (SELECT count(DISTINCT (created_at AT TIME ZONE 'Asia/Manila')::DATE) FROM public.orders) < 50 THEN
    RAISE EXCEPTION 'Stopped: fewer than 50 days of history were created. Nothing was changed.';
  END IF;
END;
$$;

SELECT b.name AS branch,
  count(o.id) AS orders,
  count(DISTINCT (o.created_at AT TIME ZONE 'Asia/Manila')::DATE) AS days_of_history,
  min((o.created_at AT TIME ZONE 'Asia/Manila')::DATE) AS first_day,
  count(DISTINCT o.customer_id) AS customers,
  sum(o.amount_paid) FILTER (WHERE o.status <> 'cancelled') AS cash_collected,
  count(*) FILTER (WHERE o.status IN ('received', 'on_process', 'ready')) AS open_orders_now
FROM public.branches b LEFT JOIN public.orders o ON o.branch_id = b.id
WHERE b.is_active IS TRUE
GROUP BY b.name ORDER BY b.name;
