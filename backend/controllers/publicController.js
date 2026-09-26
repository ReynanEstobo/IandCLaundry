import { database } from '../config/supabase.js'
import { runtimeValue } from '../config/supabase.js'
import { sendEmail } from '../services/notificationService.js'
import { assertEmail, assertPhilippineMobile, assertText } from '../utils/validation.js'

export async function trackOrder(orderNumber) {
  if (typeof orderNumber !== 'string' || !orderNumber.trim()) throw Object.assign(new Error('Tracking number is required'), { status: 400 })
  const number = orderNumber.trim().toUpperCase()
  if (!/^(?:IC|HC|4J)-\d{8}-\d{4}$/.test(number)) {
    throw Object.assign(new Error('Enter the complete tracking number from your receipt.'), { status: 400 })
  }
  const { data, error } = await database.from('orders')
    .select('order_number, status, weight_kg, created_at, estimated_ready_at, original_estimated_ready_at, eta_revised_at, eta_source, service_types(name), order_items(service_name_snapshot, weight_kg, status)')
    .eq('order_number', number)
    .neq('status', 'cancelled')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
  return { data: data || [] }
}

export async function getPublicSettings() {
  const { data, error } = await database.from('settings').select('*').single()
  if (error) throw Object.assign(new Error(error.message), { status: 400 })
  return { data }
}

export async function sendContactMessage(body) {
  const name = String(body?.name || '').trim()
  const email = String(body?.email || '').trim()
  const phone = String(body?.phone || '').trim()
  const address = String(body?.address || '').trim()
  const message = String(body?.message || '').trim()
  const inbox = runtimeValue('CONTACT_EMAIL') || runtimeValue('GMAIL_EMAIL')

  if (!name || !email || !message) {
    throw Object.assign(new Error('Name, email, and message are required.'), { status: 400 })
  }
  const validName = assertText(name, { label: 'Name', min: 2, max: 120 })
  const validEmail = assertEmail(email, { required: true })
  const validPhone = phone ? assertPhilippineMobile(phone) : ''
  if (name.length > 120 || email.length > 254 || phone.length > 40 || address.length > 240 || message.length > 4_000) {
    throw Object.assign(new Error('Your message contains a field that is too long.'), { status: 400 })
  }
  if (!inbox) {
    throw Object.assign(new Error('The contact inbox is not configured.'), { status: 503 })
  }

  await sendEmail({
    to: inbox,
    replyTo: validEmail,
    subject: 'New website contact message — I&C Laundry',
    body: `Name: ${validName}\nEmail: ${validEmail}\nPhone: ${validPhone || 'Not provided'}\nAddress: ${address || 'Not provided'}\n\nMessage:\n${message}`,
  })
  return { success: true }
}
