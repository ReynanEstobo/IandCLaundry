import { randomBytes, randomUUID } from 'node:crypto'
import { database } from '../config/supabase.js'
import { events } from '../services/realtimeService.js'
import { assertEmail, assertPhilippineMobile, assertText } from '../utils/validation.js'

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function baseUsername(name) {
  const normalized = cleanName(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.+|\.+$/g, '')
  return normalized || 'staff'
}

function generatePassword() {
  // Random, one-time credentials must already meet the password policy.
  // The fixed characters guarantee every required character class.
  return `Ic!${randomBytes(12).toString('base64url')}9A`
}

async function resolveBranch(branchName) {
  const { data, error } = await database.from('branches').select('id, name').eq('name', String(branchName || '').trim()).maybeSingle()
  if (error || !data) throw Object.assign(new Error('Select a valid assigned branch.'), { status: 400 })
  return data
}

async function uniqueUsername(name) {
  const base = baseUsername(name)
  for (let number = 1; number <= 1000; number += 1) {
    const candidate = number === 1 ? base : `${base}.${number}`
    const { data, error } = await database.from('staff').select('id').ilike('username', candidate).maybeSingle()
    if (error) throw Object.assign(new Error(error.message), { status: 400 })
    if (!data) return candidate
  }
  throw Object.assign(new Error('Could not generate a unique username. Try a more specific staff name.'), { status: 409 })
}

function newAccountCode(role = 'staff') {
  const prefix = role === 'admin' ? 'IC-ADMIN' : 'IC-STAFF'
  return `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`
}

function internalAuthEmail(username) {
  return `${username}.${randomUUID().slice(0, 8)}@accounts.iclaundry.local`
}

async function writeAudit(action, staff, actorStaffId, before = {}, after = {}) {
  const { error } = await database.from('audit_logs').insert({
    action,
    table_name: 'staff',
    record_id: staff.id,
    actor_staff_id: actorStaffId || null,
    branch_id: staff.branch_id || null,
    before_data: before,
    after_data: after,
  })
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
}

export async function provisionStaff(body, identity) {
  const fullName = assertText(cleanName(body?.full_name), { label: 'Full name', min: 2, max: 120 })
  const role = ['admin', 'staff'].includes(String(body?.role || '').toLowerCase())
    ? String(body.role).toLowerCase()
    : 'staff'
  const contactEmail = assertEmail(body?.contact_email, { label: 'Contact email' }) || null
  // An administrator needs a recovery channel for password verification.
  if (role === 'admin' && !contactEmail) {
    throw Object.assign(new Error('A contact email is required for an administrator account.'), { status: 400 })
  }
  // Only staff are attached to a branch. Administrators are global accounts
  // and must never acquire a branch scope that could be mistaken for a limit.
  const branch = role === 'staff' ? await resolveBranch(body?.branch) : null
  const username = await uniqueUsername(fullName)
  const staffCode = newAccountCode(role)
  const temporaryPassword = generatePassword()
  const authEmail = internalAuthEmail(username)

  const { data: auth, error: authError } = await database.auth.admin.createUser({
    email: authEmail,
    password: temporaryPassword,
    email_confirm: true,
    user_metadata: { full_name: fullName, staff_code: staffCode, username, role },
  })
  if (authError || !auth.user) throw Object.assign(new Error(authError?.message || 'Could not create the staff sign-in account.'), { status: 400 })

  const payload = {
    auth_id: auth.user.id,
    staff_code: staffCode,
    username,
    full_name: fullName,
    phone: assertPhilippineMobile(body?.phone, { required: false, label: 'Phone number' }) || null,
    contact_email: contactEmail,
    email: authEmail,
    role,
    branch: branch?.name || null,
    branch_id: branch?.id || null,
    position: String(body?.position || '').trim() || null,
    must_change_password: true,
    credentials_issued_at: new Date().toISOString(),
    credentials_issued_by_staff_id: identity.staffId,
  }
  const { data: staff, error: staffError } = await database.from('staff').insert(payload).select('*').single()
  if (staffError) {
    await database.auth.admin.deleteUser(auth.user.id)
    throw Object.assign(new Error(staffError.message), { status: 400 })
  }

  await writeAudit('provision', staff, identity.staffId, {}, { staff_code: staffCode, username, branch: branch?.name || null, role })
  events.emit('change', { table: 'staff' })
  return { staff, credentials: { staffCode, username, temporaryPassword, branch: branch?.name || null, role } }
}

export async function resetStaffCredentials(body, identity) {
  const staffId = body?.staffId
  if (!staffId) throw Object.assign(new Error('Staff member is required.'), { status: 400 })
  const { data: staff, error } = await database.from('staff').select('*').eq('id', staffId).is('deleted_at', null).maybeSingle()
  if (error || !staff?.auth_id) throw Object.assign(new Error('This staff member has no active sign-in account.'), { status: 404 })

  let account = staff
  if (!staff.staff_code || !staff.username) {
    const username = staff.username || await uniqueUsername(staff.full_name)
    const staffCode = staff.staff_code || newAccountCode(staff.role)
    const { data: upgraded, error: upgradeError } = await database.from('staff').update({ staff_code: staffCode, username }).eq('id', staff.id).select('*').single()
    if (upgradeError) throw Object.assign(new Error(upgradeError.message), { status: 400 })
    account = upgraded
  }

  const temporaryPassword = generatePassword()
  const { error: authError } = await database.auth.admin.updateUserById(account.auth_id, {
    password: temporaryPassword,
    user_metadata: { staff_code: account.staff_code, username: account.username, full_name: account.full_name, role: account.role },
  })
  if (authError) throw Object.assign(new Error(authError.message), { status: 400 })
  const { data: updated, error: updateError } = await database.from('staff').update({
    must_change_password: true,
    credentials_issued_at: new Date().toISOString(),
    credentials_issued_by_staff_id: identity.staffId,
  }).eq('id', account.id).select('*').single()
  if (updateError) throw Object.assign(new Error(updateError.message), { status: 400 })

  await writeAudit('credentials_reset', updated, identity.staffId, { must_change_password: staff.must_change_password }, { must_change_password: true })
  events.emit('change', { table: 'staff' })
  return { credentials: { staffCode: updated.staff_code, username: updated.username, temporaryPassword, branch: updated.branch, role: updated.role } }
}

export async function updateProvisionedStaff(body, identity) {
  const staffId = body?.staffId
  if (!staffId) throw Object.assign(new Error('Staff member is required.'), { status: 400 })
  const fullName = assertText(cleanName(body?.full_name), { label: 'Full name', min: 2, max: 120 })
  const { data: existing, error: existingError } = await database.from('staff').select('*').eq('id', staffId).is('deleted_at', null).maybeSingle()
  if (existingError || !existing) throw Object.assign(new Error('Active staff member not found.'), { status: 404 })
  const role = ['admin', 'staff'].includes(String(body?.role || '').toLowerCase())
    ? String(body.role).toLowerCase()
    : existing.role
  const contactEmail = assertEmail(body?.contact_email, { label: 'Contact email' }) || null
  if (role === 'admin' && !contactEmail) {
    throw Object.assign(new Error('A contact email is required for an administrator account.'), { status: 400 })
  }
  const branch = role === 'staff' ? await resolveBranch(body?.branch) : null
  const updates = {
    full_name: fullName,
    phone: assertPhilippineMobile(body?.phone, { required: false, label: 'Phone number' }) || null,
    contact_email: contactEmail,
    position: String(body?.position || '').trim() || null,
    role,
    branch: branch?.name || null,
    branch_id: branch?.id || null,
  }
  const { data: updated, error: updateError } = await database.from('staff').update(updates).eq('id', staffId).select('*').single()
  if (updateError) throw Object.assign(new Error(updateError.message), { status: 400 })
  await writeAudit('update', updated, identity.staffId, { role: existing.role, branch: existing.branch }, { role, branch: branch?.name || null })
  events.emit('change', { table: 'staff' })
  return { staff: updated }
}
