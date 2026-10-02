import { database } from '../config/supabase.js'
import { sendEmail } from './notificationService.js'

const REDACTED_SECURITY_MESSAGE = '[Security code content is intentionally not stored.]'
const SECURITY_TYPES = new Set(['password_otp', 'email_change_otp'])

async function appendSecurityAudit(entry) {
  const { error } = await database.from('email_delivery_audit').insert(entry)
  if (error) throw new Error(`Unable to record the email delivery audit: ${error.message}`)
}

export async function sendSecurityEmailWithAudit({
  to,
  subject,
  body,
  notificationType,
  staffId = null,
  branchId = null,
}) {
  if (!SECURITY_TYPES.has(notificationType)) throw new Error('Unsupported security email type')
  const baseAudit = {
    order_id: null,
    branch_id: branchId,
    attempted_by_staff_id: staffId,
    retry_of_id: null,
    notification_type: notificationType,
    recipient_email: to,
    subject,
    message_body: REDACTED_SECURITY_MESSAGE,
    order_number: null,
    garment_details: [],
  }

  let result
  try {
    result = await sendEmail({ to, subject, body })
  } catch (error) {
    try {
      await appendSecurityAudit({
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

  try {
    await appendSecurityAudit({
      ...baseAudit,
      status: 'sent',
      provider: result.provider || null,
      error_message: null,
    })
  } catch (auditError) {
    console.error('Security email was delivered but its audit record could not be stored:', auditError)
  }
  return result
}
