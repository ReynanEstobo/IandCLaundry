-- "Not ready yet" correction emails.
--
-- When an order marked Ready for Pick-up by mistake is moved back to On
-- Process, and the customer had already been emailed that it was ready, the
-- system emails them a correction. The Delivery Audit records it as its own
-- type, "ready_correction", so it can be listed and retried like the others.
--
-- Run this before deploying the code that sends these emails.
-- Safe to run more than once.
BEGIN;

ALTER TABLE public.email_delivery_audit
  DROP CONSTRAINT IF EXISTS email_delivery_audit_notification_type_check;
ALTER TABLE public.email_delivery_audit
  ADD CONSTRAINT email_delivery_audit_notification_type_check CHECK (
    notification_type IN (
      'manual', 'order_received', 'ready_for_pickup', 'ready_correction',
      'password_otp', 'email_change_otp'
    )
  );

COMMIT;
