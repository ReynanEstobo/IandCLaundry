import nodemailer from 'nodemailer'
import { runtimeValue } from '../config/supabase.js'

const WEBSITE_URL = 'https://hc-laundry.23-14327.workers.dev/'

function requireValue(value, label) {
  if (!value) throw Object.assign(new Error(`${label} is not configured`), { status: 500 })
  return value
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function messageBodyHtml(body) {
  return String(body).trim().split('\n').map((rawLine) => {
    const line = rawLine.trim()
    if (!line) return '<div style="height:8px;line-height:8px">&nbsp;</div>'

    const codeLine = line.match(/^(.*?code is:)\s*(\d{6})(.*)$/i)
    if (codeLine) {
      return `<p style="margin:0 0 10px">${escapeHtml(codeLine[1])}</p>
        <div style="margin:0 0 18px;padding:13px 16px;border:1px solid #cbd5e1;background:#f8fafc;color:#0f172a;font-family:Consolas,'Courier New',monospace;font-size:24px;font-weight:700;letter-spacing:6px;text-align:center">${escapeHtml(codeLine[2])}</div>
        ${codeLine[3] ? `<p style="margin:0 0 14px">${escapeHtml(codeLine[3])}</p>` : ''}`
    }

    if (line.startsWith('- ')) {
      return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 7px"><tr><td style="padding:0 9px 0 2px;color:#1688be;vertical-align:top">&bull;</td><td style="color:#334155">${escapeHtml(line.slice(2))}</td></tr></table>`
    }

    if (line.length <= 60 && line.endsWith(':')) {
      return `<p style="margin:4px 0 10px;color:#0f172a;font-weight:700">${escapeHtml(line)}</p>`
    }

    if (/^--\s*/.test(line)) {
      return `<p style="margin:18px 0 0;color:#475569">${escapeHtml(line.replace(/^--\s*/, ''))}</p>`
    }

    return `<p style="margin:0 0 12px">${escapeHtml(line)}</p>`
  }).join('')
}

// A restrained, table-based letterhead renders reliably in Gmail, Outlook,
// and mobile clients without looking like a generic promotional template.
function brandedEmailHtml(subject, body, { canReply = false } = {}) {
  const message = messageBodyHtml(body)
  const safeSubject = escapeHtml(subject)
  const safeWebsiteUrl = escapeHtml(WEBSITE_URL)
  const footerMessage = canReply
    ? 'Reply to this email to respond directly to the sender.'
    : 'This inbox is not monitored. Please contact your I&C Laundry branch if you need assistance.'
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#f3f6f8;color:#1e293b;font-family:Arial,'Helvetica Neue',Helvetica,sans-serif">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0">${safeSubject}</span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f6f8;padding:28px 12px">
      <tr><td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #dbe3e9;border-top:4px solid #1688be">
          <tr><td style="padding:22px 30px 18px">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="vertical-align:middle"><div style="color:#0f172a;font-size:19px;font-weight:700;line-height:1.2">I&amp;C Laundry</div><div style="margin-top:3px;color:#64748b;font-size:12px;line-height:1.3">Laundry care and order updates</div></td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:0 30px"><div style="height:1px;background:#e2e8f0;font-size:1px;line-height:1px">&nbsp;</div></td></tr>
          <tr><td style="padding:28px 30px 30px">
            <h1 style="margin:0 0 20px;color:#0f172a;font-size:21px;font-weight:700;line-height:1.35">${safeSubject}</h1>
            <div style="color:#334155;font-size:14px;line-height:1.65">${message}</div>
          </td></tr>
          <tr><td style="padding:18px 30px 22px;border-top:1px solid #e2e8f0;background:#f8fafc;color:#64748b;font-size:11px;line-height:1.55">
            ${escapeHtml(footerMessage)}<br>
            <a href="${safeWebsiteUrl}" style="color:#0f749f;text-decoration:underline">I&amp;C Laundry website</a>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`
}

async function sendViaAppsScript({ relayUrl, relaySecret, to, subject, body, html, replyTo }) {
  const response = await fetch(relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ secret: relaySecret, to, subject, body, html, replyTo }),
  })
  let data = null
  try { data = await response.json() } catch { /* The status check below handles non-JSON responses. */ }
  if (!response.ok || !data?.success) {
    throw Object.assign(new Error('Email relay could not deliver the message.'), { status: 502 })
  }
}

export async function sendEmail({ to, subject, body, replyTo }) {
  if (!to || !subject || !body) throw Object.assign(new Error('Missing required fields'), { status: 400 })
  const normalizedReplyTo = replyTo ? String(replyTo).trim() : null
  if (normalizedReplyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedReplyTo)) {
    throw Object.assign(new Error('Reply-to email is invalid'), { status: 400 })
  }
  const footer = normalizedReplyTo
    ? 'Reply to this email to respond directly to the sender.'
    : 'This inbox is not monitored. Please contact your I&C Laundry branch if you need assistance.'
  const text = `${String(body).trim()}\n\nI&C Laundry: ${WEBSITE_URL}\n\n${footer}`
  const html = brandedEmailHtml(subject, body, { canReply: Boolean(normalizedReplyTo) })
  const relayUrl = runtimeValue('GOOGLE_APPS_SCRIPT_EMAIL_URL')
  const relaySecret = runtimeValue('EMAIL_RELAY_SECRET')

  // Cloudflare Workers use the HTTPS Apps Script relay. It avoids blocked
  // SMTP sockets and keeps the relay secret server-side. Local Node use may
  // still fall back to Gmail SMTP when no relay is configured.
  if (relayUrl || relaySecret) {
    await sendViaAppsScript({
      relayUrl: requireValue(relayUrl, 'Google Apps Script relay URL'),
      relaySecret: requireValue(relaySecret, 'Google Apps Script relay secret'),
      to, subject, body: text, html, replyTo: normalizedReplyTo,
    })
    return { success: true, message: 'Email sent successfully', provider: 'google_apps_script' }
  }

  // `runtimeValue` reads process.env while developing locally and Cloudflare
  // Worker secrets after deployment. Never pass either value to the client.
  const from = requireValue(runtimeValue('GMAIL_EMAIL'), 'Gmail email')
  const pass = requireValue(runtimeValue('GMAIL_APP_PASSWORD'), 'Gmail app password')
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: from, pass },
  })
  await transporter.sendMail({ from: `"I&C Laundry" <${from}>`, to, subject, text, html, replyTo: normalizedReplyTo || undefined })
  return { success: true, message: 'Email sent successfully', provider: 'gmail_smtp' }
}

export async function sendSms({ phone, message }) {
  if (!phone || !message) throw Object.assign(new Error('Missing required fields: phone, message'), { status: 400 })
  const apiKey = requireValue(runtimeValue('SEMAPHORE_API_KEY'), 'Semaphore API key')
  const number = phone.startsWith('0') ? `63${phone.slice(1)}` : phone
  const params = new URLSearchParams({ apikey: apiKey, number, message, sendername: runtimeValue('SEMAPHORE_SENDER_NAME') || 'ICLaundry' })
  const response = await fetch('https://api.semaphore.co/api/v4/messages', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params })
  const data = await response.json()
  if (!response.ok) throw Object.assign(new Error(data.message || 'Semaphore API error'), { status: 502, details: data })
  return { success: true, message: 'SMS sent successfully', data }
}
