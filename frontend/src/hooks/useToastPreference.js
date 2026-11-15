import { useCallback, useEffect, useState } from 'react'

// "Show toast notifications" belongs to each person on their own browser, like
// the theme. It used to be one setting for the whole shop, so one person
// turning it off hid every message for everyone, refusals included.
const PREFERENCE_EVENT = 'ic-laundry:toast-preference-change'

export function toastPreferenceKey(userId) {
  return userId ? `ic-laundry:toasts:${userId}` : null
}

export function readToastPreference(userId, storage = typeof window === 'undefined' ? null : window.localStorage) {
  const key = toastPreferenceKey(userId)
  if (!key || !storage) return true
  try {
    return storage.getItem(key) !== 'off'
  } catch {
    return true
  }
}

// Confirmations and progress messages can be hidden. Errors and warnings
// always show: they explain why something was refused or needs attention.
export function isHideableToast(toast) {
  return toast?.type === 'success' || toast?.type === 'loading'
}

export default function useToastPreference(userId) {
  const [enabled, setEnabled] = useState(() => readToastPreference(userId))

  useEffect(() => {
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
    const key = toastPreferenceKey(userId)
    if (key) {
      try {
        window.localStorage.setItem(key, next ? 'on' : 'off')
      } catch {
        // Still applies to this screen when storage is unavailable.
      }
    }
    setEnabled(Boolean(next))
    window.dispatchEvent(new Event(PREFERENCE_EVENT))
  }, [userId])

  return { enabled, setPreference }
}
