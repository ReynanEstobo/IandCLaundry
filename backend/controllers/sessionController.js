import { database } from '../config/supabase.js'
import { currentLoginSession, login, refreshLoginSession } from './authController.js'
import {
  ACCESS_COOKIE, REFRESH_COOKIE, browserSession, clearedSessionCookies, readCookie,
  rememberedPreference, sessionCookies,
} from '../utils/sessionCookies.js'

// HTTP-agnostic session endpoints shared by the Worker and the local server.
// Each returns the JSON payload plus the Set-Cookie values to send with it.

export async function signIn(body) {
  const remember = body?.remember !== false
  const result = await login(body)
  return { payload: browserSession(result, remember), cookies: sessionCookies(result.session, remember) }
}

// Renews the session from the refresh cookie. A browser still holding a
// pre-cookie session sends its refresh token once in the body to move it
// into cookies.
export async function renewSession(request, body) {
  const refreshToken = readCookie(request, REFRESH_COOKIE) || body?.refreshToken
  const remember = readCookie(request, REFRESH_COOKIE) ? rememberedPreference(request) : body?.remember !== false
  try {
    const result = await refreshLoginSession({ refreshToken })
    return { payload: browserSession(result, remember), cookies: sessionCookies(result.session, remember) }
  } catch (error) {
    throw Object.assign(error, { cookies: clearedSessionCookies() })
  }
}

// Tells a page who is signed in on this browser. Not being signed in is a
// normal answer here (`session: null`), not an error.
export async function restoreSession(request) {
  const accessToken = readCookie(request, ACCESS_COOKIE)
  const refreshToken = readCookie(request, REFRESH_COOKIE)
  if (!accessToken && !refreshToken) return { payload: { session: null }, cookies: [] }
  const remember = rememberedPreference(request)
  try {
    const current = accessToken ? await currentLoginSession(accessToken) : null
    if (current) return { payload: browserSession(current, remember), cookies: [] }
    if (!refreshToken) return { payload: { session: null }, cookies: clearedSessionCookies() }
    const renewed = await refreshLoginSession({ refreshToken })
    return { payload: browserSession(renewed, remember), cookies: sessionCookies(renewed.session, remember) }
  } catch (error) {
    if (Number(error.status) >= 500 || !error.status) throw error
    return { payload: { session: null }, cookies: clearedSessionCookies() }
  }
}

// Signs this browser out everywhere it is open and revokes the refresh
// token, so a copied cookie cannot be reused.
export async function signOut(request) {
  const accessToken = readCookie(request, ACCESS_COOKIE)
  if (accessToken) {
    try { await database.auth.admin.signOut(accessToken, 'local') } catch { /* cookies are cleared regardless */ }
  }
  return { payload: { success: true }, cookies: clearedSessionCookies() }
}
