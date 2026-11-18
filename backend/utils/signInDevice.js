// Sign-in attempts are limited three ways. Every phone and laptop on one shop or
// venue Wi-Fi shares a single public address, so the address limit is generous
// and the fine-grained work is done per device and per account:
//   - per device: each browser gets a random device ID in an HttpOnly cookie,
//     signed so that only IDs this server issued are counted;
//   - per account: a hash of the username or email typed (stops password
//     guessing on one account, whichever device or network it comes from);
//   - per network address: an outer cap for scripts, which can drop the device
//     cookie to look like a new device on every try.
import { runtimeValue } from '../config/supabase.js'
import { readCookie } from './sessionCookies.js'

export const SIGN_IN_LIMITS = {
  device: { limit: 5, windowMs: 3 * 60 * 1000 },
  account: { limit: 10, windowMs: 3 * 60 * 1000 },
  address: { limit: 30, windowMs: 3 * 60 * 1000 },
}

export const DEVICE_COOKIE = 'ic_device'
const DEVICE_SECONDS = 365 * 24 * 60 * 60
const SIGNED_ID = /^([0-9a-f]{32})\.([0-9a-f]{64})$/
const encoder = new TextEncoder()
const toHex = bytes => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('')
const fromHex = value => new Uint8Array(value.match(/../g).map(pair => parseInt(pair, 16)))

// Signs with a key derived for this purpose only, from DEVICE_COOKIE_SECRET when
// set, otherwise from the server's Supabase service key. Without either (tests,
// a bare local run) a key made at start-up is used, so device IDs last only as
// long as the process.
let startupSecret = null
let cached = { secret: null, key: null }
async function signingKey() {
  const secret = runtimeValue('DEVICE_COOKIE_SECRET') || runtimeValue('SUPABASE_SERVICE_ROLE_KEY')
    || (startupSecret ||= toHex(crypto.getRandomValues(new Uint8Array(32))))
  if (cached.secret !== secret) {
    const base = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const derived = await crypto.subtle.sign('HMAC', base, encoder.encode('ic-laundry/sign-in-device/v1'))
    cached = { secret, key: await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) }
  }
  return cached.key
}

function deviceCookie(value) {
  return `${DEVICE_COOKIE}=${value}; Path=/api/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=${DEVICE_SECONDS}`
}

// This browser's device ID, plus the cookie to send back when it had no valid one.
export async function signInDevice(request) {
  const key = await signingKey()
  const match = SIGNED_ID.exec(readCookie(request, DEVICE_COOKIE) || '')
  if (match && await crypto.subtle.verify('HMAC', key, fromHex(match[2]), encoder.encode(match[1]))) {
    return { id: match[1], cookies: [] }
  }
  const id = toHex(crypto.getRandomValues(new Uint8Array(16)))
  const signature = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(id)))
  return { id, cookies: [deviceCookie(`${id}.${signature}`)] }
}
