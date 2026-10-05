import { useEffect, useState } from 'react'

function readStoredUntil(storageKey) {
  if (!storageKey || typeof window === 'undefined') return 0
  try {
    const until = Number(window.sessionStorage.getItem(storageKey))
    return until > Date.now() ? until : 0
  } catch {
    return 0
  }
}

export default function useOtpCooldown(storageKey) {
  const [until, setUntil] = useState(() => readStoredUntil(storageKey))
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (!until) return undefined
    const update = () => {
      const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setRemaining(seconds)
      if (!seconds) setUntil(0)
    }
    update()
    const timer = window.setInterval(update, 1000)
    return () => window.clearInterval(timer)
  }, [until])

  useEffect(() => {
    if (!storageKey || typeof window === 'undefined') return
    try {
      if (until > Date.now()) window.sessionStorage.setItem(storageKey, String(until))
      else window.sessionStorage.removeItem(storageKey)
    } catch {
      // The cooldown still works for this page session if browser storage is unavailable.
    }
  }, [storageKey, until])

  const clear = () => {
    setUntil(0)
    setRemaining(0)
    if (!storageKey || typeof window === 'undefined') return
    try { window.sessionStorage.removeItem(storageKey) } catch { /* Keep the reset in memory. */ }
  }

  return {
    remaining,
    start: (seconds = 300) => setUntil(Date.now() + Math.max(0, Number(seconds) || 0) * 1000),
    clear,
    label: remaining ? `Resend OTP in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Resend verification code',
    message: remaining ? `For security, you can request another OTP in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}.` : '',
  }
}
