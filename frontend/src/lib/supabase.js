import { apiFetch, clearSession, getStoredSession, isStoredSessionPersistent, onSessionChange, runQuery, storeSession } from '../services/api/client'

const authListeners = new Set()
let reauthenticationPassword = null
onSessionChange(session => {
  if (!session) reauthenticationPassword = null
  authListeners.forEach(listener => listener(session ? 'SIGNED_IN' : 'SIGNED_OUT', session))
})

class QueryBuilder {
  constructor(table) { this.table = table; this.request = { operation: 'select', selection: '*', filters: [], orders: [] } }
  select(selection = '*', options = {}) { this.request.selection = selection; this.request.count = options.count; if (options.head) this.request.head = true; if (this.request.operation !== 'select') this.request.returning = true; return this }
  insert(payload) { this.request.operation = 'insert'; this.request.payload = payload; return this }
  update(payload) { this.request.operation = 'update'; this.request.payload = payload; return this }
  delete() { this.request.operation = 'delete'; return this }
  eq(column, value) { this.request.filters.push({ type: 'eq', column, value }); return this }
  gte(column, value) { this.request.filters.push({ type: 'gte', column, value }); return this }
  lte(column, value) { this.request.filters.push({ type: 'lte', column, value }); return this }
  ilike(column, value) { this.request.filters.push({ type: 'ilike', column, value }); return this }
  in(column, value) { this.request.filters.push({ type: 'in', column, value }); return this }
  not(column, operator, value) { this.request.filters.push({ type: 'not', column, value: { operator, value } }); return this }
  order(column, options) { this.request.orders.push({ column, options }); return this }
  range(from, to) { this.request.range = { from, to }; return this }
  limit(limit) { this.request.limit = limit; return this }
  single() { this.request.single = 'single'; return this }
  maybeSingle() { this.request.single = 'maybeSingle'; return this }
  then(resolve, reject) { return runQuery(this.table, this.request).then(resolve, reject) }
}

function createChannel() {
  const subscriptions = []
  let source
  return {
    on(_event, config, callback) { subscriptions.push({ table: config.table, callback }); return this },
    subscribe() {
      source = new EventSource('/api/events')
      source.addEventListener('change', event => {
        const change = JSON.parse(event.data)
        subscriptions.filter(subscription => subscription.table === change.table).forEach(subscription => subscription.callback(change))
      })
      return this
    },
    unsubscribe() { source?.close() },
  }
}

export const supabase = {
  from: table => new QueryBuilder(table),
  channel: () => createChannel(),
  removeChannel: channel => channel?.unsubscribe(),
  auth: {
    async getSession() { return { data: { session: getStoredSession() } } },
    onAuthStateChange(callback) { authListeners.add(callback); return { data: { subscription: { unsubscribe: () => authListeners.delete(callback) } } } },
    async signInWithPassword({ identifier, email, password, remember = true }) {
      try {
        const data = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: identifier || email, password }) })
        reauthenticationPassword = password
        data.session.hc_must_change_password = Boolean(data.mustChangePassword)
        storeSession(data.session, { remember })
        return { data: { user: data.user, session: data.session }, error: null }
      } catch (error) { return { data: { user: null, session: null }, error: { message: error.message } } }
    },
    async signUp({ email, password, options }) {
      try {
        const data = await apiFetch('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password, options }) })
        return { data: { user: data.user, session: data.session }, error: null }
      } catch (error) { return { data: { user: null, session: null }, error: { message: error.message } } }
    },
    async signOut() { clearSession(); return { error: null } },
    async updateUser({ password, currentPassword, otp }) {
      try {
        const session = getStoredSession()
        // An OTP is the selected verification factor for the current
        // password-change flow. Do not send the cached login password when an
        // OTP is present; that would make an administrator take a different
        // server-side verification path than staff.
        await apiFetch('/api/auth/password', { method: 'PATCH', body: JSON.stringify({ currentPassword: currentPassword || (otp ? undefined : reauthenticationPassword), newPassword: password, otp }) })
        // Changing a password invalidates the prior JWT in some Supabase
        // configurations. Sign in again right away so the app stores a new,
        // valid session before leaving the activation/security screen.
        const refreshed = await apiFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ identifier: session?.user?.email, password }) })
        refreshed.session.hc_must_change_password = Boolean(refreshed.mustChangePassword)
        storeSession(refreshed.session, { remember: isStoredSessionPersistent() })
        reauthenticationPassword = password
        return { error: null }
      } catch (error) { return { error: { message: error.message } } }
    },
  },
}
