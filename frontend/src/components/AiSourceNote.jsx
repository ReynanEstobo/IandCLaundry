import { geminiModelLabel } from '../utils/aiOutputCache'

export const PENDING_AI_META = { source: 'pending', model: '', savedAt: null, isCached: false, staleData: false, reason: '' }

const formatAiTime = timestamp => new Date(timestamp).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })

// Says plainly whether a section shows Gemini output or the local baseline, and why.
export default function AiSourceNote({ meta, label }) {
  if (meta.source === 'pending') return null
  const isGemini = meta.source === 'gemini'
  const model = geminiModelLabel(meta.model) || 'Gemini'
  let detail
  if (!isGemini) detail = `Not Gemini output. ${meta.reason || 'Gemini did not return a result.'}`
  else if (meta.reason) detail = `Showing the last ${label} from ${model} (${formatAiTime(meta.savedAt)}). Gemini could not refresh it: ${meta.reason}`
  else detail = `${model} · generated ${formatAiTime(meta.savedAt)}${meta.isCached ? ' (cached)' : ''}${meta.staleData ? ' · made before the latest records' : ''}`
  return (
    <p className={`ai-source-note ai-source-note-${meta.source}`}>
      <span className={`badge ai-source-badge ai-source-${meta.source}`}>{isGemini ? 'Gemini AI' : 'Local baseline'}</span>
      <span>{detail}</span>
    </p>
  )
}
