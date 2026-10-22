import { useEffect, useRef } from 'react'

// Dialogs that are open right now, oldest first, so Escape only closes the top one.
const openDialogs = []

/**
 * Lets the Escape key close a dialog by running the same close action as
 * clicking its backdrop (including any "busy, don't close" guard in it).
 * When dialogs are stacked, only the most recently opened one responds.
 */
export default function useEscapeToClose(open, onClose) {
  const latestClose = useRef(onClose)
  useEffect(() => { latestClose.current = onClose })
  useEffect(() => {
    if (!open) return undefined
    const dialog = {}
    openDialogs.push(dialog)
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented || openDialogs.at(-1) !== dialog) return
      event.preventDefault()
      latestClose.current()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      openDialogs.splice(openDialogs.indexOf(dialog), 1)
    }
  }, [open])
}
