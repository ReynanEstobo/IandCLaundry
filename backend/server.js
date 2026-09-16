import 'dotenv/config'
import http from 'node:http'
import { URL } from 'node:url'
import { authenticate, requireAdmin } from './middleware/authenticate.js'
import { handleData } from './controllers/dataController.js'
import { cancelOrder, collectOrderPayment, createOrder, restockInventory, settleAndReleaseOrder, transitionOrder } from './controllers/operationController.js'
import { listVisibleCustomers, lookupCustomer, registerCustomer } from './controllers/customerController.js'
import { listAuditLog, restoreRecord } from './controllers/auditController.js'
import { login, refreshLoginSession, signUp, getMe, requestForgotPasswordOtp, requestPasswordOtp, resetForgottenPassword, updatePassword, verifyForgotPasswordOtp, verifyPasswordChangeOtp } from './controllers/authController.js'
import { provisionStaff, resetStaffCredentials, updateProvisionedStaff } from './controllers/staffProvisionController.js'
import { getPublicSettings, sendContactMessage, trackOrder } from './controllers/publicController.js'
import { sendEmail, sendSms } from './services/notificationService.js'
import { askGemini, generateForecast, generateDecisionSupport } from './services/aiService.js'
import { events } from './services/realtimeService.js'
import { resourceRoutes } from './routes/resourceRoutes.js'
import { requestEmailChange, confirmEmailChange, verifyEmailChangeOtp } from './controllers/emailChangeController.js'
import { listLoyaltyRewards, revokeLoyaltyReward } from './controllers/loyaltyController.js'

const port = Number(process.env.PORT || 3001)

function write(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': process.env.FRONTEND_ORIGIN || 'http://localhost:5173', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' })
  response.end(JSON.stringify(payload))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let raw = ''
    request.on('data', chunk => { raw += chunk })
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
    if (request.method === 'GET' && url.pathname === '/api/health') return write(response, 200, { status: 'ok' })
    if (request.method === 'GET' && url.pathname === '/api/events') return streamEvents(request, response)
    if (request.method === 'POST' && path === 'auth/login') return write(response, 200, await login(await readBody(request)))
    if (request.method === 'POST' && path === 'auth/refresh') return write(response, 200, await refreshLoginSession(await readBody(request)))
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
    if (request.method === 'POST' && path === 'notifications/email') { await authenticate(request); return write(response, 200, await sendEmail(await readBody(request))) }
    if (request.method === 'POST' && path === 'notifications/sms') { await authenticate(request); return write(response, 200, await sendSms(await readBody(request))) }
    if (request.method === 'POST' && path === 'ai/generate') { await authenticate(request); return write(response, 200, await askGemini((await readBody(request)).prompt)) }
    if (request.method === 'POST' && path === 'ai/forecast') { requireAdmin(await authenticate(request)); return write(response, 200, await generateForecast(await readBody(request))) }
    if (request.method === 'POST' && path === 'ai/dss') { requireAdmin(await authenticate(request)); return write(response, 200, await generateDecisionSupport(await readBody(request))) }
    if (request.method === 'GET' && path === 'public/orders/track') return write(response, 200, await trackOrder(url.searchParams.get('q')))
    if (request.method === 'GET' && path === 'public/settings') return write(response, 200, await getPublicSettings())
    if (request.method === 'POST' && path === 'public/contact') return write(response, 200, await sendContactMessage(await readBody(request)))
    if (request.method === 'POST' && path === 'orders/create') return write(response, 200, await createOrder(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/transition') return write(response, 200, await transitionOrder(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/collect-payment') return write(response, 200, await collectOrderPayment(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/settle-and-release') return write(response, 200, await settleAndReleaseOrder(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'orders/cancel') return write(response, 200, await cancelOrder(await readBody(request), await authenticate(request)))
    if (request.method === 'POST' && path === 'inventory/restock') return write(response, 200, await restockInventory(await readBody(request), await authenticate(request)))
    if (request.method === 'GET' && path === 'loyalty/rewards') return write(response, 200, await listLoyaltyRewards(await authenticate(request)))
    if (request.method === 'POST' && path === 'loyalty/revoke') return write(response, 200, await revokeLoyaltyReward(await readBody(request), await authenticate(request)))
    if (request.method === 'GET' && path === 'customers/visible') return write(response, 200, await listVisibleCustomers(await authenticate(request)))
    if (request.method === 'GET' && path === 'customers/lookup') return write(response, 200, await lookupCustomer(url.searchParams.get('phone'), await authenticate(request)))
    if (request.method === 'POST' && path === 'customers/register') return write(response, 200, await registerCustomer(await readBody(request), await authenticate(request)))
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
    return write(response, error.status || 500, { error: error.message || 'Internal server error', code: error.code, retryAfterSeconds: error.retryAfterSeconds, details: error.details })
  }
})

server.listen(port, () => console.log(`I&C Laundry backend listening on http://localhost:${port}`))
