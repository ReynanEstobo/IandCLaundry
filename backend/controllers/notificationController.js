import { database } from '../config/supabase.js'
import { sendEmail, sendSms } from '../services/notificationService.js'
import { assertEmail, assertPhilippineMobile, assertText } from '../utils/validation.js'

const DELIVERY_TYPES = new Set(['manual', 'order_received', 'ready_for_pickup', 'ready_correction'])
const RETRYABLE_TYPES = new Set(['manual', 'order_received', 'ready_for_pickup', 'ready_correction'])
// A ready-for-pickup email only fits an order that is ready; a "not ready yet"
// correction only fits one that is back in Received or On Process. A failed
// email of either kind is not retried once the order has moved on.
const STAGES_EMAIL_FITS = {
  ready_for_pickup: ['ready'],
  ready_correction: ['received', 'on_process'],
}
const STAGE_NAMES = { received: 'Received', on_process: 'On Process', ready: 'Ready for Pick-up', released: 'Released', cancelled: 'Cancelled' }
// Six concatenated SMS segments: room for the order-received template with a
// long customer name and several services, while bounding provider cost.
const SMS_MAX_LENGTH = 918
const badRequest = message => Object.assign(new Error(message), { status: 400 })

function requireActiveStaff(identity) {
  if (!identity?.staffId || !['admin', 'staff'].includes(identity.role)) {
    throw Object.assign(new Error('An active staff account is required.'), { status: 403 })
  }
}

function canAccessBranch(identity, branchId) {
  return identity.role === 'admin' || (identity.branchId && identity.branchId === branchId)
}

async function orderContext(orderId, identity) {
  if (!orderId) return { order: null, branchId: identity.branchId || null, garments: [] }
  const { data: order, error } = await database.from('orders')
    .select('id, order_number, branch_id, branch, order_items(id, service_name_snapshot, weight_kg, status)')
    .eq('id', orderId).maybeSingle()
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  if (!order) throw Object.assign(new Error('The order linked to this email was not found.'), { status: 404 })
  if (!canAccessBranch(identity, order.branch_id)) {
    throw Object.assign(new Error('You can only send notifications for orders assigned to your branch.'), { status: 403 })
  }
  const garments = (order.order_items || []).map(item => ({
    order_item_id: item.id,
    service: item.service_name_snapshot || 'Laundry service',
    weight_kg: Number(item.weight_kg || 0),
    status: item.status || null,
  }))
  return { order, branchId: order.branch_id, garments }
}

async function appendDeliveryAudit(entry) {
  const { data, error } = await database.from('email_delivery_audit').insert(entry).select('id').single()
  if (error) throw Object.assign(new Error(`Unable to record the email delivery audit: ${error.message}`), { status: 500, details: error })
  return data
}

function normalizedPayload(body) {
  const notificationType = DELIVERY_TYPES.has(body?.notificationType) ? body.notificationType : 'manual'
  const messageBody = String(body?.body || '').trim()
  if (!messageBody || messageBody.length > 10_000) throw badRequest('Email message must contain 1–10,000 characters.')
  return {
    to: assertEmail(body?.to, { label: 'Recipient email', required: true }),
    subject: assertText(body?.subject, { label: 'Email subject', min: 1, max: 200 }),
    body: messageBody,
    orderId: body?.orderId || null,
    notificationType,
  }
}

async function deliver(payload, identity, retryOfId = null) {
  requireActiveStaff(identity)
  const message = normalizedPayload(payload)
  // A free-form email can go to any address from the shop's Gmail. Composing
  // one is an administrator screen; staff send only order notifications.
  if (message.notificationType === 'manual' && identity.role !== 'admin') {
    throw Object.assign(new Error('Only administrators can send custom emails.'), { status: 403 })
  }
  if (message.notificationType !== 'manual' && !message.orderId) {
    throw badRequest('Order notifications must include the related order.')
  }
  const context = await orderContext(message.orderId, identity)
  const baseAudit = {
    order_id: context.order?.id || null,
    branch_id: context.branchId,
    attempted_by_staff_id: identity.staffId,
    retry_of_id: retryOfId,
    notification_type: message.notificationType,
    recipient_email: message.to,
    subject: message.subject,
    message_body: message.body,
    order_number: context.order?.order_number || null,
    garment_details: context.garments,
  }

  let result
  try {
    result = await sendEmail(message)
  } catch (error) {
    try {
      await appendDeliveryAudit({
        ...baseAudit,
        status: 'failed',
        provider: error.provider || null,
        error_message: String(error.message || 'Email delivery failed').slice(0, 1_000),
      })
    } catch (auditError) {
      error.details = { ...(error.details || {}), auditError: auditError.message }
    }
    throw error
  }

  // Delivery has already been accepted at this point. If audit storage is
  // unavailable, report that separately instead of returning a failed send
  // response that could make staff accidentally deliver a duplicate email.
  try {
    const audit = await appendDeliveryAudit({
      ...baseAudit,
      status: 'sent',
      provider: result.provider || null,
      error_message: null,
    })
    return { ...result, deliveryId: audit.id, auditRecorded: true }
  } catch (auditError) {
    console.error('Email was delivered but its audit record could not be stored:', auditError)
    return { ...result, auditRecorded: false, auditWarning: auditError.message }
  }
}

export async function sendAuditedEmail(body, identity) {
  return deliver(body, identity)
}

export function readyCorrectionMessage({ customerName, orderNumber, estimatedReadyAt }) {
  const pickup = estimatedReadyAt
    ? new Date(estimatedReadyAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'to be confirmed'
  return {
    subject: `Correction: your I&C Laundry order ${orderNumber} is not ready yet`,
    body: `Hello ${customerName || 'Customer'},\n\nWe are sorry for the confusion. Our earlier email said your laundry (order ${orderNumber}) was ready for pickup. That message was sent by mistake: your order is still being processed, so please do not come to the shop for it yet.\n\nNew estimated pickup time: ${pickup}\n\nWe will email you again as soon as it is ready. Thank you for your patience.\n\nI&C Laundry`,
  }
}

// An order marked Ready for Pick-up by mistake was moved back. If the
// customer was emailed that it is ready, and has not been sent a correction
// since, email them that it is not ready yet. Returns what happened so the
// screen can tell staff: "sent", "failed" (call the customer), or
// "not_needed" (no ready email reached them).
export async function sendReadyCorrectionEmail(orderId, identity) {
  requireActiveStaff(identity)
  const { data: attempts, error } = await database.from('email_delivery_audit')
    .select('notification_type, recipient_email, attempted_at')
    .eq('order_id', orderId).eq('status', 'sent')
    .in('notification_type', ['ready_for_pickup', 'ready_correction'])
    .order('attempted_at', { ascending: false }).limit(1)
  if (error) throw Object.assign(new Error('Unable to check which emails this customer received.'), { status: 500, details: error })
  const latest = attempts?.[0]
  if (!latest || latest.notification_type !== 'ready_for_pickup') return { status: 'not_needed' }

  const { data: order, error: orderError } = await database.from('orders')
    .select('order_number, estimated_ready_at, customers(name)').eq('id', orderId).maybeSingle()
  if (orderError || !order) throw Object.assign(new Error('Order not found.'), { status: 404, details: orderError })
  const message = readyCorrectionMessage({
    customerName: order.customers?.name, orderNumber: order.order_number, estimatedReadyAt: order.estimated_ready_at,
  })
  try {
    const result = await deliver({ to: latest.recipient_email, ...message, orderId, notificationType: 'ready_correction' }, identity)
    return { status: 'sent', to: latest.recipient_email, auditRecorded: result?.auditRecorded !== false }
  } catch (sendError) {
    return { status: 'failed', to: latest.recipient_email, error: sendError.message || 'The email could not be sent.' }
  }
}

// SMS is a paid provider call. Only staff may send it, and only to a phone
// number that belongs to a registered customer, so a session cannot be used
// to message arbitrary numbers.
export async function sendCustomerSms(body, identity) {
  requireActiveStaff(identity)
  const phone = assertPhilippineMobile(body?.phone, { label: 'Customer phone number' })
  const message = String(body?.message || '').trim()
  if (!message || message.length > SMS_MAX_LENGTH) throw badRequest(`SMS message must contain 1–${SMS_MAX_LENGTH} characters.`)
  const { data, error } = await database.rpc('find_customer_by_phone', { p_phone: phone })
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  if (!data?.length) throw Object.assign(new Error('SMS can only be sent to a registered customer.'), { status: 403 })
  return sendSms({ phone, message })
}

// A failed email counts as handled once the same email to the same person
// was later sent successfully (by a retry or a fresh send). Retrying it again
// would send the customer a second copy.
const sameEmail = (sent, failed) => sent.notification_type === failed.notification_type
  && String(sent.recipient_email || '').toLowerCase() === String(failed.recipient_email || '').toLowerCase()
  && (sent.order_id || null) === (failed.order_id || null)
  && (failed.notification_type !== 'manual' || sent.subject === failed.subject)
  && new Date(sent.attempted_at) > new Date(failed.attempted_at)

async function orderStages(orderIds) {
  const ids = [...new Set(orderIds.filter(Boolean))]
  if (!ids.length) return new Map()
  const { data, error } = await database.from('orders').select('id, status').in('id', ids)
  if (error) throw Object.assign(new Error('Unable to check the orders of these emails.'), { status: 500, details: error })
  return new Map((data || []).map(order => [order.id, order.status]))
}

async function laterSuccessfulSends(failedAttempts) {
  if (!failedAttempts.length) return []
  const recipients = [...new Set(failedAttempts.map(attempt => attempt.recipient_email).filter(Boolean))]
  const earliest = failedAttempts.map(attempt => attempt.attempted_at).sort()[0]
  const { data, error } = await database.from('email_delivery_audit')
    .select('id, order_id, notification_type, recipient_email, subject, attempted_at')
    .eq('status', 'sent').in('recipient_email', recipients).gte('attempted_at', earliest)
  if (error) throw Object.assign(new Error('Unable to check later email attempts.'), { status: 500, details: error })
  return data || []
}

export async function listEmailDeliveryAudit(identity, { page = 1, pageSize = 10 } = {}) {
  requireActiveStaff(identity)
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1)
  const safePageSize = Math.min(50, Math.max(1, Number.parseInt(pageSize, 10) || 10))
  const from = (safePage - 1) * safePageSize
  let query = database.from('email_delivery_audit')
    .select('id, order_id, branch_id, retry_of_id, notification_type, recipient_email, subject, order_number, garment_details, status, provider, error_message, attempted_at, staff:attempted_by_staff_id(full_name), branch:branch_id(name)', { count: 'exact' })
    .order('attempted_at', { ascending: false }).range(from, from + safePageSize - 1)
  if (identity.role !== 'admin') {
    if (!identity.branchId) throw Object.assign(new Error('A branch assignment is required.'), { status: 403 })
    query = query.eq('branch_id', identity.branchId)
  }
  const { data, error, count } = await query
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  const total = count || 0
  const failed = (data || []).filter(item => item.status === 'failed')
  const sent = await laterSuccessfulSends(failed)
  const stages = await orderStages(failed.filter(item => STAGES_EMAIL_FITS[item.notification_type]).map(item => item.order_id))
  const items = (data || []).map(item => item.status === 'failed'
    ? {
      ...item,
      resent_successfully: sent.some(attempt => sameEmail(attempt, item)),
      order_moved_on: Boolean(STAGES_EMAIL_FITS[item.notification_type] && stages.has(item.order_id)
        && !STAGES_EMAIL_FITS[item.notification_type].includes(stages.get(item.order_id))),
    }
    : item)
  return {
    items,
    page: safePage,
    pageSize: safePageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / safePageSize)),
  }
}

export async function retryEmailDelivery(body, identity) {
  requireActiveStaff(identity)
  const deliveryId = body?.deliveryId
  if (!deliveryId) throw badRequest('Choose a failed email delivery to retry.')
  const { data: previous, error } = await database.from('email_delivery_audit').select('*').eq('id', deliveryId).maybeSingle()
  if (error) throw Object.assign(new Error(error.message), { status: 400, details: error })
  if (!previous) throw Object.assign(new Error('Email delivery record not found.'), { status: 404 })
  if (!canAccessBranch(identity, previous.branch_id)) {
    throw Object.assign(new Error('You can only retry email notifications for your branch.'), { status: 403 })
  }
  if (previous.status !== 'failed') throw badRequest('Only failed email deliveries can be retried.')
  if (!RETRYABLE_TYPES.has(previous.notification_type)) {
    throw badRequest('Security-code emails cannot be retried. Request a new verification code instead.')
  }
  const fits = STAGES_EMAIL_FITS[previous.notification_type]
  if (fits && previous.order_id) {
    const stage = (await orderStages([previous.order_id])).get(previous.order_id)
    if (stage && !fits.includes(stage)) {
      throw Object.assign(new Error(`This order is now ${STAGE_NAMES[stage] || stage}, so this email no longer matches it and was not sent.`), { status: 409 })
    }
  }
  if ((await laterSuccessfulSends([previous])).some(attempt => sameEmail(attempt, previous))) {
    throw Object.assign(new Error('This email was already sent successfully after it failed, so it was not sent again.'), { status: 409 })
  }
  return deliver({
    to: previous.recipient_email,
    subject: previous.subject,
    body: previous.message_body,
    orderId: previous.order_id,
    notificationType: previous.notification_type,
  }, identity, previous.id)
}
