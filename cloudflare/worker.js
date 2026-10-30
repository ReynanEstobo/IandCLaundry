import { authenticate, requireAdmin } from '../backend/middleware/authenticate.js'
import { handleData } from '../backend/controllers/dataController.js'
import { cancelOrder, collectOrderPayment, createInventoryItem, createOrder, restockInventory, settleAndReleaseOrder, transitionAllOrderItems, transitionOrder, transitionOrderItem } from '../backend/controllers/operationController.js'
import { listVisibleCustomers, lookupCustomer } from '../backend/controllers/customerController.js'
import { listAuditLog, restoreRecord } from '../backend/controllers/auditController.js'
import { signUp, getMe, requestForgotPasswordOtp, requestPasswordOtp, resetForgottenPassword, updatePassword, verifyForgotPasswordOtp, verifyPasswordChangeOtp } from '../backend/controllers/authController.js'
import { provisionStaff, resetStaffCredentials, updateProvisionedStaff } from '../backend/controllers/staffProvisionController.js'
import { getPublicServices, getPublicSettings, getPublicTurnstileConfig, sendContactMessage, trackOrder } from '../backend/controllers/publicController.js'
import { generateFromPrompt, generateForecast, generateDecisionSupport } from '../backend/services/aiService.js'
import { resourceRoutes } from '../backend/routes/resourceRoutes.js'
import { configureRuntimeEnv } from '../backend/config/supabase.js'
import { requestEmailChange, confirmEmailChange, verifyEmailChangeOtp } from '../backend/controllers/emailChangeController.js'
import { listLoyaltyRewards, revokeLoyaltyReward } from '../backend/controllers/loyaltyController.js'
import { listEmailDeliveryAudit, retryEmailDelivery, sendAuditedEmail, sendCustomerSms } from '../backend/controllers/notificationController.js'
import { listOrdersPage } from '../backend/controllers/orderListController.js'
import { listCustomersPage, listInventoryPage } from '../backend/controllers/operationalListController.js'
import { renewSession, restoreSession, signIn, signOut } from '../backend/controllers/sessionController.js'

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
}

function secure(response, isApi = false) {
  const headers = new Headers(response.headers)
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value))
  if (isApi) headers.set('Cache-Control', 'no-store, max-age=0')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

const json = (payload, status = 200, headers = {}) => secure(new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
}), true)

// Session endpoints answer with Set-Cookie headers alongside their JSON.
function withCookies(response, cookies = []) {
  cookies.forEach(cookie => response.headers.append('Set-Cookie', cookie))
  return response
}
const sessionJson = ({ payload, cookies }) => withCookies(json(payload), cookies)

async function body(request) {
  const tooLarge = () => Object.assign(new Error('Request body is too large.'), { status: 413 })
  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > 64 * 1024) throw tooLarge()
  let raw
  try {
    raw = await request.text()
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 })
  }
  // A request sent without Content-Length (chunked) is measured after reading.
  if (new TextEncoder().encode(raw).length > 64 * 1024) throw tooLarge()
  try {
    // Several authenticated endpoints, such as requesting a password OTP,
    // deliberately need no client payload. An empty request body is valid and
    // must not be treated as malformed JSON.
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 })
  }
}

const ratePolicies = {
  // Limit password guessing from one source IP. A separate identifier bucket
  // below also slows distributed attempts against a single account.
  'POST:auth/login': { limit: 5, windowMs: 3 * 60 * 1000 },
  'POST:auth/refresh': { limit: 30, windowMs: 15 * 60 * 1000 },
  'POST:auth/forgot-password/otp': { limit: 5, windowMs: 15 * 60 * 1000 },
  'POST:auth/forgot-password/otp/verify': { limit: 10, windowMs: 15 * 60 * 1000 },
  'PATCH:auth/forgot-password': { limit: 8, windowMs: 15 * 60 * 1000 },
  'POST:auth/password/otp': { limit: 5, windowMs: 15 * 60 * 1000 },
  'POST:auth/password/otp/verify': { limit: 10, windowMs: 15 * 60 * 1000 },
  'POST:auth/email/otp': { limit: 5, windowMs: 15 * 60 * 1000 },
  'POST:auth/email/otp/verify': { limit: 10, windowMs: 15 * 60 * 1000 },
  'PATCH:auth/email': { limit: 10, windowMs: 15 * 60 * 1000 },
  'POST:public/contact': { limit: 3, windowMs: 15 * 60 * 1000 },
  'GET:public/orders/track': { limit: 30, windowMs: 60 * 1000 },
  // Paid provider calls: cap the cost a single session or source can incur.
  'POST:notifications/sms': { limit: 30, windowMs: 15 * 60 * 1000 },
  'POST:ai/generate': { limit: 20, windowMs: 15 * 60 * 1000 },
}
// Applies to every API route before it reaches authentication, Supabase, or an
// email provider. It is intentionally keyed by Cloudflare's trusted client IP
// so a forged bearer token cannot evade it. Route-specific policies above add
// stricter limits for sensitive or expensive actions.
const generalApiPolicy = { limit: 180, windowMs: 60 * 1000 }
// Costly or sensitive actions are also limited per signed-in account, so one
// session cannot multiply provider costs by switching networks. Each limit is
// well above the app's own use: Analytics reuses saved AI results until its
// data changes, and staff send one email per order event.
const accountPolicies = {
  'POST:notifications/email': { limit: 60, windowMs: 15 * 60 * 1000 },
  'POST:notifications/email/retry': { limit: 20, windowMs: 15 * 60 * 1000 },
  'POST:notifications/sms': { limit: 30, windowMs: 15 * 60 * 1000 },
  'POST:ai/generate': { limit: 20, windowMs: 15 * 60 * 1000 },
  'POST:ai/forecast': { limit: 120, windowMs: 15 * 60 * 1000 },
  'POST:ai/dss': { limit: 120, windowMs: 15 * 60 * 1000 },
  'POST:auth/signup': { limit: 20, windowMs: 15 * 60 * 1000 },
  'POST:staff/provision': { limit: 20, windowMs: 15 * 60 * 1000 },
  'POST:staff/reset-credentials': { limit: 20, windowMs: 15 * 60 * 1000 },
  'POST:staff/update': { limit: 20, windowMs: 15 * 60 * 1000 },
}

async function consumeRateLimit(env, key, policy) {
  const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key))
  const result = await (await stub.fetch('https://rate-limiter/check', {
    method: 'POST', body: JSON.stringify(policy), headers: { 'Content-Type': 'application/json' },
  })).json()
  if (!result.allowed) {
    throw Object.assign(new Error(`Too many requests. Try again in ${result.retryAfterSeconds} seconds.`), {
      status: 429, retryAfterSeconds: result.retryAfterSeconds,
    })
  }
}

async function enforceRateLimit(request, env, path) {
  if (request.method === 'OPTIONS' || path === 'health') return
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  await consumeRateLimit(env, `api:${ip}`, generalApiPolicy)
  const policy = ratePolicies[`${request.method}:${path}`]
  if (policy) await consumeRateLimit(env, `route:${request.method}:${path}:${ip}`, policy)
  if (request.method === 'POST' && path === 'auth/login') {
    const payload = await body(request.clone())
    const identifier = String(payload.identifier || payload.email || '').trim().toLowerCase()
    if (identifier) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identifier))
      const identifierKey = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
      await consumeRateLimit(env, `login-identifier:${identifierKey}`, { limit: 10, windowMs: 3 * 60 * 1000 })
    }
  }
}

/**
 * Cloudflare Worker adapter for the existing application services. Static
 * assets and API routes share a single workers.dev origin, so browser API
 * calls can remain relative (`/api/...`) and need no CORS configuration.
 */
async function api(request, env) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '')
  const method = request.method

  await enforceRateLimit(request, env, path)
  // Authenticates the request, then applies this route's per-account limit.
  const signedIn = async () => {
    const identity = await authenticate(request)
    const policy = accountPolicies[`${method}:${path}`]
    if (policy) await consumeRateLimit(env, `account:${method}:${path}:${identity.staffId || identity.user.id}`, policy)
    return identity
  }
  if (method === 'OPTIONS') return new Response(null, { status: 204 })
  if (method === 'GET' && path === 'health') return json({ status: 'ok' })
  // Worker instances are short-lived, so the Node EventEmitter based local
  // development stream is intentionally not exposed here. Mutations update
  // their own UI immediately; production polling can be added independently.
  if (method === 'GET' && path === 'events') return new Response(null, { status: 204 })

  if (method === 'POST' && path === 'auth/login') return sessionJson(await signIn(await body(request)))
  if (method === 'POST' && path === 'auth/refresh') return sessionJson(await renewSession(request, await body(request)))
  if (method === 'GET' && path === 'auth/session') return sessionJson(await restoreSession(request))
  if (method === 'POST' && path === 'auth/logout') return sessionJson(await signOut(request))
  if (method === 'POST' && path === 'auth/forgot-password/otp') return json(await requestForgotPasswordOtp(await body(request)))
  if (method === 'POST' && path === 'auth/forgot-password/otp/verify') return json(await verifyForgotPasswordOtp(await body(request)))
  if (method === 'PATCH' && path === 'auth/forgot-password') return json(await resetForgottenPassword(await body(request)))
  if (method === 'POST' && path === 'auth/signup') { requireAdmin(await signedIn()); return json(await signUp(await body(request))) }
  if (method === 'GET' && path === 'auth/me') return json(await getMe(await signedIn()))
  if (method === 'POST' && path === 'auth/email/otp') { const identity = await signedIn(); return json(await requestEmailChange(await body(request), identity)) }
  if (method === 'POST' && path === 'auth/email/otp/verify') { const identity = await signedIn(); return json(await verifyEmailChangeOtp(await body(request), identity)) }
  if (method === 'PATCH' && path === 'auth/email') { const identity = await signedIn(); return json(await confirmEmailChange(await body(request), identity)) }
  if (method === 'POST' && path === 'auth/password/otp') return json(await requestPasswordOtp(await body(request), await signedIn()))
  if (method === 'POST' && path === 'auth/password/otp/verify') return json(await verifyPasswordChangeOtp(await body(request), await signedIn()))
  if (method === 'PATCH' && path === 'auth/password') return json(await updatePassword(await body(request), await signedIn()))
  if (method === 'POST' && path === 'staff/provision') { const identity = await signedIn(); requireAdmin(identity); return json(await provisionStaff(await body(request), identity)) }
  if (method === 'POST' && path === 'staff/reset-credentials') { const identity = await signedIn(); requireAdmin(identity); return json(await resetStaffCredentials(await body(request), identity)) }
  if (method === 'POST' && path === 'staff/update') { const identity = await signedIn(); requireAdmin(identity); return json(await updateProvisionedStaff(await body(request), identity)) }
  if (method === 'POST' && path === 'notifications/email') { const identity = await signedIn(); return json(await sendAuditedEmail(await body(request), identity)) }
  if (method === 'GET' && path === 'notifications/email-audit') { const identity = await signedIn(); return json(await listEmailDeliveryAudit(identity, { page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize') })) }
  if (method === 'POST' && path === 'notifications/email/retry') { const identity = await signedIn(); return json(await retryEmailDelivery(await body(request), identity)) }
  if (method === 'POST' && path === 'notifications/sms') { const identity = await signedIn(); return json(await sendCustomerSms(await body(request), identity)) }
  if (method === 'POST' && path === 'ai/generate') { requireAdmin(await signedIn()); return json(await generateFromPrompt((await body(request)).prompt)) }
  if (method === 'POST' && path === 'ai/forecast') { requireAdmin(await signedIn()); return json(await generateForecast(await body(request))) }
  if (method === 'POST' && path === 'ai/dss') { requireAdmin(await signedIn()); return json(await generateDecisionSupport(await body(request))) }
  if (method === 'GET' && path === 'public/orders/track') return json(await trackOrder(url.searchParams.get('q')))
  if (method === 'GET' && path === 'orders/page') return json(await listOrdersPage(Object.fromEntries(url.searchParams), await signedIn()))
  if (method === 'GET' && path === 'customers/page') return json(await listCustomersPage(Object.fromEntries(url.searchParams), await signedIn()))
  if (method === 'GET' && path === 'inventory/page') return json(await listInventoryPage(Object.fromEntries(url.searchParams), await signedIn()))
  if (method === 'GET' && path === 'public/settings') return json(await getPublicSettings())
  if (method === 'GET' && path === 'public/services') return json(await getPublicServices())
  if (method === 'GET' && path === 'public/turnstile-config') return json(getPublicTurnstileConfig())
  if (method === 'POST' && path === 'public/contact') return json(await sendContactMessage(await body(request)))
  if (method === 'POST' && path === 'orders/create') return json(await createOrder(await body(request), await signedIn()))
  if (method === 'POST' && path === 'orders/transition') return json(await transitionOrder(await body(request), await signedIn()))
  if (method === 'POST' && path === 'orders/items/transition') return json(await transitionOrderItem(await body(request), await signedIn()))
  if (method === 'POST' && path === 'orders/items/transition-all') return json(await transitionAllOrderItems(await body(request), await signedIn()))
  if (method === 'POST' && path === 'orders/collect-payment') return json(await collectOrderPayment(await body(request), await signedIn()))
  if (method === 'POST' && path === 'orders/settle-and-release') return json(await settleAndReleaseOrder(await body(request), await signedIn()))
  if (method === 'POST' && path === 'orders/cancel') return json(await cancelOrder(await body(request), await signedIn()))
  if (method === 'POST' && path === 'inventory/restock') return json(await restockInventory(await body(request), await signedIn()))
  if (method === 'POST' && path === 'inventory/create') return json(await createInventoryItem(await body(request), await signedIn()))
  if (method === 'GET' && path === 'loyalty/rewards') return json(await listLoyaltyRewards(await signedIn()))
  if (method === 'POST' && path === 'loyalty/revoke') return json(await revokeLoyaltyReward(await body(request), await signedIn()))
  if (method === 'GET' && path === 'customers/visible') return json(await listVisibleCustomers(await signedIn()))
  if (method === 'GET' && path === 'customers/lookup') return json(await lookupCustomer(url.searchParams.get('phone'), await signedIn()))
  if (method === 'GET' && (path === 'audit-log' || path === 'recycle-bin')) return json(await listAuditLog(await signedIn(), {
    page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize'),
  }))
  if (method === 'POST' && path === 'recycle-bin/restore') return json(await restoreRecord(await body(request), await signedIn()))

  const table = resourceRoutes.get(path)
  if (table && method === 'POST') return json(await handleData(table, await body(request), await signedIn()))
  return json({ error: 'Endpoint not found' }, 404)
}

// The app page is never stored by the browser, so a duplicated, restored or
// long-open tab always loads the current version. A built file under /assets/
// that does not exist (asked for by an older version) is "not found" rather
// than the app page, so the app can tell it needs to reload.
async function serveAsset(request, env) {
  const response = await env.ASSETS.fetch(request)
  const isPage = (response.headers.get('content-type') || '').includes('text/html')
  if (!isPage) return response
  if (new URL(request.url).pathname.startsWith('/assets/')) {
    return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
  }
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

export default {
  async fetch(request, env) {
    configureRuntimeEnv(env)
    try {
      const isApi = new URL(request.url).pathname.startsWith('/api/')
      const response = isApi ? await api(request, env) : await serveAsset(request, env)
      return secure(response, isApi)
      } catch (error) {
        console.error('Worker request failed:', error?.message || error)
        const status = Number(error?.status) || 500
        // Validation and authorization errors can be shown to the requester,
        // but internal service errors must not disclose database or provider details.
        return withCookies(json({
          error: status >= 500 ? 'Internal server error' : (error?.message || 'Request failed'),
          code: status >= 500 ? undefined : error?.code,
          retryAfterSeconds: status >= 500 ? undefined : error?.retryAfterSeconds,
        }, status, status === 429 && error?.retryAfterSeconds
          ? { 'Retry-After': String(error.retryAfterSeconds) }
          : {}), error?.cookies)
      }
  },
}

// Durable Objects serialize requests for a key, providing a consistent
// account-wide rate limit even when the Worker runs in many edge locations.
export class RateLimiter {
  constructor(state) { this.state = state }

  async fetch(request) {
    const { limit, windowMs } = await request.json()
    const now = Date.now()
    const current = await this.state.storage.get('window')
    let active = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs }
    // If a deployed policy shortens a window, cap an already persisted longer
    // window so users are not kept blocked under the old duration.
    if (active.resetAt - now > windowMs) active = { ...active, resetAt: now + windowMs }
    active.count += 1
    await this.state.storage.put('window', active)
    const retryAfterSeconds = Math.max(1, Math.ceil((active.resetAt - now) / 1000))
    return Response.json({ allowed: active.count <= limit, retryAfterSeconds })
  }
}
