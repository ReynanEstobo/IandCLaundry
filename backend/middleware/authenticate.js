import { authClient } from '../config/supabase.js'
import { getStaffProfile } from '../models/databaseModel.js'
import { ACCESS_COOKIE, assertSameSiteRequest, readCookie } from '../utils/sessionCookies.js'

export async function authenticate(request) {
  const authorization = request.headers?.get
    ? request.headers.get('authorization')
    : request.headers?.authorization
  // Browsers sign in with the session cookie; an explicit bearer token is
  // still accepted for API clients.
  const bearer = authorization?.replace(/^Bearer\s+/i, '')
  const token = bearer || readCookie(request, ACCESS_COOKIE)
  if (!bearer && token) assertSameSiteRequest(request)
  if (!token) throw Object.assign(new Error('Authentication required'), { status: 401 })
  const { data, error } = await authClient.auth.getUser(token)
  if (error || !data.user) throw Object.assign(new Error('Invalid or expired session'), { status: 401 })
  const { data: staff, error: staffError } = await getStaffProfile(data.user.id, data.user.email)
  if (staffError) throw new Error('Unable to verify account status')
  if (!staff) throw Object.assign(new Error('Account does not exist.'), { status: 401 })
  const requestOrigin = request.headers?.get ? undefined : `http://${request.headers?.host || 'localhost'}`
  if (staff?.must_change_password && new URL(request.url, requestOrigin).pathname !== '/api/auth/password') {
    throw Object.assign(new Error('You must change your temporary password before using the system.'), { status: 403 })
  }
  return {
    user: data.user,
    role: String(staff?.role || 'unassigned').toLowerCase(),
    staffId: staff?.id || null,
    staffName: staff?.full_name || null,
    branch: staff?.branch || null,
    branchId: staff?.branch_id || null,
    mustChangePassword: Boolean(staff?.must_change_password),
  }
}

export function requireAdmin(identity) {
  if (identity.role !== 'admin') throw Object.assign(new Error('Administrator access required'), { status: 403 })
}
