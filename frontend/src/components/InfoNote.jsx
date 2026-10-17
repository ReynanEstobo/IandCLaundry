import { CircleAlert, Info } from 'lucide-react'

/**
 * A consistent, non-blocking explanation for a form or page section.
 * It is deliberately presentational: it never changes validation, values,
 * permissions, or the action a user is able to take.
 */
export default function InfoNote({ title, children, tone = 'info', compact = false, className = '' }) {
  const Icon = tone === 'warning' ? CircleAlert : Info

  return (
    <aside className={`info-note info-note--${tone}${compact ? ' info-note--compact' : ''}${className ? ` ${className}` : ''}`} role="note">
      <Icon className="info-note__icon" size={compact ? 16 : 18} aria-hidden="true" />
      <div className="info-note__content">
        {title && <strong className="info-note__title">{title}</strong>}
        <div className="info-note__text">{children}</div>
      </div>
    </aside>
  )
}
