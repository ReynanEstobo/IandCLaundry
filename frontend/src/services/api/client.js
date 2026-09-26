const SESSION_KEY = 'ic-laundry-session'
const LEGACY_SESSION_KEY = 'hc-laundry-session'
const TAB_SESSION_KEY = 'ic-laundry-tab-session'
const sessionListeners = new Set()
let expiryTimer
let refreshPromise = null

function tabStorage() {
  return globalThis.sessionStorage || null
}

function readSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY) || tabStorage()?.getItem(TAB_SESSION_KEY) || 'null') }
  catch { return null }
}

function readRememberedSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY) || 'null') }
  catch { return null }
}

export function isStoredSessionPersistent() {
  return Boolean(localStorage.getItem(SESSION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY))
}

export function sessionExpiry(session) {
  const expiresAt = Number(session?.expires_at)
  if (expiresAt > 0) return expiresAt * 1000
  try {
    const payload = session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const exp = Number(JSON.parse(atob(payload)).exp)
    return exp > 0 ? exp * 1000 : 0
  } catch { return 0 }
}

function scheduleExpiry(session) {
  clearTimeout(expiryTimer)
  if (session) expiryTimer = setTimeout(async () => {
    const current = getStoredSession()
    if (current) scheduleExpiry(current)
    else await refreshRememberedSession()
  }, Math.min(Math.max(0, sessionExpiry(session) - Date.now()), 2147483647))
}

function notifySession(session) {
  scheduleExpiry(session)
  sessionListeners.forEach(listener => listener(session))
}

export function onSessionChange(listener) {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

// Timers may pause on sleeping devices. Recheck when the tab becomes active,
// and synchronize sign-outs/session replacements across browser tabs.
export function startSessionMonitor() {
  const check = async () => {
    const session = getStoredSession()
    if (session) notifySession(session)
    else await refreshRememberedSession()
  }
  const storage = event => {
    if (!event.key || [SESSION_KEY, LEGACY_SESSION_KEY].includes(event.key)) check()
  }
  window.addEventListener('storage', storage)
  window.addEventListener('focus', check)
  window.addEventListener('pageshow', check)
  document.addEventListener('visibilitychange', check)
  void check()
  return () => {
    clearTimeout(expiryTimer)
    window.removeEventListener('storage', storage)
    window.removeEventListener('focus', check)
    window.removeEventListener('pageshow', check)
    document.removeEventListener('visibilitychange', check)
  }
}
const resourcePaths = {
  customers: '/api/customers', orders: '/api/orders', inventory_items: '/api/inventory/items',
  inventory_categories: '/api/inventory/categories', inventory_usage_log: '/api/inventory/usage',
  inventory_restocks: '/api/inventory/restocks', expenses: '/api/expenses', staff: '/api/staff',
  settings: '/api/settings', service_types: '/api/service-types', sms_log: '/api/sms-log',
  payments: '/api/payments', branches: '/api/branches', order_items: '/api/order-items',
  service_inventory_requirements: '/api/service-inventory-requirements',
}

export function getStoredSession() {
  try {
    const session = readSession()
    if (session && (!session.access_token || sessionExpiry(session) <= Date.now())) {
      // A remembered session is allowed one seamless renewal using its
      // refresh token. A tab-only or legacy expired session is removed now.
      if (localStorage.getItem(SESSION_KEY) && session.refresh_token) return null
      clearSession()
      return null
    }
    // Upgrade the old persistent key, but never turn a tab-only session into a
    // remembered session without the user choosing Remember me.
    if (session && localStorage.getItem(LEGACY_SESSION_KEY) && !localStorage.getItem(SESSION_KEY)) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session))
      localStorage.removeItem(LEGACY_SESSION_KEY)
    }
    return session
  } catch { return null }
}

export async function refreshRememberedSession() {
  if (refreshPromise) return refreshPromise
  const remembered = readRememberedSession()
  if (!remembered?.refresh_token) return null
  refreshPromise = (async () => {
    try {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: remembered.refresh_token }),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || !data.session) throw new Error(data.error || 'Session refresh failed.')
      data.session.hc_must_change_password = Boolean(data.mustChangePassword)
      storeSession(data.session, { remember: true })
      return data.session
    } catch {
      // Only clear the same remembered session. Do not erase a newer login
      // completed in another tab while this request was in flight.
      if (readRememberedSession()?.access_token === remembered.access_token) clearSession()
      return null
    } finally {
      refreshPromise = null
    }
  })()
  return refreshPromise
}
export function storeSession(session, { remember = true } = {}) {
  const storage = remember ? localStorage : tabStorage()
  const key = remember ? SESSION_KEY : TAB_SESSION_KEY
  if (!storage) throw new Error('Session storage is unavailable in this browser.')
  storage.setItem(key, JSON.stringify(session))
  if (remember) tabStorage()?.removeItem(TAB_SESSION_KEY)
  else localStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(LEGACY_SESSION_KEY)
  notifySession(getStoredSession())
}
export function clearSession() {
  localStorage.removeItem(SESSION_KEY)
  localStorage.removeItem(LEGACY_SESSION_KEY)
  tabStorage()?.removeItem(TAB_SESSION_KEY)
  notifySession(null)
}

export async function apiFetch(path, options = {}) {
  const publicRequest = /^\/api\/(public\/|auth\/(login|refresh|forgot-password|reset-password)(?:\/|$))/.test(path)
  let session = publicRequest ? null : getStoredSession()
  if (!publicRequest && !session) session = await refreshRememberedSession()
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const response = await fetch(path, { ...options, headers })
  const data = await response.json().catch(() => ({}))
  // A server can reject a token shortly before the browser's local expiry
  // timestamp. Renew remembered sessions once and retry the original request.
  if (response.status === 401 && session?.access_token === readSession()?.access_token && session
    && isStoredSessionPersistent() && !options._sessionRefreshRetried) {
    const refreshed = await refreshRememberedSession()
    if (refreshed) return apiFetch(path, { ...options, _sessionRefreshRetried: true })
  }
  // An older request must not sign out a newly replaced password-change or
  // login session. Permission errors (403) and network failures are not expiry.
  if (response.status === 401 && session?.access_token === readSession()?.access_token && session) clearSession()
  if (!response.ok) throw Object.assign(new Error(data.error || 'Request failed'), { response, data })
  return data
}

export async function runQuery(table, request) {
  if (!getStoredSession() && table === 'orders' && request.operation === 'select') {
    const filter = request.filters?.find(item => item.type === 'ilike' && item.column === 'order_number')
    if (!filter) return { data: null, error: { message: 'Authentication required' } }
    const data = await apiFetch(`/api/public/orders/track?q=${encodeURIComponent(String(filter.value).replaceAll('%', ''))}`)
    return { data: data.data, error: null, count: data.data?.length }
  }
  if (!getStoredSession() && table === 'settings' && request.operation === 'select') {
    const data = await apiFetch('/api/public/settings')
    return { data: data.data, error: null }
  }
  try { return await apiFetch(resourcePaths[table], { method: 'POST', body: JSON.stringify(request) }) }
  catch (error) { return { data: null, error: { message: error.message }, count: null } }
}
