import { apiFetch } from './client'

export const sendEmail = payload => apiFetch('/api/notifications/email', { method: 'POST', body: JSON.stringify(payload) })
export const sendSms = payload => apiFetch('/api/notifications/sms', { method: 'POST', body: JSON.stringify(payload) })
export const getEmailDeliveryAudit = (limit = 100) => apiFetch(`/api/notifications/email-audit?limit=${limit}`)
export const retryEmail = deliveryId => apiFetch('/api/notifications/email/retry', { method: 'POST', body: JSON.stringify({ deliveryId }) })
