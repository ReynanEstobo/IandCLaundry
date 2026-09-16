import { authenticate, requireAdmin } from '../backend/middleware/authenticate.js'
import { handleData } from '../backend/controllers/dataController.js'
import { cancelOrder, createOrder, restockInventory, settleAndReleaseOrder, transitionOrder } from '../backend/controllers/operationController.js'
import { listVisibleCustomers, lookupCustomer, registerCustomer } from '../backend/controllers/customerController.js'
import { listAuditLog, restoreRecord } from '../backend/controllers/auditController.js'
import { login, refreshLoginSession, signUp, getMe, requestForgotPasswordOtp, requestPasswordOtp, resetForgottenPassword, updatePassword, verifyForgotPasswordOtp, verifyPasswordChangeOtp } from '../backend/controllers/authController.js'
import { provisionStaff, resetStaffCredentials, updateProvisionedStaff } from '../backend/controllers/staffProvisionController.js'
import { getPublicSettings, sendContactMessage, trackOrder } from '../backend/controllers/publicController.js'
import { sendEmail, sendSms } from '../backend/services/notificationService.js'
import { askGemini, generateForecast, generateDecisionSupport } from '../backend/services/aiService.js'
import { resourceRoutes } from '../backend/routes/resourceRoutes.js'
import { configureRuntimeEnv } from '../backend/config/supabase.js'
import { requestEmailChange, confirmEmailChange, verifyEmailChangeOtp } from '../backend/controllers/emailChangeController.js'
import { listLoyaltyRewards, revokeLoyaltyReward } from '../backend/controllers/loyaltyController.js'

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'; upgrade-insecure-requests",
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

const json = (payload, status = 200) => secure(new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
}), true)

async function body(request) {
  const contentLength = Number(request.headers.get('content-length') || 0)
  if (contentLength > 64 * 1024) throw Object.assign(new Error('Request body is too large.'), { status: 413 })
  try {
    const raw = await request.text()
    // Several authenticated endpoints, such as requesting a password OTP,
    // deliberately need no client payload. An empty request body is valid and
    // must not be treated as malformed JSON.
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 })
  }
}

const ratePolicies = {
  'POST:auth/login': { limit: 10, windowMs: 15 * 60 * 1000 },
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
}
// Applies to every API route before it reaches authentication, Supabase, or an
// email provider. It is intentionally keyed by Cloudflare's trusted client IP
// so a forged bearer token cannot evade it. Route-specific policies above add
// stricter limits for sensitive or expensive actions.
const generalApiPolicy = { limit: 180, windowMs: 60 * 1000 }

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
  if (method === 'OPTIONS') return new Response(null, { status: 204 })
  if (method === 'GET' && path === 'health') return json({ status: 'ok' })
  // Worker instances are short-lived, so the Node EventEmitter based local
  // development stream is intentionally not exposed here. Mutations update
  // their own UI immediately; production polling can be added independently.
  if (method === 'GET' && path === 'events') return new Response(null, { status: 204 })

  if (method === 'POST' && path === 'auth/login') return json(await login(await body(request)))
  if (method === 'POST' && path === 'auth/refresh') return json(await refreshLoginSession(await body(request)))
  if (method === 'POST' && path === 'auth/forgot-password/otp') return json(await requestForgotPasswordOtp(await body(request)))
  if (method === 'POST' && path === 'auth/forgot-password/otp/verify') return json(await verifyForgotPasswordOtp(await body(request)))
  if (method === 'PATCH' && path === 'auth/forgot-password') return json(await resetForgottenPassword(await body(request)))
  if (method === 'POST' && path === 'auth/signup') { requireAdmin(await authenticate(request)); return json(await signUp(await body(request))) }
  if (method === 'GET' && path === 'auth/me') return json(await getMe(await authenticate(request)))
  if (method === 'POST' && path === 'auth/email/otp') { const identity = await authenticate(request); return json(await requestEmailChange(await body(request), identity)) }
  if (method === 'POST' && path === 'auth/email/otp/verify') { const identity = await authenticate(request); return json(await verifyEmailChangeOtp(await body(request), identity)) }
  if (method === 'PATCH' && path === 'auth/email') { const identity = await authenticate(request); return json(await confirmEmailChange(await body(request), identity)) }
  if (method === 'POST' && path === 'auth/password/otp') return json(await requestPasswordOtp(await body(request), await authenticate(request)))
  if (method === 'POST' && path === 'auth/password/otp/verify') return json(await verifyPasswordChangeOtp(await body(request), await authenticate(request)))
  if (method === 'PATCH' && path === 'auth/password') return json(await updatePassword(await body(request), await authenticate(request)))
  if (method === 'POST' && path === 'staff/provision') { const identity = await authenticate(request); requireAdmin(identity); return json(await provisionStaff(await body(request), identity)) }
  if (method === 'POST' && path === 'staff/reset-credentials') { const identity = await authenticate(request); requireAdmin(identity); return json(await resetStaffCredentials(await body(request), identity)) }
  if (method === 'POST' && path === 'staff/update') { const identity = await authenticate(request); requireAdmin(identity); return json(await updateProvisionedStaff(await body(request), identity)) }
  if (method === 'POST' && path === 'notifications/email') { await authenticate(request); return json(await sendEmail(await body(request))) }
  if (method === 'POST' && path === 'notifications/sms') { await authenticate(request); return json(await sendSms(await body(request))) }
  if (method === 'POST' && path === 'ai/generate') { await authenticate(request); return json(await askGemini((await body(request)).prompt)) }
  if (method === 'POST' && path === 'ai/forecast') { requireAdmin(await authenticate(request)); return json(await generateForecast(await body(request))) }
  if (method === 'POST' && path === 'ai/dss') { requireAdmin(await authenticate(request)); return json(await generateDecisionSupport(await body(request))) }
  if (method === 'GET' && path === 'public/orders/track') return json(await trackOrder(url.searchParams.get('q')))
  if (method === 'GET' && path === 'public/settings') return json(await getPublicSettings())
  if (method === 'POST' && path === 'public/contact') return json(await sendContactMessage(await body(request)))
  if (method === 'POST' && path === 'orders/create') return json(await createOrder(await body(request), await authenticate(request)))
  if (method === 'POST' && path === 'orders/transition') return json(await transitionOrder(await body(request), await authenticate(request)))
  if (method === 'POST' && path === 'orders/settle-and-release') return json(await settleAndReleaseOrder(await body(request), await authenticate(request)))
  if (method === 'POST' && path === 'orders/cancel') return json(await cancelOrder(await body(request), await authenticate(request)))
  if (method === 'POST' && path === 'inventory/restock') return json(await restockInventory(await body(request), await authenticate(request)))
  if (method === 'GET' && path === 'loyalty/rewards') return json(await listLoyaltyRewards(await authenticate(request)))
  if (method === 'POST' && path === 'loyalty/revoke') return json(await revokeLoyaltyReward(await body(request), await authenticate(request)))
  if (method === 'GET' && path === 'customers/visible') return json(await listVisibleCustomers(await authenticate(request)))
  if (method === 'GET' && path === 'customers/lookup') return json(await lookupCustomer(url.searchParams.get('phone'), await authenticate(request)))
  if (method === 'POST' && path === 'customers/register') return json(await registerCustomer(await body(request), await authenticate(request)))
  if (method === 'GET' && (path === 'audit-log' || path === 'recycle-bin')) return json(await listAuditLog(await authenticate(request), {
    page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize'),
  }))
  if (method === 'POST' && path === 'recycle-bin/restore') return json(await restoreRecord(await body(request), await authenticate(request)))

  const table = resourceRoutes.get(path)
  if (table && method === 'POST') return json(await handleData(table, await body(request), await authenticate(request)))
  return json({ error: 'Endpoint not found' }, 404)
}

export default {
  async fetch(request, env) {
    configureRuntimeEnv(env)
    try {
      const isApi = new URL(request.url).pathname.startsWith('/api/')
      const response = isApi ? await api(request, env) : await env.ASSETS.fetch(request)
      return secure(response, isApi)
      } catch (error) {
        console.error('Worker request failed:', error?.message || error)
        const status = Number(error?.status) || 500
        // Validation and authorization errors can be shown to the requester,
        // but internal service errors must not disclose database or provider details.
        return json({
          error: status >= 500 ? 'Internal server error' : (error?.message || 'Request failed'),
          code: status >= 500 ? undefined : error?.code,
          retryAfterSeconds: status >= 500 ? undefined : error?.retryAfterSeconds,
        }, status)
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
    const active = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs }
    active.count += 1
    await this.state.storage.put('window', active)
    const retryAfterSeconds = Math.max(1, Math.ceil((active.resetAt - now) / 1000))
    return Response.json({ allowed: active.count <= limit, retryAfterSeconds })
  }
}
