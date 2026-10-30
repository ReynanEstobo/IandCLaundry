-- Check a password code and count a wrong try in one locked step.
--
-- The service used to read a challenge's attempt count, compare the code, and
-- then write attempts + 1. Guesses sent at the same moment all read the same
-- count, so the five-try limit did not hold. Locking the challenge row
-- serializes them, as the email-change codes already do.
--
-- The rules are unchanged: an expired, consumed, or five-times-failed challenge
-- is refused, and only a wrong code counts as a try.
--
-- Run before deploying the code that calls this function. Safe to run more
-- than once.

BEGIN;

CREATE OR REPLACE FUNCTION public.check_password_change_otp(
  p_challenge_id UUID, p_auth_user_id UUID, p_code_hash TEXT
) RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_challenge public.password_change_otps%ROWTYPE;
BEGIN
  SELECT * INTO v_challenge
  FROM public.password_change_otps
  WHERE id = p_challenge_id AND auth_user_id = p_auth_user_id
  FOR UPDATE;

  IF v_challenge.id IS NULL OR v_challenge.consumed_at IS NOT NULL
     OR v_challenge.expires_at <= now() OR v_challenge.attempts >= 5 THEN
    RETURN 'expired';
  END IF;

  IF v_challenge.code_hash IS DISTINCT FROM p_code_hash THEN
    UPDATE public.password_change_otps SET attempts = attempts + 1 WHERE id = v_challenge.id;
    RETURN 'invalid';
  END IF;

  RETURN 'valid';
END;
$$;

REVOKE ALL ON FUNCTION public.check_password_change_otp(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_password_change_otp(UUID, UUID, TEXT) TO service_role;

COMMIT;
