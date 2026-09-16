import { authClient, database, runtimeValue } from '../config/supabase.js'
import { getStaffProfile } from '../models/databaseModel.js'
import { createHash, randomInt, timingSafeEqual } from 'node:crypto'
import { sendEmail } from '../services/notificationService.js'
import { assertStrongPassword } from '../utils/validation.js'

async function identityFor(user) {
  const { data: staff, error } = await getStaffProfile(user.id, user.email)
  if (error) throw new Error('Unable to verify account status')
  if (!staff) throw accountNotFound()
  return {
    user,
    staffId: staff?.id || null,
    role: String(staff?.role || 'unassigned').toLowerCase(),
    staffName: staff?.full_name || null,
    branch: staff?.branch || null,
    mustChangePassword: Boolean(staff?.must_change_password),
  }
}

const accountNotFound = () => Object.assign(new Error('Account does not exist.'), { status: 404 })
const OTP_COOLDOWN_SECONDS = 300
const otpCooldown = retryAfterSeconds => Object.assign(new Error(`Please wait ${retryAfterSeconds} seconds before requesting another verification code.`), {
  status: 429, code: 'OTP_COOLDOWN', retryAfterSeconds,
})
const contactEmailRequired = recovery => Object.assign(new Error(recovery
  ? 'This account does not have a recovery email. Ask an administrator to add one before resetting the password.'
  : 'No recovery email is bound to your account. Add one before requesting a password code.'), {
  status: 409, code: 'CONTACT_EMAIL_REQUIRED',
})
const FORGOT_PASSWORD_MESSAGE = 'If an active account has a recovery email, a verification code has been sent.'
const invalidForgotPasswordCode = () => Object.assign(new Error('The verification code is invalid or expired. Request a new code and try again.'), { status: 400 })
const literalPattern = value => value.replace(/[\\%_]/g, character => `\\${character}`)
const isInternalAccountEmail = value => /@accounts\.(?:hc|ic)laundry\.local$/i.test(String(value || ''))

async function writePasswordAudit(staffId, branchId = null) {
  if (!staffId) return
  const { error } = await database.from('audit_logs').insert({
    action: 'password_changed', event_type: 'password_changed', event_category: 'security',
    table_name: 'staff', record_id: staffId, actor_staff_id: staffId,
    branch_id: branchId, before_data: {}, after_data: {}, changed_fields: {}, source: 'security_workflow',
  })
  if (error) console.error('Password audit could not be written', error.message)
}

async function findActiveAccount(identifier, includeContactEmail = false) {
  const value = String(identifier || '').trim()
  if (!value) return null
  const columns = value.includes('@')
    ? (includeContactEmail ? ['email', 'contact_email'] : ['email'])
    : [/^(?:HC|IC)-(?:STAFF|ADMIN)-/i.test(value) ? 'staff_code' : 'username']
  for (const column of columns) {
    const { data, error } = await database.from('staff')
      .select('id, auth_id, email, contact_email').is('deleted_at', null)
      .ilike(column, literalPattern(value)).maybeSingle()
    if (error) throw new Error('Unable to look up account')
    if (data) return data
  }
  return null
}

export async function login({ identifier, email, password }) {
  const submittedIdentifier = String(identifier || email || '').trim()
  if (!submittedIdentifier || !password) throw Object.assign(new Error('Account ID or username and password are required'), { status: 400 })
  const account = await findActiveAccount(submittedIdentifier)
  if (!account?.email) throw accountNotFound()
  const { data, error } = await authClient.auth.signInWithPassword({ email: account.email, password })
  if (error) throw Object.assign(new Error(error.message), { status: 401 })
  const identity = await identityFor(data.user)
  return { session: data.session, ...identity }
}

export async function signUp({ email, password, options }) {
  if (!email || !password) throw Object.assign(new Error('Email and password are required'), { status: 400 })
  assertStrongPassword(password, email)
  const { data, error } = await authClient.auth.signUp({ email, password, options })
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
  return { user: data.user, session: data.session }
}

export async function getMe(identity) {
  return identity
}

function hashOtp(challengeId, code) {
  const secret = runtimeValue('PASSWORD_OTP_SECRET') || runtimeValue('SUPABASE_SERVICE_ROLE_KEY')
  return createHash('sha256').update(`${secret}:${challengeId}:${code}`).digest('hex')
}

async function passwordVerificationEmail(identity) {
  const { data: staff, error } = identity.staffId
    ? await database.from('staff').select('contact_email, email').eq('id', identity.staffId).maybeSingle()
    : { data: null, error: null }
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
  const email = staff?.contact_email || (isInternalAccountEmail(staff?.email) ? null : staff?.email) || identity.user.email
  if (!email || isInternalAccountEmail(email)) {
    throw contactEmailRequired(false)
  }
  return email
}

async function issuePasswordOtp({ userId, staffId, email }) {
  const { data: recentChallenge, error: cooldownError } = await database
    .from('password_change_otps').select('requested_at').eq('auth_user_id', userId)
    .order('requested_at', { ascending: false }).limit(1).maybeSingle()
  if (cooldownError) throw Object.assign(new Error(cooldownError.message), { status: 400 })
  const elapsedSeconds = recentChallenge ? Math.floor((Date.now() - new Date(recentChallenge.requested_at).getTime()) / 1000) : OTP_COOLDOWN_SECONDS
  if (elapsedSeconds < OTP_COOLDOWN_SECONDS) throw otpCooldown(OTP_COOLDOWN_SECONDS - elapsedSeconds)
  const code = String(randomInt(100000, 1000000))
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
  const { error: closeError } = await database
    .from('password_change_otps')
    .update({ consumed_at: new Date().toISOString() })
    .eq('auth_user_id', userId)
    .is('consumed_at', null)
  if (closeError) throw Object.assign(new Error(closeError.message), { status: 400 })
  const { data: challenge, error } = await database
    .from('password_change_otps')
    .insert({ auth_user_id: userId, staff_id: staffId, email, code_hash: 'pending', expires_at: expiresAt })
    .select('id')
    .single()
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
  const { error: hashError } = await database.from('password_change_otps').update({ code_hash: hashOtp(challenge.id, code) }).eq('id', challenge.id)
  if (hashError) throw Object.assign(new Error(hashError.message), { status: 400 })
  try {
    await sendEmail({
      to: email,
      subject: 'I&C Laundry password verification code',
      body: `Your I&C Laundry password-change code is: ${code}\n\nIt expires in 10 minutes. Do not share this code with anyone. If you did not request a password change, you can ignore this email.`,
    })
  } catch (sendError) {
    await database.from('password_change_otps').update({ consumed_at: new Date().toISOString() }).eq('id', challenge.id)
    throw sendError
  }
  return { success: true, expiresInSeconds: 600, cooldownSeconds: OTP_COOLDOWN_SECONDS, destination: email.replace(/^(.{2}).+(@.+)$/, '$1***$2') }
}

export async function requestPasswordOtp(_body, identity) {
  if (identity.mustChangePassword) throw Object.assign(new Error('Activate your account first using the temporary password.'), { status: 400 })
  const email = await passwordVerificationEmail(identity)
  return issuePasswordOtp({ userId: identity.user.id, staffId: identity.staffId, email })
}

async function verifyPasswordOtp(identity, code) {
  if (!/^\d{6}$/.test(String(code || ''))) throw Object.assign(new Error('Enter the 6-digit verification code.'), { status: 400 })
  const { data: challenge, error } = await database
    .from('password_change_otps')
    .select('*')
    .eq('auth_user_id', identity.user.id)
    .is('consumed_at', null)
    .order('requested_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
  if (!challenge || new Date(challenge.expires_at) <= new Date() || challenge.attempts >= 5) {
    throw Object.assign(new Error('Your verification code has expired. Request a new code.'), { status: 400 })
  }
  const expected = Buffer.from(challenge.code_hash, 'hex')
  const actual = Buffer.from(hashOtp(challenge.id, String(code)), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await database.from('password_change_otps').update({ attempts: challenge.attempts + 1 }).eq('id', challenge.id)
    throw Object.assign(new Error('Invalid verification code.'), { status: 400 })
  }
  return challenge
}

async function findResetAccount(identifier) {
  const data = await findActiveAccount(identifier, true)
  if (!data?.auth_id) return null
  const email = data.contact_email || (isInternalAccountEmail(data.email) ? null : data.email)
  if (!email) throw contactEmailRequired(true)
  return { user: { id: data.auth_id }, staffId: data.id, email }
}

// Password recovery is public. Do not reveal whether a staff record exists or
// has a recovery email; both details could otherwise be used to enumerate
// employee accounts. Database failures still surface to operators normally.
async function findPublicResetAccount(identifier) {
  try {
    return await findResetAccount(identifier)
  } catch (error) {
    if (error?.code === 'CONTACT_EMAIL_REQUIRED') return null
    throw error
  }
}

export async function requestForgotPasswordOtp({ identifier }) {
  const account = await findPublicResetAccount(identifier)
  if (account) {
    try {
      await issuePasswordOtp({ userId: account.user.id, staffId: account.staffId, email: account.email })
    } catch (error) {
      // A cooldown or delivery failure must look identical to an unknown
      // account. The request-rate limit still protects the endpoint itself.
      console.error('Forgot-password OTP could not be issued', error?.message)
    }
  }
  return { success: true, cooldownSeconds: OTP_COOLDOWN_SECONDS, message: FORGOT_PASSWORD_MESSAGE }
}

export async function verifyForgotPasswordOtp({ identifier, otp }) {
  const account = await findPublicResetAccount(identifier)
  if (!account) throw invalidForgotPasswordCode()
  try {
    await verifyPasswordOtp(account, otp)
  } catch (error) {
    if (error?.status === 400) throw invalidForgotPasswordCode()
    throw error
  }
  return { success: true }
}

export async function resetForgottenPassword({ identifier, otp, newPassword }) {
  const account = await findPublicResetAccount(identifier)
  if (!account) throw invalidForgotPasswordCode()
  let challenge
  try {
    challenge = await verifyPasswordOtp(account, otp)
  } catch (error) {
    if (error?.status === 400) throw invalidForgotPasswordCode()
    throw error
  }
  assertStrongPassword(newPassword, identifier)
  const { error } = await database.auth.admin.updateUserById(account.user.id, { password: newPassword })
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
  await database.from('password_change_otps').update({ consumed_at: new Date().toISOString() }).eq('id', challenge.id)
  await database.from('staff').update({ must_change_password: false }).eq('id', account.staffId)
  await writePasswordAudit(account.staffId)
  return { success: true }
}

export async function updatePassword({ currentPassword, newPassword, otp }, identity) {
  const email = identity?.user?.email
  if (!email || !newPassword) throw Object.assign(new Error('Missing required fields'), { status: 400 })
  assertStrongPassword(newPassword, email)
  let error
  let challenge
  if (identity.mustChangePassword) {
    // This is a one-time activation endpoint. The authenticated bearer token
    // proves account ownership, so a page refresh cannot lose the temporary
    // password and prevent activation.
    ;({ error } = await database.auth.admin.updateUserById(identity.user.id, { password: newPassword }))
  } else {
    // Administrators use the password form in Settings. Their current
    // password re-authenticates the session before the update; staff use the
    // self-service email-OTP screen.
    if (otp) {
      challenge = await verifyPasswordOtp(identity, otp)
    } else if (identity.role === 'admin' && currentPassword) {
      const { error: signInError } = await authClient.auth.signInWithPassword({ email, password: currentPassword })
      if (signInError) throw Object.assign(new Error('Current password is incorrect.'), { status: 400 })
    } else {
      throw Object.assign(new Error('Request and enter a valid verification code.'), { status: 400 })
    }
    ;({ error } = await database.auth.admin.updateUserById(identity.user.id, { password: newPassword }))
  }
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
  if (challenge) await database.from('password_change_otps').update({ consumed_at: new Date().toISOString() }).eq('id', challenge.id)
  if (identity?.staffId) {
    const { error: staffError } = await database.from('staff').update({ must_change_password: false }).eq('id', identity.staffId)
    if (staffError) throw Object.assign(new Error(staffError.message), { status: 400 })
  }
  await writePasswordAudit(identity?.staffId, identity?.branchId || null)
  return { success: true }
}

export async function verifyPasswordChangeOtp({ otp }, identity) {
  if (identity.mustChangePassword) throw Object.assign(new Error('Activate your account first using the temporary password.'), { status: 400 })
  await verifyPasswordOtp(identity, otp)
  return { success: true }
}
