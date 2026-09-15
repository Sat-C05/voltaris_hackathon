import { useEffect, useRef } from 'react'
import { WINDOW_WIDTH } from './layout'
import CornerTicks from '../../CornerTicks'

const HEADER_TONE = {
  default: 'bg-void/40 text-ink/80',
  mint: 'bg-mint/15 text-mint',
  amber: 'bg-amber/15 text-amber',
  rose: 'bg-rose/15 text-rose',
}

// The one shared window shell. Chrome only — content is
// passed as children. Drag is driven entirely through a ref and a direct DOM write on
// pointermove: `transform` is written straight to the node, and the new
// position is committed to React state exactly once, on pointerup. A 60fps `setState` here
// would fight the 500ms snapshot poll and every CSS animation running at once.
export default function Window({
  id, title, glyph, x, y, z, headerTone = 'default', width = WINDOW_WIDTH,
  onRaise, onClose, onDragEnd, onDragFrame, containerRef, nodeRef, children,
}) {
  const dragRef = useRef(null)

  function handleTitlePointerDown(e) {
    // Only the primary (left) button starts a drag. A middle-button press on the titlebar is
    // handled by the outer node's `onMouseDown`/`onAuxClick` below (close-on-middle-click) —
    // returning here before `setPointerCapture` means no drag ever starts and no capture is
    // ever taken for it, so there is nothing stale to release afterward.
    if (e.button !== 0) return
    onRaise(id)
    const node = nodeRef.current
    if (!node) return
    // Capture on the TITLEBAR (`e.currentTarget`), not on the outer window node. Pointer
    // capture retargets every subsequent pointer event to the capture element, and React
    // dispatches synthetic events along the path from that target upwards — so capturing on
    // the outer div sends the moves to an element the titlebar is a *descendant* of, and the
    // `onPointerMove`/`onPointerUp` handlers below (which live on the titlebar) never fire at
    // all. The window would simply not drag. Found in review; it could not have
    // been caught without a browser or this reasoning, only by moving a window.
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: x, origY: y, lastX: x, lastY: y }
  }

  function handleTitlePointerMove(e) {
    const drag = dragRef.current
    const node = nodeRef.current
    if (!drag || !node) return
    let nx = drag.origX + (e.clientX - drag.startX)
    let ny = drag.origY + (e.clientY - drag.startY)
    // Clamp to the Deck bounds.
    const bounds = containerRef.current?.getBoundingClientRect()
    if (bounds) {
      const ww = node.offsetWidth
      const wh = node.offsetHeight
      nx = Math.min(Math.max(nx, 0), Math.max(0, bounds.width - ww))
      ny = Math.min(Math.max(ny, 0), Math.max(0, bounds.height - wh))
    }
    node.style.transform = `translate3d(${nx}px, ${ny}px, 0)`
    drag.lastX = nx
    drag.lastY = ny
    onDragFrame?.(id)
  }

  function handleTitlePointerUp(e) {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    onDragEnd(id, { x: drag.lastX, y: drag.lastY })
  }

  // React only owns position at rest. This effect exists for the one-time commit (spawn, or
  // the pointerup after a drag) — while `dragRef.current` is set, the pointermove handler
  // above is the one writing `transform`, and this effect must not fight it.
  useEffect(() => {
    const node = nodeRef.current
    if (node && !dragRef.current) {
      node.style.transform = `translate3d(${x}px, ${y}px, 0)`
    }
  }, [x, y, nodeRef])

  return (
    <div
      ref={nodeRef}
      // `left-0 top-0` is load-bearing, not decoration: an absolutely-positioned element with
      // no inset resolves to its *static* position, which here falls after the deck's in-flow
      // full-height <svg> — so every window was being laid out below the bottom of the deck and
      // then translated from there, i.e. off the bottom of the screen entirely, with its leader
      // line shooting off-screen to meet it. Found in review after a report of
      // "i cannot see the escalated incident... some lines are going out of my screen".
      className="voltaris-panel absolute left-0 top-0 rounded-md border border-edge"
      style={{ width, transform: `translate3d(${x}px, ${y}px, 0)`, zIndex: z }}
      onPointerDownCapture={() => onRaise(id)}
      onClick={(e) => e.stopPropagation()}
      // Middle-click anywhere on the window closes it ("when i
      // press my scroll button on my mouse on a hovering window, it should close it"). The
      // `mousedown` preventDefault suppresses the browser's own middle-click autoscroll icon;
      // the actual close happens on `auxclick` (fired for the non-primary buttons on release),
      // same semantics as the ✕ — hidden, reopenable from the right rail, never deleted.
      onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        e.stopPropagation()
        onClose(id)
      }}
    >
      {/* Spawn animation lives on this inner wrapper, never the outer node — the outer node's
          own `transform` is the drag/position value and must never be fought by a keyframe. */}
      <div className="voltaris-window-spawn relative">
        <CornerTicks />
        <div
          className={`flex h-7 cursor-move select-none items-center gap-2 rounded-t-md border-b border-edge/70 px-2 text-[13px] tracking-wide ${HEADER_TONE[headerTone] ?? HEADER_TONE.default}`}
          onPointerDown={handleTitlePointerDown}
          onPointerMove={handleTitlePointerMove}
          onPointerUp={handleTitlePointerUp}
        >
          <span>{glyph}</span>
          <span className="flex-1 truncate">{title}</span>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(id) }}
            onPointerDown={(e) => e.stopPropagation()}
            className="rounded px-1 leading-none text-dim hover:text-ink"
            aria-label="close"
          >
            ✕
          </button>
        </div>
        <div className="p-3 text-[13px] text-dim">{children}</div>
      </div>
    </div>
  )
}
