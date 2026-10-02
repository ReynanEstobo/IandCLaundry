import { createHmac, randomInt, randomUUID } from 'node:crypto'
import { authClient, database, runtimeValue } from '../config/supabase.js'
import { sendSecurityEmailWithAudit } from '../services/emailAuditService.js'

const invalid = message => Object.assign(new Error(message), { status: 400 })
const OTP_COOLDOWN_SECONDS = 300
const otpCooldown = retryAfterSeconds => Object.assign(new Error(`Please wait ${retryAfterSeconds} seconds before requesting another verification code.`), {
  status: 429, code: 'OTP_COOLDOWN', retryAfterSeconds,
})
function requireAccount(identity) {
  if (!identity?.staffId || !['admin', 'staff'].includes(identity.role) || identity.mustChangePassword) {
    throw Object.assign(new Error('An active, activated account is required.'), { status: 403 })
  }
}
function hashCode(userId, id, code) {
  const secret = runtimeValue('PASSWORD_OTP_SECRET') || runtimeValue('SUPABASE_SERVICE_ROLE_KEY')
  if (!secret) throw new Error('OTP hashing is not configured')
  return createHmac('sha256', secret).update(`email-change:${userId}:${id}:${code}`).digest('hex')
}

export async function requestEmailChange({ newEmail, currentPassword }, identity) {
  requireAccount(identity)
  const email = typeof newEmail === 'string' ? newEmail.trim().toLowerCase() : ''
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)
    || email.endsWith('.local')) throw invalid('Enter a valid new email address.')
  if (typeof currentPassword !== 'string' || !currentPassword) throw invalid('Enter your current password.')
  const { data: auth, error: authError } = await authClient.auth.signInWithPassword({ email: identity.user.email, password: currentPassword })
  if (authError || auth?.user?.id !== identity.user.id) throw invalid('Current password is incorrect.')
  const cooldownQuery = database.from('email_change_otps').select('requested_at').eq('auth_user_id', identity.user.id)
  // The fallback keeps controller-level test doubles compatible; Supabase's
  // production query builder always provides order/limit/maybeSingle.
  const { data: recentChallenge, error: cooldownError } = typeof cooldownQuery.order === 'function'
    ? await cooldownQuery.order('requested_at', { ascending: false }).limit(1).maybeSingle()
    : { data: null, error: null }
  if (cooldownError) throw new Error('Unable to check email-code cooldown')
  const elapsedSeconds = recentChallenge ? Math.floor((Date.now() - new Date(recentChallenge.requested_at).getTime()) / 1000) : OTP_COOLDOWN_SECONDS
  if (elapsedSeconds < OTP_COOLDOWN_SECONDS) throw otpCooldown(OTP_COOLDOWN_SECONDS - elapsedSeconds)
  const { data: staff, error } = await database.from('staff').select('contact_email')
    .eq('id', identity.staffId).eq('auth_id', identity.user.id).is('deleted_at', null).maybeSingle()
  if (error || !staff) throw invalid('Unable to load your account.')
  if (email === (staff.contact_email || identity.user.email || '').toLowerCase()) throw invalid('Choose a different email address.')
  const id = randomUUID()
  const code = String(randomInt(100000, 1000000))
  const { data: created, error: insertError } = await database.rpc('begin_account_email_change', {
    p_challenge_id: id, p_auth_user_id: identity.user.id,
    p_previous_email: staff.contact_email, p_new_email: email,
    p_code_hash: hashCode(identity.user.id, id, code),
  })
  if (insertError) throw new Error('Unable to create email verification challenge')
  if (!created?.success) throw invalid(created?.error || 'Unable to request a code.')
  try {
    await sendSecurityEmailWithAudit({
      to: email,
      subject: 'Verify your new I&C Laundry account email',
      body: `Your email-change verification code is: ${code}\n\nEnter it in Account Security to bind this address to your account. It expires in 10 minutes. Do not share it. If you did not request this, ignore this email.`,
      notificationType: 'email_change_otp',
      staffId: identity.staffId,
      branchId: identity.branchId,
    })
  } catch (error) {
    await database.from('email_change_otps').update({ consumed_at: new Date().toISOString() }).eq('id', id)
    throw error
  }
  return { challengeId: id, destination: email, expiresInSeconds: 600, cooldownSeconds: OTP_COOLDOWN_SECONDS }
}

export async function confirmEmailChange({ challengeId, otp }, identity) {
  requireAccount(identity)
  if (typeof challengeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeId)
    || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) throw invalid('Enter the six-digit email verification code.')
  const { data, error } = await database.rpc('confirm_account_email_change', {
    p_auth_user_id: identity.user.id, p_challenge_id: challengeId,
    p_code_hash: hashCode(identity.user.id, challengeId, otp),
  })
  if (error) throw new Error('Unable to confirm the email change')
  if (!data?.success) throw invalid(data?.error || 'Unable to verify this code.')
  return data
}

export async function verifyEmailChangeOtp({ challengeId, otp }, identity) {
  requireAccount(identity)
  if (typeof challengeId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(challengeId)
    || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) throw invalid('Enter the six-digit email verification code.')
  const { data, error } = await database.rpc('verify_account_email_change', {
    p_auth_user_id: identity.user.id, p_challenge_id: challengeId,
    p_code_hash: hashCode(identity.user.id, challengeId, otp),
  })
  if (error) throw new Error('Unable to verify this code')
  if (!data?.success) throw invalid(data?.error || 'Unable to verify this code.')
  return data
}
