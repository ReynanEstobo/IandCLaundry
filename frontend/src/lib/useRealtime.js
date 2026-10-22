import { useEffect, useRef } from 'react'
import { supabase } from './supabase'

/**
 * Subscribe to realtime changes on one or more Supabase tables.
 * Calls `onChanged` whenever an INSERT, UPDATE, or DELETE happens.
 *
 * @param {string[]} tables - Array of table names to watch
 * @param {Function} onChanged - Callback invoked on any change
 */
export function useRealtime(tables, onChanged) {
  const refreshTimer = useRef(null)
  const pollingTimer = useRef(null)
  const onChangedRef = useRef(onChanged)

  // Keep the subscription stable while always using the current page/filter
  // state in its refresh callback.
  useEffect(() => {
    onChangedRef.current = onChanged
  }, [onChanged])

  useEffect(() => {
    if (!tables || tables.length === 0 || !onChanged) return

    const channelName = `realtime-${tables.join('-')}-${Math.random().toString(36).slice(2, 8)}`
    let channel = supabase.channel(channelName)

    tables.forEach(table => {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table },
        () => {
          // A single action may write to multiple related rows (for example,
          // an order, its history, and inventory usage). Wait briefly so the
          // page performs one background refresh after the transaction settles.
          if (refreshTimer.current) clearTimeout(refreshTimer.current)
          refreshTimer.current = setTimeout(() => onChangedRef.current?.(), 250)
        }
      )
    })

    channel.subscribe()

    // The local Node server provides Server-Sent Events, while the deployed
    // Cloudflare Worker deliberately does not keep a Node event stream alive.
    // A light background poll keeps every data screen current in production
    // without interrupting the page or showing a full-screen loader.
    // A hidden tab skips its polls (nobody is looking at it, and many idle
    // tabs would otherwise keep reloading full histories), then refreshes once
    // as soon as it is shown again, so what appears on screen is never stale.
    let missedPoll = false
    pollingTimer.current = setInterval(() => {
      if (document.hidden) {
        missedPoll = true
        return
      }
      onChangedRef.current?.()
    }, 30_000)
    const refreshWhenShown = () => {
      if (document.hidden || !missedPoll) return
      missedPoll = false
      onChangedRef.current?.()
    }
    document.addEventListener('visibilitychange', refreshWhenShown)

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      if (pollingTimer.current) clearInterval(pollingTimer.current)
      document.removeEventListener('visibilitychange', refreshWhenShown)
      supabase.removeChannel(channel)
    }
  }, [tables.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps
}
