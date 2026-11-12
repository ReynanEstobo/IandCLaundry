import assert from 'node:assert/strict'
import test from 'node:test'
import { configureRuntimeEnv } from '../backend/config/supabase.js'
import { sendContactMessage } from '../backend/controllers/publicController.js'
import { sendEmail } from '../backend/services/notificationService.js'

// Answers Turnstile siteverify and records relay payloads instead of reaching Cloudflare or Gmail.
function mockRelay(t) {
  const payloads = []
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
    configureRuntimeEnv(null)
  })
  configureRuntimeEnv({
    TURNSTILE_SECRET_KEY: 'test-only-turnstile-secret',
    CONTACT_EMAIL: 'shop@example.com',
    GOOGLE_APPS_SCRIPT_EMAIL_URL: 'https://relay.example.test',
    EMAIL_RELAY_SECRET: 'test-only-relay-secret',
  })
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('siteverify')) return Response.json({ success: true, action: 'contact-form' })
    payloads.push(JSON.parse(options.body))
    return Response.json({ success: true })
  }
  return payloads
}

test('contact messages show the visitor by name while replies go to the visitor', async t => {
  const payloads = mockRelay(t)
  await sendContactMessage({
    name: 'Juan Dela Cruz', email: 'juan@example.com', message: 'Do you offer pickup?', turnstileToken: 'token',
  })
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0].to, 'shop@example.com')
  assert.equal(payloads[0].replyTo, 'juan@example.com')
  assert.equal(payloads[0].senderName, 'Juan Dela Cruz via I&C Laundry')
})

test('sender names cannot alter the header or imitate an address', async t => {
  const payloads = mockRelay(t)
  await sendEmail({ to: 'shop@example.com', subject: 'Hello', body: 'Body', senderName: 'Eve "Admin" <boss@bank.test>\r\nBcc: x' })
  await sendEmail({ to: 'customer@example.com', subject: 'Order update', body: 'Body' })
  assert.equal(payloads[0].senderName, 'Eve Admin boss bank.test Bcc: x')
  assert.equal(payloads[1].senderName, 'I&C Laundry')
})
