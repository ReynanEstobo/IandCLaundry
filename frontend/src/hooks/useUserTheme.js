import { useCallback, useEffect, useState } from 'react'

const THEME_EVENT = 'ic-laundry:user-theme-change'

function preferenceKey(userId) {
  return userId ? `ic-laundry:theme:${userId}` : null
}

function readTheme(userId) {
  const key = preferenceKey(userId)
  if (!key || typeof window === 'undefined') return 'light'
  try {
    return window.localStorage.getItem(key) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(theme) {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-theme', theme)
}

export default function useUserTheme(userId) {
  const [theme, setThemeState] = useState(() => readTheme(userId))

  useEffect(() => {
    const syncTheme = () => {
      const nextTheme = readTheme(userId)
      setThemeState(nextTheme)
      applyTheme(nextTheme)
    }
    const handleStorage = (event) => {
      if (event.key === preferenceKey(userId)) syncTheme()
    }

    syncTheme()
    window.addEventListener(THEME_EVENT, syncTheme)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(THEME_EVENT, syncTheme)
      window.removeEventListener('storage', handleStorage)
    }
  }, [userId])

  const setTheme = useCallback((nextTheme) => {
    const normalizedTheme = nextTheme === 'dark' ? 'dark' : 'light'
    const key = preferenceKey(userId)
    if (key) {
      try {
        window.localStorage.setItem(key, normalizedTheme)
      } catch {
        // The current screen can still use the theme when storage is unavailable.
      }
    }
    setThemeState(normalizedTheme)
    applyTheme(normalizedTheme)
    window.dispatchEvent(new Event(THEME_EVENT))
  }, [userId])

  return {
    theme,
    darkMode: theme === 'dark',
    setTheme,
    toggleTheme: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
  }
}
