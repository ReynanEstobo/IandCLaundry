import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'

// "Show pop-up confirmations" belongs to each person on their own browser,
// like the theme. When it is off, confirmations (success and progress
// messages) are not created at all, so none can appear later when it is
// turned back on. Errors and warnings are never affected.
const PREFERENCE_EVENT = 'ic-laundry:toast-preference-change'
let currentUserId = null
// Used when the browser blocks saved site data, so the switch still works
// for the rest of the visit.
const remembered = new Map()

export function toastPreferenceKey(userId) {
  return userId ? `ic-laundry:toasts:${userId}` : null
}

function browserStorage() {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function readToastPreference(userId, storage = browserStorage()) {
  const key = toastPreferenceKey(userId)
  if (!key) return true
  try {
    const saved = storage?.getItem(key)
    if (saved) return saved !== 'off'
  } catch {
    // Fall back to this visit's choice below.
  }
  return remembered.get(key) !== 'off'
}

// Whether confirmations may pop up for the person signed in on this screen.
export function confirmationsEnabled() {
  return readToastPreference(currentUserId)
}

// Wraps toast.success and toast.loading once, so every screen follows the
// setting without changing how it shows messages. toast.error and plain
// notices (warnings) are left as they are.
export function installConfirmationFilter(target, isEnabled = confirmationsEnabled) {
  if (!target || target.confirmationFilterInstalled) return
  for (const kind of ['success', 'loading']) {
    const show = target[kind]
    target[kind] = (message, options) => (isEnabled() ? show(message, options) : '')
  }
  target.confirmationFilterInstalled = true
}

installConfirmationFilter(toast)

export default function useToastPreference(userId) {
  const [enabled, setEnabled] = useState(() => readToastPreference(userId))

  useEffect(() => {
    currentUserId = userId || null
    const sync = () => setEnabled(readToastPreference(userId))
    const handleStorage = (event) => { if (event.key === toastPreferenceKey(userId)) sync() }
    sync()
    window.addEventListener(PREFERENCE_EVENT, sync)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(PREFERENCE_EVENT, sync)
      window.removeEventListener('storage', handleStorage)
    }
  }, [userId])

  const setPreference = useCallback((next) => {
    currentUserId = userId || null
    const key = toastPreferenceKey(userId)
    if (key) {
      remembered.set(key, next ? 'on' : 'off')
      try {
        browserStorage()?.setItem(key, next ? 'on' : 'off')
      } catch {
        // The remembered choice above still applies for this visit.
      }
    }
    setEnabled(Boolean(next))
    window.dispatchEvent(new Event(PREFERENCE_EVENT))
  }, [userId])

  return { enabled, setPreference }
}
