// The signed-in session lives in HttpOnly cookies: every tab of one browser
// shares the same account (like Facebook), signing in again replaces it for
// all tabs, and page scripts never see the tokens. SameSite=Strict keeps the
// cookies off requests that start on another site.
export const ACCESS_COOKIE = 'ic_access'
export const REFRESH_COOKIE = 'ic_refresh'
export const REMEMBER_COOKIE = 'ic_remember'
const REMEMBER_SECONDS = 30 * 24 * 60 * 60

function header(request, name) {
  return request?.headers?.get ? request.headers.get(name) : request?.headers?.[name]
}

export function readCookie(request, name) {
  for (const part of String(header(request, 'cookie') || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      try { return decodeURIComponent(part.slice(separator + 1).trim()) || null } catch { return null }
    }
  }
  return null
}

function cookie(name, value, { maxAge, path }) {
  return [
    `${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'Secure', 'SameSite=Strict',
    ...(maxAge === undefined ? [] : [`Max-Age=${maxAge}`]),
  ].join('; ')
}

// Without "Remember me" the cookies last until the browser is closed.
export function sessionCookies(session, remember) {
  const maxAge = remember ? REMEMBER_SECONDS : undefined
  return [
    cookie(ACCESS_COOKIE, session.access_token, { maxAge, path: '/api' }),
    cookie(REFRESH_COOKIE, session.refresh_token, { maxAge, path: '/api/auth' }),
    cookie(REMEMBER_COOKIE, remember ? '1' : '0', { maxAge, path: '/api/auth' }),
  ]
}

export function clearedSessionCookies() {
  return [
    cookie(ACCESS_COOKIE, '', { maxAge: 0, path: '/api' }),
    cookie(REFRESH_COOKIE, '', { maxAge: 0, path: '/api/auth' }),
    cookie(REMEMBER_COOKIE, '', { maxAge: 0, path: '/api/auth' }),
  ]
}

export function rememberedPreference(request) {
  return readCookie(request, REMEMBER_COOKIE) !== '0'
}

// A cookie is attached by the browser automatically, so a request that
// authenticates with one must come from this site's own pages.
export function assertSameSiteRequest(request) {
  const site = header(request, 'sec-fetch-site')
  if (site && !['same-origin', 'none'].includes(site)) {
    throw Object.assign(new Error('Cross-site requests are not allowed.'), { status: 403 })
  }
}

function tokenExpiry(token) {
  try {
    const payload = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const exp = Number(JSON.parse(Buffer.from(payload, 'base64').toString('utf8')).exp)
    return exp > 0 ? exp : null
  } catch { return null }
}

// What the browser may know about the session: who is signed in, never the tokens.
export function browserSession({ session, ...identity }, remember) {
  return {
    ...identity,
    session: {
      user: session.user,
      expires_at: session.expires_at || tokenExpiry(session.access_token),
      remember,
      hc_must_change_password: Boolean(identity.mustChangePassword),
      // Lets the activation page address an administrator or a staff member
      // before the profile is readable (it opens only after activation).
      hc_role: identity.role || null,
    },
  }
}
