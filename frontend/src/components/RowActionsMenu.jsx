import { MoreHorizontal } from 'lucide-react'
import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

/**
 * "More actions" menu for a table row. Each item keeps the handler and the
 * visibility rule its row already uses; this component only decides where the
 * actions are shown. The menu is positioned against the viewport so a
 * scrolling table can never clip it, and it opens upward near the bottom edge.
 */
export default function RowActionsMenu({ label, items }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)
  const menuId = useId()

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return
    const trigger = triggerRef.current.getBoundingClientRect()
    const menu = menuRef.current.getBoundingClientRect()
    const opensDown = trigger.bottom + 4 + menu.height <= window.innerHeight - 8
    setPosition({
      top: opensDown ? trigger.bottom + 4 : Math.max(8, trigger.top - 4 - menu.height),
      left: Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8)),
      origin: opensDown ? 'top right' : 'bottom right',
    })
    menuRef.current.querySelector('[role="menuitem"]:not(:disabled)')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const closeOnOutsidePress = event => {
      if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false)
    }
    const dismiss = () => setOpen(false)
    document.addEventListener('pointerdown', closeOnOutsidePress)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  if (!items.length) return null

  const toggle = () => {
    setPosition(null)
    setOpen(current => !current)
  }

  const moveFocus = event => {
    const options = [...menuRef.current.querySelectorAll('[role="menuitem"]:not(:disabled)')]
    const index = options.indexOf(document.activeElement)
    let next = null
    if (event.key === 'ArrowDown') next = options[(index + 1) % options.length]
    if (event.key === 'ArrowUp') next = options[(index - 1 + options.length) % options.length]
    if (event.key === 'Home') next = options[0]
    if (event.key === 'End') next = options[options.length - 1]
    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'Tab') setOpen(false)
    if (next) {
      event.preventDefault()
      next.focus()
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn-icon row-actions-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={toggle}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
        <span className="mobile-action-label">More</span>
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className="row-actions-menu"
          onKeyDown={moveFocus}
          style={{
            top: position?.top ?? 0,
            left: position?.left ?? 0,
            transformOrigin: position?.origin,
            visibility: position ? 'visible' : 'hidden',
          }}
        >
          {items.map((item, index) => {
            const Icon = item.icon
            const startsDangerGroup = item.tone === 'danger' && index > 0 && items[index - 1].tone !== 'danger'
            return (
              <Fragment key={item.key}>
                {startsDangerGroup && <div className="row-actions-menu-separator" role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  className={`row-actions-menu-item ${item.tone === 'danger' ? 'is-danger' : ''}`}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false)
                    item.onSelect()
                  }}
                >
                  {Icon && <Icon size={15} aria-hidden="true" />}
                  <span>{item.label}</span>
                </button>
              </Fragment>
            )
          })}
        </div>
      )}
    </>
  )
}
