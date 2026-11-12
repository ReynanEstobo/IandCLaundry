/**
 * I&C Laundry email relay for Cloudflare Workers.
 *
 * Create this script while signed in as iclaundryshop@gmail.com. The account
 * that owns the deployment is the Gmail sender. Never put the relay secret in
 * this file or in source control; save it in Script Properties instead.
 */

const SECRET_PROPERTY = 'EMAIL_RELAY_SECRET';
const SENDER_NAME = 'I&C Laundry';
const DEFAULT_REPLY_TO = 'iclaundryshop@gmail.com';
const MAX_RECIPIENT_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 200;
const MAX_BODY_LENGTH = 20000;
const MAX_SENDER_NAME_LENGTH = 100;

function doPost(event) {
  try {
    const payload = JSON.parse(event && event.postData && event.postData.contents || '{}');
    const configuredSecret = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY);

    if (!configuredSecret || !payload.secret || payload.secret !== configuredSecret) {
      return response({ success: false, error: 'Unauthorized' });
    }

    const to = String(payload.to || '').trim();
    const subject = String(payload.subject || '').trim();
    const body = String(payload.body || '').trim();
    const html = String(payload.html || '').trim();
    const replyTo = String(payload.replyTo || '').trim();
    // Contact-form emails show the visitor's name, such as "Juan Dela Cruz via
    // I&C Laundry". Gmail still sends from this account, so nothing is spoofed.
    const senderName = cleanSenderName(payload.senderName) || SENDER_NAME;

    if (!isValidEmail(to) || !subject || !body ||
        (replyTo && !isValidEmail(replyTo)) ||
        to.length > MAX_RECIPIENT_LENGTH || subject.length > MAX_SUBJECT_LENGTH ||
        body.length > MAX_BODY_LENGTH || html.length > MAX_BODY_LENGTH * 3) {
      return response({ success: false, error: 'Invalid message' });
    }

    GmailApp.sendEmail(to, subject, body, {
      htmlBody: html || undefined,
      name: senderName,
      // Public contact-form emails provide the visitor's address here. Staff
      // can reply directly while Gmail still sends from the business account.
      replyTo: replyTo || DEFAULT_REPLY_TO,
    });
    return response({ success: true });
  } catch (error) {
    // Do not return provider details, recipient information, or secrets.
    console.error('Email relay failed', error && error.message);
    return response({ success: false, error: 'Delivery failed' });
  }
}

// Removes characters that could alter the From header or imitate an address.
function cleanSenderName(value) {
  return String(value || '').replace(/[\r\n"<>@\\]/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, MAX_SENDER_NAME_LENGTH);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function response(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
