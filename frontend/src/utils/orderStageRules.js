// A staff member may move an order back only to undo their own most recent
// stage change, within the undo window from Settings. The database enforces
// this. Each order in the list carries `stage_undo` from the database: who
// made the latest stage change and how many seconds remain to undo it (null
// when staff cannot undo it). The deadline counts from when the list was
// requested, so the computer's own clock does not matter, and it errs on the
// early side. Administrators may always correct a stage.

export function withUndoDeadline(order, requestedAt) {
  const undo = order?.stage_undo
  const seconds = Number(undo?.seconds_left)
  return {
    ...order,
    undo_staff_id: undo?.staff_id || null,
    undo_until: undo?.staff_id && Number.isFinite(seconds) && seconds > 0 ? requestedAt + seconds * 1000 : null,
  }
}

export function canStaffUndoStage(order, { staffId, now = Date.now() } = {}) {
  return Boolean(order && staffId && order.undo_staff_id === staffId && order.undo_until && now < order.undo_until)
}

export function undoSecondsLeft(order, now = Date.now()) {
  return order?.undo_until ? Math.max(0, Math.ceil((order.undo_until - now) / 1000)) : 0
}

// Why a staff member cannot move an order back, in words they can act on.
// `rememberedDeadline` is the end of this person's own undo time for the
// order, if the screen saw one earlier: it tells "your time ran out" apart
// from "someone else has worked on the order since".
export function moveBackStatus(order, { staffId, now = Date.now(), rememberedDeadline = null, undoSeconds = 60 } = {}) {
  if (canStaffUndoStage(order, { staffId, now })) return { allowed: true, secondsLeft: undoSecondsLeft(order, now) }
  const seconds = Math.max(Number(undoSeconds) || 60, 1)
  if (rememberedDeadline && now >= rememberedDeadline) {
    return {
      allowed: false, reason: 'expired', hint: 'Undo time ended · ask an administrator',
      message: `Your ${seconds}-second undo time for this order has ended. Ask an administrator to move it back.`,
    }
  }
  if (rememberedDeadline) {
    return {
      allowed: false, reason: 'changed', hint: 'Changed by someone else · ask an administrator',
      message: 'Someone else has worked on this order since your step, so it can no longer be undone here. Ask an administrator to move it back.',
    }
  }
  return {
    allowed: false, reason: 'not_yours', hint: 'Ask an administrator',
    message: `Staff can undo only their own latest step on an order, within ${seconds} seconds. Ask an administrator to move it back.`,
  }
}
