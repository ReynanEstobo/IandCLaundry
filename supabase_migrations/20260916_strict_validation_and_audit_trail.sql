-- Run after the existing 20260910 migrations.
-- Enforces core contact formats and upgrades audit_logs into an append-only,
-- structured change trail. Secrets (passwords, OTP hashes and tokens) are
-- never written to audit snapshots.
BEGIN;

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS event_category TEXT NOT NULL DEFAULT 'data_change',
  ADD COLUMN IF NOT EXISTS changed_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS reason TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'application',
  ADD COLUMN IF NOT EXISTS correlation_id UUID;

ALTER TABLE public.audit_logs DROP CONSTRAINT IF EXISTS audit_logs_action_check;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_action_check CHECK (action IN (
  'insert', 'update', 'delete', 'restore', 'cancel', 'provision',
  'credentials_reset', 'password_changed', 'email_changed',
  'order_transition', 'payment_collected', 'inventory_restock',
  'inventory_adjustment', 'system'
));

CREATE INDEX IF NOT EXISTS idx_audit_logs_event_created
  ON public.audit_logs(event_category, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created
  ON public.audit_logs(actor_staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_branch_created
  ON public.audit_logs(branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_changed_fields
  ON public.audit_logs USING GIN (changed_fields);

-- NOT VALID keeps this migration safe for historical records. New records and
-- any changed records are checked immediately.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_phone_format_check') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_phone_format_check
      CHECK (phone ~ '^09[0-9]{9}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_phone_format_check') THEN
    ALTER TABLE public.staff ADD CONSTRAINT staff_phone_format_check
      CHECK (phone IS NULL OR phone = '' OR phone ~ '^09[0-9]{9}$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_email_format_check') THEN
    ALTER TABLE public.customers ADD CONSTRAINT customers_email_format_check
      CHECK (email IS NULL OR email = '' OR email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_contact_email_format_check') THEN
    ALTER TABLE public.staff ADD CONSTRAINT staff_contact_email_format_check
      CHECK (contact_email IS NULL OR contact_email = '' OR contact_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.audit_sanitized_row(p_row JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(p_row, '{}'::jsonb) - ARRAY[
    'password', 'password_hash', 'encrypted_password', 'code_hash', 'otp',
    'token', 'access_token', 'refresh_token', 'recovery_token'
  ]
$$;

CREATE OR REPLACE FUNCTION public.audit_changed_fields(p_before JSONB, p_after JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(jsonb_object_agg(key,
    jsonb_build_object('before', p_before -> key, 'after', p_after -> key)), '{}'::jsonb)
  FROM (
    SELECT key
    FROM jsonb_object_keys(COALESCE(p_before, '{}'::jsonb) || COALESCE(p_after, '{}'::jsonb)) AS key
    WHERE (p_before -> key) IS DISTINCT FROM (p_after -> key)
      AND key <> ALL (ARRAY[
        'password', 'password_hash', 'encrypted_password', 'code_hash', 'otp',
        'token', 'access_token', 'refresh_token', 'recovery_token'
      ])
  ) changed
$$;

CREATE OR REPLACE FUNCTION public.capture_audit_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before JSONB := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE public.audit_sanitized_row(to_jsonb(OLD)) END;
  v_after JSONB := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE public.audit_sanitized_row(to_jsonb(NEW)) END;
  v_record_id UUID;
  v_branch_id UUID;
  v_actor_id UUID;
  v_action TEXT := lower(TG_OP);
  v_event_type TEXT := TG_TABLE_NAME || '_' || lower(TG_OP);
  v_category TEXT := 'data_change';
BEGIN
  -- Soft deletes/restores and order cancellation already include dedicated,
  -- application-supplied audit entries with the actor and reason.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('customers', 'staff', 'inventory_items',
      'inventory_categories', 'service_types', 'expenses')
     AND (v_before -> 'deleted_at') IS DISTINCT FROM (v_after -> 'deleted_at') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'orders'
     AND v_before -> 'status' IS DISTINCT FROM v_after -> 'status'
     AND v_after ->> 'status' = 'cancelled' THEN
    RETURN NEW;
  END IF;

  v_record_id := COALESCE(NULLIF(v_after ->> 'id', '')::UUID, NULLIF(v_before ->> 'id', '')::UUID);
  IF v_record_id IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  v_branch_id := COALESCE(
    NULLIF(v_after ->> 'branch_id', '')::UUID,
    NULLIF(v_before ->> 'branch_id', '')::UUID
  );
  v_actor_id := COALESCE(
    NULLIF(current_setting('app.audit_actor_staff_id', true), '')::UUID,
    NULLIF(v_after ->> 'last_updated_by_staff_id', '')::UUID,
    NULLIF(v_after ->> 'created_by_staff_id', '')::UUID,
    NULLIF(v_after ->> 'cancelled_by_staff_id', '')::UUID,
    NULLIF(v_after ->> 'deleted_by_staff_id', '')::UUID,
    NULLIF(v_before ->> 'last_updated_by_staff_id', '')::UUID,
    NULLIF(v_before ->> 'created_by_staff_id', '')::UUID
  );

  IF TG_TABLE_NAME = 'orders' AND TG_OP = 'UPDATE' AND v_before -> 'status' IS DISTINCT FROM v_after -> 'status' THEN
    v_action := 'order_transition'; v_event_type := 'order_status_changed'; v_category := 'operations';
  ELSIF TG_TABLE_NAME = 'orders' AND TG_OP = 'UPDATE' AND v_before -> 'amount_paid' IS DISTINCT FROM v_after -> 'amount_paid' THEN
    v_action := 'payment_collected'; v_event_type := 'order_payment_changed'; v_category := 'financial';
  ELSIF TG_TABLE_NAME = 'inventory_restocks' THEN
    v_action := 'inventory_restock'; v_event_type := 'inventory_restocked'; v_category := 'inventory';
  ELSIF TG_TABLE_NAME = 'inventory_adjustments' THEN
    v_action := 'inventory_adjustment'; v_event_type := 'inventory_adjusted'; v_category := 'inventory';
  ELSIF TG_TABLE_NAME = 'inventory_items' THEN
    v_category := 'inventory';
  ELSIF TG_TABLE_NAME = 'expenses' THEN
    v_category := 'financial';
  ELSIF TG_TABLE_NAME = 'settings' THEN
    v_category := 'configuration'; v_event_type := 'settings_changed';
  ELSIF TG_TABLE_NAME IN ('staff', 'customers') THEN
    v_category := 'accounts';
  END IF;

  INSERT INTO public.audit_logs(
    action, event_type, event_category, table_name, record_id, actor_staff_id,
    branch_id, before_data, after_data, changed_fields, source
  ) VALUES (
    v_action, v_event_type, v_category, TG_TABLE_NAME, v_record_id, v_actor_id,
    v_branch_id, v_before, v_after, public.audit_changed_fields(v_before, v_after), 'database_trigger'
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.prevent_audit_log_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Audit log entries are append-only and cannot be changed or removed.';
END $$;

DROP TRIGGER IF EXISTS tr_audit_logs_append_only ON public.audit_logs;
CREATE TRIGGER tr_audit_logs_append_only
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_log_mutation();

-- Tables with an id and material business changes. Additions are intentional:
-- raw authentication and OTP tables are excluded to prevent credential data
-- from entering the business audit trail.
DROP TRIGGER IF EXISTS tr_audit_customers ON public.customers;
CREATE TRIGGER tr_audit_customers AFTER INSERT OR UPDATE OR DELETE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_orders ON public.orders;
CREATE TRIGGER tr_audit_orders AFTER INSERT OR UPDATE OR DELETE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_staff ON public.staff;
CREATE TRIGGER tr_audit_staff AFTER INSERT OR UPDATE OR DELETE ON public.staff
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_inventory_items ON public.inventory_items;
CREATE TRIGGER tr_audit_inventory_items AFTER INSERT OR UPDATE OR DELETE ON public.inventory_items
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_inventory_categories ON public.inventory_categories;
CREATE TRIGGER tr_audit_inventory_categories AFTER INSERT OR UPDATE OR DELETE ON public.inventory_categories
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_service_types ON public.service_types;
CREATE TRIGGER tr_audit_service_types AFTER INSERT OR UPDATE OR DELETE ON public.service_types
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_expenses ON public.expenses;
CREATE TRIGGER tr_audit_expenses AFTER INSERT OR UPDATE OR DELETE ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_settings ON public.settings;
CREATE TRIGGER tr_audit_settings AFTER INSERT OR UPDATE OR DELETE ON public.settings
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_branches ON public.branches;
CREATE TRIGGER tr_audit_branches AFTER INSERT OR UPDATE OR DELETE ON public.branches
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_inventory_restocks ON public.inventory_restocks;
CREATE TRIGGER tr_audit_inventory_restocks AFTER INSERT OR UPDATE OR DELETE ON public.inventory_restocks
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();
DROP TRIGGER IF EXISTS tr_audit_inventory_adjustments ON public.inventory_adjustments;
CREATE TRIGGER tr_audit_inventory_adjustments AFTER INSERT OR UPDATE OR DELETE ON public.inventory_adjustments
FOR EACH ROW EXECUTE FUNCTION public.capture_audit_change();

COMMIT;
