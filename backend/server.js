import 'dotenv/config'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { URL } from 'node:url'
import { authenticate, requireAdmin } from './middleware/authenticate.js'
import { handleData } from './controllers/dataController.js'
import { cancelOrder, collectOrderPayment, createInventoryItem, createOrder, restockInventory, settleAndReleaseOrder, transitionAllOrderItems, transitionOrder, transitionOrderItem } from './controllers/operationController.js'
import { listVisibleCustomers, lookupCustomer } from './controllers/customerController.js'
import { listAuditLog, restoreRecord } from './controllers/auditController.js'
import { signUp, getMe, requestForgotPasswordOtp, requestPasswordOtp, resetForgottenPassword, updatePassword, verifyForgotPasswordOtp, verifyPasswordChangeOtp } from './controllers/authController.js'
import { provisionStaff, resetStaffCredentials, updateProvisionedStaff } from './controllers/staffProvisionController.js'
import { getPublicServices, getPublicSettings, getPublicTurnstileConfig, sendContactMessage, trackOrder } from './controllers/publicController.js'
import { generateFromPrompt, generateForecast, generateDecisionSupport } from './services/aiService.js'
import { events } from './services/realtimeService.js'
import { resourceRoutes } from './routes/resourceRoutes.js'
import { requestEmailChange, confirmEmailChange, verifyEmailChangeOtp } from './controllers/emailChangeController.js'
import { listLoyaltyRewards, revokeLoyaltyReward } from './controllers/loyaltyController.js'
import { listEmailDeliveryAudit, retryEmailDelivery, sendAuditedEmail, sendCustomerSms } from './controllers/notificationController.js'
import { listOrdersPage } from './controllers/orderListController.js'
import { listCustomersPage, listInventoryPage } from './controllers/operationalListController.js'
import { renewSession, restoreSession, signIn, signOut } from './controllers/sessionController.js'

const port = Number(process.env.PORT || 3001)
const localRateWindows = new Map()
const LOCAL_GENERAL_LIMIT = { limit: 180, windowMs: 60_000 }
const LOCAL_ROUTE_LIMITS = {
  'POST:auth/login': { limit: 5, windowMs: 3 * 60_000 },
  'POST:public/contact': { limit: 3, windowMs: 15 * 60_000 },
  'POST:notifications/sms': { limit: 30, windowMs: 15 * 60_000 },
  'POST:ai/generate': { limit: 20, windowMs: 15 * 60_000 },
}

function consumeLocalLimit(key, policy) {
  const now = Date.now()
  let window = localRateWindows.get(key)
  if (!window || window.resetAt <= now) window = { count: 0, resetAt: now + policy.windowMs }
  window.count += 1
  localRateWindows.set(key, window)
  if (localRateWindows.size > 10_000) {
    for (const [entry, value] of localRateWindows) if (value.resetAt <= now) localRateWindows.delete(entry)
  }
  const retryAfterSeconds = Math.max(1, Math.ceil((window.resetAt - now) / 1000))
  if (window.count > policy.limit) {
    throw Object.assign(new Error(`Too many requests. Try again in ${retryAfterSeconds} seconds.`), {
      status: 429, retryAfterSeconds,
    })
  }
}

function enforceLocalRateLimit(request, method, path) {
  if (method === 'OPTIONS' || path === 'health') return
  const ip = request.socket.remoteAddress || 'unknown'
  consumeLocalLimit(`api:${ip}`, LOCAL_GENERAL_LIMIT)
  const policy = LOCAL_ROUTE_LIMITS[`${method}:${path}`]
  if (policy) consumeLocalLimit(`route:${method}:${path}:${ip}`, policy)
}

function enforceLocalLoginIdentifierLimit(payload) {
  const identifier = String(payload?.identifier || payload?.email || '').trim().toLowerCase()
  if (identifier) {
    const digest = createHash('sha256').update(identifier).digest('hex')
    consumeLocalLimit(`login-identifier:${digest}`, { limit: 10, windowMs: 3 * 60_000 })
  }
}

function write(response, status, payload, cookies = []) {
  response.writeHead(status, { ...(cookies?.length ? { 'Set-Cookie': cookies } : {}), 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': process.env.FRONTEND_ORIGIN || 'http://localhost:5173', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', ...(payload?.retryAfterSeconds ? { 'Retry-After': String(payload.retryAfterSeconds) } : {}) })
  response.end(JSON.stringify(payload))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = ''
    let rawBytes = 0
    let overLimit = false
    if (Number(request.headers['content-length'] || 0) > 64 * 1024) {
      request.resume()
      reject(Object.assign(new Error('Request body is too large.'), { status: 413 }))
      return
    }
    request.on('data', chunk => {
      rawBytes += chunk.length
      if (rawBytes > 64 * 1024) {
        if (overLimit) return
        overLimit = true
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }))
        return
      }
      if (!overLimit) raw += chunk
    })
    request.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })) } })
    request.on('error', reject)
  })
}

function streamEvents(request, response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': process.env.FRONTEND_ORIGIN || 'http://localhost:5173' })
  response.write(': connected\n\n')
  const forward = event => response.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`)
  events.on('change', forward)
  const ping = setInterval(() => response.write(': ping\n\n'), 25000)
  request.on('close', () => { clearInterval(ping); events.off('change', forward) })
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return write(response, 204, {})
  const url = new URL(request.url, `http://${request.headers.host}`)
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/$/, '')
  try {
    if (url.pathname.startsWith('/api/')) enforceLocalRateLimit(request, request.method, path)
    if (request.method === 'POST' && (path === 'auth/login' || path === 'public/contact')) {
      const payload = await readBody(request)
      request.rateLimitedBody = payload
      if (path === 'auth/login') enforceLocalLoginIdentifierLimit(payload)
    }
    if (request.method === 'GET' && url.pathname === '/api/health') return write(response, 200, { status: 'ok' })
    if (request.method === 'GET' && url.pathname === '/api/events') return streamEvents(request, response)
    if (request.method === 'POST' && path === 'auth/login') { const { payload, cookies } = await signIn(request.rateLimitedBody || await readBody(request)); return write(response, 200, payload, cookies) }
    if (request.method === 'POST' && path === 'auth/refresh') { const { payload, cookies } = await renewSession(request, await readBody(request)); return write(response, 200, payload, cookies) }
    if (request.method === 'GET' && path === 'auth/session') { const { payload, cookies } = await restoreSession(request); return write(response, 200, payload, cookies) }
    if (request.method === 'POST' && path === 'auth/logout') { const { payload, cookies } = await signOut(request); return write(response, 200, payload, cookies) }
    if (request.method === 'POST' && path === 'auth/forgot-password/otp') return write(response, 200, await requestForgotPasswordOtp(await readBody(request)))
    if (request.method === 'POST' && path === 'auth/forgot-password/otp/verify') return write(response, 200, await verifyForgotPasswordOtp(await readBody(request)))
    if (request.method === 'PATCH' && path === 'auth/forgot-password') return write(response, 200, await resetForgottenPassword(await readBody(request)))
    if (request.method === 'POST' && path === 'auth/signup') { requireAdmin(await authenticate(request)); return write(response, 200, await signUp(await readBody(request))) }
    if (request.method === 'GET' && path === 'auth/me') return write(response, 200, await getMe(await authenticate(request)))
    if (request.method === 'POST' && path === 'auth/email/otp') { const identity = await authenticate(request); return write(response, 200, await requestEmailChange(await readBody(request), identity)) }
    if (request.method === 'POST' && path === 'auth/email/otp/verify') { const identity = await authenticate(request); return write(response, 200, await verifyEmailChangeOtp(await readBody(request), identity)) }
    if (request.method === 'PATCH' && path === 'auth/email') { const identity = await authenticate(request); return write(response, 200, await confirmEmailChange(await readBody(request), identity)) }
    if (request.method === 'POST' && path === 'auth/password/otp') return write(response, 200, await requestPasswordOtp(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'auth/password/otp/verify') return write(response, 200, await verifyPasswordChangeOtp(await readBody(request), await authenticate(request)))
    if (request.method === 'PATCH' && path === 'auth/password') return write(response, 200, await updatePassword(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'staff/provision') { const identity = await authenticate(request); requireAdmin(identity); return write(response, 200, await provisionStaff(await readBody(request), identity)) }
    if (request.method === 'POST' && path === 'staff/reset-credentials') { const identity = await authenticate(request); requireAdmin(identity); return write(response, 200, await resetStaffCredentials(await readBody(request), identity)) }
    if (request.method === 'POST' && path === 'staff/update') { const identity = await authenticate(request); requireAdmin(identity); return write(response, 200, await updateProvisionedStaff(await readBody(request), identity)) }
    if (request.method === 'POST' && path === 'notifications/email') { const identity = await authenticate(request); return write(response, 200, await sendAuditedEmail(await readBody(request), identity)) }
    if (request.method === 'GET' && path === 'notifications/email-audit') { const identity = await authenticate(request); return write(response, 200, await listEmailDeliveryAudit(identity, { page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize') })) }
    if (request.method === 'POST' && path === 'notifications/email/retry') { const identity = await authenticate(request); return write(response, 200, await retryEmailDelivery(await readBody(request), identity)) }
    if (request.method === 'POST' && path === 'notifications/sms') { const identity = await authenticate(request); return write(response, 200, await sendCustomerSms(await readBody(request), identity)) }
    if (request.method === 'POST' && path === 'ai/generate') { requireAdmin(await authenticate(request)); return write(response, 200, await generateFromPrompt((await readBody(request)).prompt)) }
    if (request.method === 'POST' && path === 'ai/forecast') { requireAdmin(await authenticate(request)); return write(response, 200, await generateForecast(await readBody(request))) }
    if (request.method === 'POST' && path === 'ai/dss') { requireAdmin(await authenticate(request)); return write(response, 200, await generateDecisionSupport(await readBody(request))) }
    if (request.method === 'GET' && path === 'public/orders/track') return write(response, 200, await trackOrder(url.searchParams.get('q')))
    if (request.method === 'GET' && path === 'orders/page') return write(response, 200, await listOrdersPage(Object.fromEntries(url.searchParams), await authenticate(request)))
    if (request.method === 'GET' && path === 'customers/page') return write(response, 200, await listCustomersPage(Object.fromEntries(url.searchParams), await authenticate(request)))
    if (request.method === 'GET' && path === 'inventory/page') return write(response, 200, await listInventoryPage(Object.fromEntries(url.searchParams), await authenticate(request)))
    if (request.method === 'GET' && path === 'public/settings') return write(response, 200, await getPublicSettings())
    if (request.method === 'GET' && path === 'public/services') return write(response, 200, await getPublicServices())
    if (request.method === 'GET' && path === 'public/turnstile-config') return write(response, 200, getPublicTurnstileConfig())
    if (request.method === 'POST' && path === 'public/contact') return write(response, 200, await sendContactMessage(request.rateLimitedBody || await readBody(request)))
    if (request.method === 'POST' && path === 'orders/create') return write(response, 200, await createOrder(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/transition') return write(response, 200, await transitionOrder(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/items/transition') return write(response, 200, await transitionOrderItem(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/items/transition-all') return write(response, 200, await transitionAllOrderItems(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/collect-payment') return write(response, 200, await collectOrderPayment(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/settle-and-release') return write(response, 200, await settleAndReleaseOrder(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/cancel') return write(response, 200, await cancelOrder(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'inventory/restock') return write(response, 200, await restockInventory(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'inventory/create') return write(response, 200, await createInventoryItem(await readBody(request), await authenticate(request)))
    if (request.method === 'GET' && path === 'loyalty/rewards') return write(response, 200, await listLoyaltyRewards(await authenticate(request)))
    if (request.method === 'POST' && path === 'loyalty/revoke') return write(response, 200, await revokeLoyaltyReward(await readBody(request), await authenticate(request)))
    if (request.method === 'GET' && path === 'customers/visible') return write(response, 200, await listVisibleCustomers(await authenticate(request)))
    if (request.method === 'GET' && path === 'customers/lookup') return write(response, 200, await lookupCustomer(url.searchParams.get('phone'), await authenticate(request)))
    if (request.method === 'GET' && (path === 'audit-log' || path === 'recycle-bin')) {
      return write(response, 200, await listAuditLog(await authenticate(request), {
        page: url.searchParams.get('page'), pageSize: url.searchParams.get('pageSize'),
      }))
    }
    if (request.method === 'POST' && path === 'recycle-bin/restore') return write(response, 200, await restoreRecord(await readBody(request), await authenticate(request)))

    const table = resourceRoutes.get(path)
    if (table && request.method === 'POST') {
      const identity = await authenticate(request)
      return write(response, 200, await handleData(table, await readBody(request), identity))
    }
    return write(response, 404, { error: 'Endpoint not found' })
  } catch (error) {
    console.error(error)
    const status = Number(error.status) || 500
    // Match the Worker: validation and authorization messages are shown, but
    // internal failures and raw database error details never reach the browser.
    return write(response, status, status >= 500
      ? { error: 'Internal server error' }
      : { error: error.message || 'Request failed', code: error.code, retryAfterSeconds: error.retryAfterSeconds }, error.cookies)
  }
})

server.listen(port, () => console.log(`I&C Laundry backend listening on http://localhost:${port}`))
