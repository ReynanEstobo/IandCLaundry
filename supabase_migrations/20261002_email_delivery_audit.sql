-- Record every customer-email delivery attempt without changing order logic.
-- Failed attempts remain immutable evidence; retrying creates a new linked row.

BEGIN;

CREATE TABLE IF NOT EXISTS public.email_delivery_audit (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
  branch_id UUID REFERENCES public.branches(id) ON DELETE SET NULL,
  attempted_by_staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  retry_of_id UUID REFERENCES public.email_delivery_audit(id) ON DELETE RESTRICT,
  notification_type TEXT NOT NULL DEFAULT 'manual',
  recipient_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message_body TEXT NOT NULL,
  order_number TEXT,
  garment_details JSONB NOT NULL DEFAULT '[]'::JSONB,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  provider TEXT,
  error_message TEXT,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_delivery_recipient_present CHECK (trim(recipient_email) <> ''),
  CONSTRAINT email_delivery_subject_present CHECK (trim(subject) <> ''),
  CONSTRAINT email_delivery_body_present CHECK (trim(message_body) <> ''),
  CONSTRAINT email_delivery_garments_array CHECK (jsonb_typeof(garment_details) = 'array')
);

-- Keep this constraint upgrade-safe when the migration was applied before
-- security-code delivery auditing was introduced.
ALTER TABLE public.email_delivery_audit
  DROP CONSTRAINT IF EXISTS email_delivery_audit_notification_type_check;
ALTER TABLE public.email_delivery_audit
  ADD CONSTRAINT email_delivery_audit_notification_type_check CHECK (
    notification_type IN (
      'manual', 'order_received', 'ready_for_pickup',
      'password_otp', 'email_change_otp'
    )
  );

CREATE INDEX IF NOT EXISTS idx_email_delivery_audit_attempted
  ON public.email_delivery_audit(attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_audit_branch_attempted
  ON public.email_delivery_audit(branch_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_audit_order_attempted
  ON public.email_delivery_audit(order_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_delivery_audit_failed
  ON public.email_delivery_audit(attempted_at DESC) WHERE status = 'failed';

CREATE OR REPLACE FUNCTION public.prevent_email_delivery_audit_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Email delivery audit entries are append-only and cannot be changed or removed.';
END $$;

DROP TRIGGER IF EXISTS tr_email_delivery_audit_append_only ON public.email_delivery_audit;
CREATE TRIGGER tr_email_delivery_audit_append_only
BEFORE UPDATE OR DELETE ON public.email_delivery_audit
FOR EACH ROW EXECUTE FUNCTION public.prevent_email_delivery_audit_mutation();

ALTER TABLE public.email_delivery_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.email_delivery_audit FROM anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.email_delivery_audit TO service_role;

COMMIT;
