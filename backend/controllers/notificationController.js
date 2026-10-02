import { database } from '../config/supabase.js'
import { sendEmail } from '../services/notificationService.js'
import { assertEmail, assertText } from '../utils/validation.js'

const DELIVERY_TYPES = new Set(['manual', 'order_received', 'ready_for_pickup'])
const RETRYABLE_TYPES = new Set(['manual', 'order_received', 'ready_for_pickup'])
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
  return {
    items: data || [],
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
  return deliver({
    to: previous.recipient_email,
    subject: previous.subject,
    body: previous.message_body,
    orderId: previous.order_id,
    notificationType: previous.notification_type,
  }, identity, previous.id)
}
