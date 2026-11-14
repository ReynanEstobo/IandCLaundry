import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// SMS is not set up for the business, so no screen sends a text by itself
// (the Orders screen used to text customers on every new and ready order).
// Customers without an email still get the on-screen manual pickup reminder.
test('no screen sends SMS automatically', async () => {
  const root = fileURLToPath(new URL('../frontend/src/', import.meta.url))
  const files = (await readdir(root, { recursive: true })).filter(file => /\.(jsx?|tsx?)$/.test(file) && !file.endsWith(path.join('api', 'notificationApi.js')))
  for (const file of files) {
    const source = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(source, /\bsendSms\b|notifications\/sms/, `${file} still sends SMS`)
  }
  const orders = await readFile(path.join(root, 'pages', 'Orders.jsx'), 'utf8')
  assert.match(orders, /setManualPickupReminder\(order\)/, 'customers without email still get the manual pickup reminder')
})
