import { AlertCircle } from 'lucide-react'

/**
 * The one look for a form that could not accept what was entered, such as a
 * wrong current password or mismatched passwords. Use `compact` directly under
 * the field the message is about, and the full size above the form's button
 * for problems that are not about one field.
 */
export default function FormAlert({ children, compact = false, id }) {
  if (!children) return null
  return (
    <div id={id} className={`form-alert${compact ? ' form-alert--compact' : ''}`} role="alert">
      <AlertCircle className="form-alert__icon" size={compact ? 14 : 16} aria-hidden="true" />
      <span className="form-alert__text">{children}</span>
    </div>
  )
}
