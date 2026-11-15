-- Recovery-email changes and staff records, fixed after manual testing.
--
-- 1. An address already used by another active account is refused when the
--    code is requested, before anything is emailed. It used to be refused only
--    at the very last step, after the code had been sent and verified.
-- 2. Deleted accounts no longer keep their addresses. A deleted account cannot
--    sign in or recover a password, so its old address can be used again.
-- 3. Staff phone numbers that do not match the 11-digit rule (09 + 9 digits)
--    are cleared. Records created before that rule could not be saved at all
--    (for example when changing the recovery email or finishing a password
--    change). The audit log keeps the old values; re-enter the correct numbers
--    on the Staff page. The phone and email rules then apply to every record.
--
-- Safe to run more than once.
BEGIN;

CREATE OR REPLACE FUNCTION public.begin_account_email_change(
  p_auth_user_id UUID, p_challenge_id UUID, p_previous_email TEXT, p_new_email TEXT, p_code_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_staff public.staff;
BEGIN
  SELECT * INTO v_staff FROM public.staff
    WHERE auth_id = p_auth_user_id AND deleted_at IS NULL FOR UPDATE;
  IF v_staff.id IS NULL OR v_staff.must_change_password THEN
    RETURN jsonb_build_object('error', 'An active, activated account is required.');
  END IF;
  IF v_staff.contact_email IS DISTINCT FROM p_previous_email THEN
    RETURN jsonb_build_object('error', 'Your account email changed. Refresh and try again.');
  END IF;
  -- One recovery email per active account: "Forgot password" looks accounts up by it.
  IF EXISTS (SELECT 1 FROM public.staff WHERE id <> v_staff.id AND deleted_at IS NULL AND
    (lower(contact_email) = lower(p_new_email) OR lower(email) = lower(p_new_email))) THEN
    RETURN jsonb_build_object('error', 'This email is already used by another account. Choose another address.');
  END IF;
  IF (SELECT count(*) FROM public.email_change_otps WHERE auth_user_id = p_auth_user_id
      AND requested_at > now() - interval '15 minutes') >= 5 THEN
    RETURN jsonb_build_object('error', 'Too many email requests. Try again in 15 minutes.');
  END IF;
  UPDATE public.email_change_otps SET consumed_at = now()
    WHERE auth_user_id = p_auth_user_id AND consumed_at IS NULL;
  INSERT INTO public.email_change_otps(id, auth_user_id, staff_id, previous_email, new_email, code_hash, expires_at)
    VALUES (p_challenge_id, p_auth_user_id, v_staff.id, p_previous_email, p_new_email, p_code_hash, now() + interval '10 minutes');
  RETURN jsonb_build_object('success', true);
END $$;
REVOKE ALL ON FUNCTION public.begin_account_email_change(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_account_email_change(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.confirm_account_email_change(
  p_auth_user_id UUID, p_challenge_id UUID, p_code_hash TEXT
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_staff public.staff;
  v_challenge public.email_change_otps;
BEGIN
  SELECT * INTO v_staff FROM public.staff
    WHERE auth_id = p_auth_user_id AND deleted_at IS NULL FOR UPDATE;
  IF v_staff.id IS NULL OR v_staff.must_change_password THEN
    RETURN jsonb_build_object('error', 'An active, activated account is required.');
  END IF;
  SELECT * INTO v_challenge FROM public.email_change_otps
    WHERE id = p_challenge_id AND auth_user_id = p_auth_user_id AND staff_id = v_staff.id FOR UPDATE;
  IF v_challenge.id IS NULL OR v_challenge.consumed_at IS NOT NULL
     OR v_challenge.expires_at <= now() OR v_challenge.attempts >= 5 THEN
    RETURN jsonb_build_object('error', 'Code expired or unavailable. Request a new code.');
  END IF;
  IF v_challenge.previous_email IS DISTINCT FROM v_staff.contact_email THEN
    RETURN jsonb_build_object('error', 'Your account email changed. Request a new code.');
  END IF;
  IF p_code_hash IS DISTINCT FROM v_challenge.code_hash THEN
    UPDATE public.email_change_otps SET attempts = attempts + 1 WHERE id = v_challenge.id;
    RETURN jsonb_build_object('error', 'Invalid verification code.');
  END IF;
  -- Prevent concurrent self-service claims of the same recovery address.
  PERFORM pg_advisory_xact_lock(hashtextextended(lower(v_challenge.new_email), 0));
  -- Checked again here: another account may have taken it since the code was sent.
  IF EXISTS (SELECT 1 FROM public.staff WHERE id <> v_staff.id AND deleted_at IS NULL AND
    (lower(contact_email) = lower(v_challenge.new_email) OR lower(email) = lower(v_challenge.new_email))) THEN
    RETURN jsonb_build_object('error', 'This email is already used by another account. Choose another address.');
  END IF;
  UPDATE public.staff SET contact_email = v_challenge.new_email WHERE id = v_staff.id;
  UPDATE public.email_change_otps SET consumed_at = now()
    WHERE auth_user_id = p_auth_user_id AND consumed_at IS NULL;
  UPDATE public.password_change_otps SET consumed_at = now()
    WHERE auth_user_id = p_auth_user_id AND consumed_at IS NULL;
  INSERT INTO public.audit_logs(action, table_name, record_id, actor_staff_id, branch_id, before_data, after_data)
    VALUES ('update', 'staff', v_staff.id, v_staff.id, v_staff.branch_id,
      jsonb_build_object('contact_email', v_staff.contact_email),
      jsonb_build_object('contact_email', v_challenge.new_email));
  RETURN jsonb_build_object('success', true, 'contactEmail', v_challenge.new_email);
END $$;
REVOKE ALL ON FUNCTION public.confirm_account_email_change(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_account_email_change(UUID, UUID, TEXT) TO service_role;

-- Records saved before the phone rule existed.
UPDATE public.staff SET phone = NULL
WHERE phone IS NOT NULL AND phone <> '' AND phone !~ '^09[0-9]{9}$';
ALTER TABLE public.staff VALIDATE CONSTRAINT staff_phone_format_check;
ALTER TABLE public.staff VALIDATE CONSTRAINT staff_contact_email_format_check;

COMMIT;
