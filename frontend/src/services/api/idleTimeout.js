// Signs an account out after it has been left untouched for an hour, so a
// browser left open at the counter does not stay usable. The time of the last
// click, key press, scroll or touch is shared through localStorage, so using
// any tab keeps every tab of this browser signed in, and a browser that was
// closed or asleep for longer than the limit opens signed out.
export const IDLE_LIMIT_MS = 60 * 60 * 1000
// How the limit reads in messages ("no activity for almost an hour").
export const IDLE_LIMIT_LABEL = 'an hour'
export const IDLE_WARNING_MS = 60 * 1000
const ACTIVITY_KEY = 'ic-laundry-last-activity'
const NOTICE_KEY = 'ic-laundry-idle-signout'
// Writing on every mouse move would be wasteful; a few seconds of precision is plenty.
const ACTIVITY_WRITE_INTERVAL_MS = 5_000
// The sign-in page explains an idle sign-out only if it happened recently.
const NOTICE_MAX_AGE_MS = 12 * 60 * 60 * 1000

let lastWrite = 0

function storage() {
  try { return globalThis.localStorage || null } catch { return null }
}

function readNumber(key) {
  try { return Number(storage()?.getItem(key)) || 0 } catch { return 0 }
}

function write(key, value) {
  try {
    if (value === null) storage()?.removeItem(key)
    else storage()?.setItem(key, String(value))
  } catch { /* storage unavailable: this tab still times out on its own */ }
}

let memoryActivity = 0

/** Notes that the person used the app now (any tab). */
export function recordActivity(now = Date.now(), { force = false } = {}) {
  memoryActivity = Math.max(memoryActivity, now)
  if (!force && now - lastWrite < ACTIVITY_WRITE_INTERVAL_MS) return
  lastWrite = now
  write(ACTIVITY_KEY, now)
}

/** The latest activity seen by this tab or any other, or 0 if none is known. */
export function lastActivity() {
  return Math.max(memoryActivity, readNumber(ACTIVITY_KEY))
}

/**
 * Where an open session stands: `active`, `warning` (the last minute, with
 * `secondsLeft`), or `expired`. A session with no recorded activity yet counts
 * as active from now.
 */
export function idleStatus(now = Date.now()) {
  const last = lastActivity()
  if (!last) {
    recordActivity(now, { force: true })
    return { state: 'active', secondsLeft: Math.ceil(IDLE_LIMIT_MS / 1000) }
  }
  const remaining = IDLE_LIMIT_MS - (now - last)
  if (remaining <= 0) return { state: 'expired', secondsLeft: 0 }
  return { state: remaining <= IDLE_WARNING_MS ? 'warning' : 'active', secondsLeft: Math.ceil(remaining / 1000) }
}

/** Starts a fresh idle period after signing in, and drops any old notice. */
export function startIdlePeriod(now = Date.now()) {
  memoryActivity = 0
  recordActivity(now, { force: true })
  write(NOTICE_KEY, null)
}

/**
 * Marks that the account was signed out for being idle (for the sign-in page).
 * The old activity time stays, so if the server could not be told (offline),
 * reopening the app before signing in again still finds the session expired.
 */
export function noteIdleSignOut(now = Date.now()) {
  memoryActivity = 0
  write(NOTICE_KEY, now)
}

/** Whether the sign-in page should say the account was signed out for being idle. */
export function wasRecentlySignedOutForIdle(now = Date.now()) {
  const at = readNumber(NOTICE_KEY)
  return Boolean(at) && now - at < NOTICE_MAX_AGE_MS
}

/** Forgets the idle notice (after a deliberate sign-out). */
export function clearIdleNotice() {
  write(NOTICE_KEY, null)
}
