import { AlertTriangle, Check, LoaderCircle } from 'lucide-react'

// "Saving…", "All changes saved", or what went wrong, for screens that save
// each change by themselves instead of with a Save button.
export default function AutoSaveStatus({ status }) {
  const state = status?.state || 'idle'
  return <span className={`auto-save-status is-${state}`} role="status" aria-live="polite">
    {state === 'saving' && <><LoaderCircle size={14} className="auto-save-spin" aria-hidden="true" /> Saving…</>}
    {state === 'saved' && <><Check size={14} aria-hidden="true" /> All changes saved</>}
    {state === 'error' && <><AlertTriangle size={14} aria-hidden="true" /> Not saved: {status.message}</>}
    {state === 'idle' && <>Changes save automatically</>}
  </span>
}
