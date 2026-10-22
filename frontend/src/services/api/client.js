// The signed-in session lives in HttpOnly cookies set by the server, so every
// tab of this browser shares one account (like Facebook) and page scripts
// never see the tokens. This module keeps only who is signed in, and keeps
// the tabs in step: signing in or out in one tab applies to all of them.
const LEGACY_SESSION_KEYS = ['ic-laundry-session', 'hc-laundry-session']
const LEGACY_TAB_SESSION_KEY = 'ic-laundry-tab-session'
const AUTH_CHANNEL = 'ic-laundry-auth'
const SESSION_RECHECK_MS = 30_000
const sessionListeners = new Set()
let currentSession = null
let restorePromise = null
let renewPromise = null
let channel = null

function authChannel() {
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(AUTH_CHANNEL)
    channel.unref?.() // Node only (tests): an open channel must not keep the process alive.
  }
  return channel
}

function setSession(session, { broadcast = true } = {}) {
  currentSession = session || null
  sessionListeners.forEach(listener => listener(currentSession))
  if (!broadcast) return
  try {
    authChannel()?.postMessage(currentSession
      ? { type: 'signed-in', userId: currentSession.user?.id || null }
      : { type: 'signed-out' })
  } catch { /* other tabs re-check when they are shown again */ }
}

export function getStoredSession() {
  return currentSession
}

export function isStoredSessionPersistent() {
  return currentSession?.remember !== false
}

export function onSessionChange(listener) {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

// `session` is the server's description of the signed-in account (no tokens).
export function storeSession(session) {
  setSession(session)
}

export function clearSession({ broadcast = true } = {}) {
  setSession(null, { broadcast })
}

// Sessions saved by earlier versions of the app sat in browser storage. Move
// one into cookies once, then remove every stored copy of its tokens.
function takeLegacySession() {
  const read = (storage, key) => { try { return JSON.parse(storage?.getItem(key) || 'null') } catch { return null } }
  const remove = (storage, key) => { try { storage?.removeItem(key) } catch { /* storage unavailable */ } }
  let legacy = null
  let remember = true
  for (const key of LEGACY_SESSION_KEYS) legacy ||= read(globalThis.localStorage, key)
  if (!legacy) {
    legacy = read(globalThis.sessionStorage, LEGACY_TAB_SESSION_KEY)
    remember = false
  }
  LEGACY_SESSION_KEYS.forEach(key => remove(globalThis.localStorage, key))
  remove(globalThis.sessionStorage, LEGACY_TAB_SESSION_KEY)
  return legacy?.refresh_token ? { refreshToken: legacy.refresh_token, remember } : null
}

async function sessionRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  })
  const data = await response.json().catch(() => ({}))
  return { ok: response.ok, data }
}

// Asks the server who is signed in on this browser. If the server cannot be
// reached, the current state is kept rather than signing anyone out.
export function restoreSession() {
  if (restorePromise) return restorePromise
  restorePromise = (async () => {
    try {
      const legacy = takeLegacySession()
      if (legacy) {
        const moved = await sessionRequest('/api/auth/refresh', { method: 'POST', body: JSON.stringify(legacy) })
        if (moved.ok && moved.data.session) {
          setSession(moved.data.session, { broadcast: false })
          return currentSession
        }
      }
      const { ok, data } = await sessionRequest('/api/auth/session')
      if (ok) setSession(data.session || null, { broadcast: false })
      return currentSession
    } catch {
      return currentSession
    } finally {
      restorePromise = null
    }
  })()
  return restorePromise
}

// The access cookie expires hourly; the refresh cookie renews it.
export function renewSession() {
  if (renewPromise) return renewPromise
  renewPromise = (async () => {
    try {
      const { ok, data } = await sessionRequest('/api/auth/refresh', { method: 'POST', body: '{}' })
      if (!ok || !data.session) return null
      setSession(data.session, { broadcast: false })
      return data.session
    } catch {
      return null
    } finally {
      renewPromise = null
    }
  })()
  return renewPromise
}

// Keeps this tab on the same account as the rest of the browser. Signing out
// anywhere signs this tab out; signing in as someone else reloads this tab so
// nothing from the previous account stays on screen. A tab that was hidden
// re-checks the session when it is shown again.
export function startSessionMonitor() {
  const followOtherTab = async ({ data: message }) => {
    if (message?.type === 'signed-out') {
      if (currentSession) clearSession({ broadcast: false })
      return
    }
    if (message?.type !== 'signed-in') return
    const signedInUser = currentSession?.user?.id
    if (signedInUser && message.userId && signedInUser !== message.userId) {
      window.location.reload()
      return
    }
    await restoreSession()
  }
  let lastCheck = Date.now()
  const recheckWhenShown = async () => {
    if (document.hidden || Date.now() - lastCheck < SESSION_RECHECK_MS) return
    lastCheck = Date.now()
    const signedInUser = currentSession?.user?.id
    const session = await restoreSession()
    if (signedInUser && session?.user?.id && session.user.id !== signedInUser) window.location.reload()
  }
  const sessionChannel = authChannel()
  sessionChannel?.addEventListener('message', followOtherTab)
  document.addEventListener('visibilitychange', recheckWhenShown)
  return () => {
    sessionChannel?.removeEventListener('message', followOtherTab)
    document.removeEventListener('visibilitychange', recheckWhenShown)
  }
}

const resourcePaths = {
  customers: '/api/customers', orders: '/api/orders', inventory_items: '/api/inventory/items',
  inventory_categories: '/api/inventory/categories', inventory_usage_log: '/api/inventory/usage',
  inventory_restocks: '/api/inventory/restocks', expenses: '/api/expenses', staff: '/api/staff',
  settings: '/api/settings', service_types: '/api/service-types', sms_log: '/api/sms-log',
  payments: '/api/payments', branches: '/api/branches', order_items: '/api/order-items',
  service_inventory_requirements: '/api/service-inventory-requirements',
  order_item_addons: '/api/order-item-addons', service_addon_items: '/api/service-addon-items',
}

export async function apiFetch(path, options = {}) {
  const publicRequest = /^\/api\/(public\/|auth\/(login|refresh|session|logout|forgot-password|reset-password)(?:\/|$))/.test(path)
  const { _sessionRefreshRetried, ...fetchOptions } = options
  const sessionAtStart = currentSession
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  const response = await fetch(path, { ...fetchOptions, headers, credentials: 'same-origin' })
  const data = await response.json().catch(() => ({}))
  if (response.status === 401 && !publicRequest) {
    // The access cookie can expire between requests: renew once and retry.
    if (!_sessionRefreshRetried && await renewSession()) return apiFetch(path, { ...options, _sessionRefreshRetried: true })
    // An older request must not sign out a session that replaced it meanwhile.
    // Permission errors (403) and network failures are not expiry.
    if (currentSession && currentSession === sessionAtStart) clearSession()
  }
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
