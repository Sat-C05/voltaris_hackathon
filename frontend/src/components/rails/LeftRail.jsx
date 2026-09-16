import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import FaultInjectionPanel from './panels/FaultInjectionPanel'
import ScenariosPanel from './panels/ScenariosPanel'
import WorldControlPanel from './panels/WorldControlPanel'
import Legend from '../Legend'
import {
  LEFT_RAIL_GLIDE_EASING,
  LEFT_RAIL_GLIDE_MS,
  LEFT_RAIL_IDLE_CENTER_FRACTION,
  LEFT_RAIL_RETURN_DELAY_MS,
  leftRailSectionMaxHeight,
  leftRailShiftPx,
} from './railGeometry'

const SECTIONS = [
  { id: 'fault', title: 'FAULT INJECTION' },
  { id: 'scenarios', title: 'SCENARIOS' },
  { id: 'world', title: 'WORLD CONTROL' },
]

// Left rail: the operator's tools — without them there is no way to drive the demo from the
// deck at all, no way to inject a fault, run a scenario, or see an incident open. A floating
// glass panel over the deck, sized to its content, rather than a full-height docked column.
// Narrowed and tightened since: width down from 320px to
// 260px, header padding tightened, scroll area shortened; no text below 13px anywhere in the
// panels below, so anything that no longer fit at the new width was reflowed instead (see the
// golden-run row in ScenariosPanel.jsx, changed from one cramped three-column row to two lines).
//
// P14: vertical position comes from `railGeometry.js`, the SAME module `deck/windows/layout.js`
// reads to exclude this box from the tiler — never a hand-picked number here. The rail sits
// centred on the deck's vertical middle, and nudges DOWN by ~10% of the deck's height while an
// incident exists ("only slightly... to give space for the incident and the agent windows").
//
// P14b — how that nudge is rendered, and why it is not the obvious thing:
//
//  1. The anchor is a STATIC `top: 50%` plus `-50%` of the panel's own height. Neither value
//     ever animates, so the panel stays centred on the idle line for any content height
//     (accordion open, closed, or mid-transition) — a plain top-edge fraction would only
//     "centre" for one particular height.
//  2. The nudge itself is a second, composited `translate3d` on the same transform. It used to
//     be an animated `top`, which re-ran layout every frame and, because `.voltaris-panel` is
//     `backdrop-filter: blur(10px)`, re-blurred the whole deck behind it every frame too. It
//     stepped rather than glided. Nothing about the geometry changed — see `leftRailShiftPx`.
//  3. The shift is a fraction of the DECK's height, not of the panel's, so it has to be
//     measured. `useLayoutEffect` takes that measurement before the first paint, which is why
//     a reload in the middle of a live incident renders shifted rather than visibly jumping
//     there; a `ResizeObserver` keeps it true afterwards.
//  4. `transitionDelay` is asymmetric on purpose (see `LEFT_RAIL_RETURN_DELAY_MS`): the rail
//     leads on the way down and follows on the way back up.
//  5. `willChange` is set only while the glide is actually in flight. Leaving it on permanently
//     would keep the rail on its own composited layer for the entire demo, which on an
//     integrated GPU costs more than the one move it was meant to help.
//
// Reduced motion is honoured through Tailwind's own `motion-reduce:` variant (`index.css` is
// off-limits here, and Tailwind ships that variant without needing an entry there), which
// zeroes the transition — the rail still ends up in the right place, it just gets there
// instantly, like every other one-shot move on the deck.
export default function LeftRail({ snapshot, onOpenReplay }) {
  const [openId, setOpenId] = useState('fault')
  const hasIncident = !!(snapshot?.incidents?.length)

  const asideRef = useRef(null)
  const [boxH, setBoxH] = useState(0)
  // `armed` gates the glide ON, one frame after the first measurement. Without it the rail
  // SLIDES DOWN ON PAGE LOAD whenever the world already has an incident: the first render has
  // no measurement yet (shift 0), the layout effect below reads `clientHeight` — which forces a
  // style flush — and the corrected shift then arrives as a *changed* value between two style
  // recalcs, which is precisely the condition a CSS transition fires on. The panel is in the
  // right place either way, so this is invisible to code review; it was caught by the headless
  // render (`render-html-preview.sh`), whose probe showed a computed
  // `matrix(1,0,0,1,0,-215.25)` — the un-shifted start of an in-flight animation — on a frame
  // that should have been at rest. A reload mid-incident must LOOK like the rail was always
  // there, because it always was.
  const [armed, setArmed] = useState(false)

  // Measure the deck box this rail is absolutely positioned inside — the `relative min-h-0
  // flex-1` wrapper in `DeckApp.jsx`, which is also exactly the box `tileWindows` is handed as
  // `boxH`. Reading it off `offsetParent` rather than threading a prop down keeps the two
  // consumers of `railGeometry` reading the same box without a new contract between them.
  // `useLayoutEffect`, not `useEffect`: it runs before the browser paints, so the corrected
  // shift is in place on the very first frame.
  useLayoutEffect(() => {
    const parent = asideRef.current?.offsetParent
    if (!parent) return
    setBoxH(parent.clientHeight)
    const raf = requestAnimationFrame(() => setArmed(true))
    if (typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(raf)
    const ro = new ResizeObserver(() => setBoxH(parent.clientHeight))
    ro.observe(parent)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [])

  const shiftPx = leftRailShiftPx(boxH, hasIncident)
  const sectionMaxH = leftRailSectionMaxHeight(boxH)

  // `gliding` is true only for the duration of one move, and drives `willChange` (5 above). It
  // is keyed on `hasIncident` alone — deliberately NOT on `shiftPx`, which also changes when
  // the window is resized; promoting the rail to its own layer mid-resize would be paying the
  // cost exactly when the compositor is busiest.
  const [gliding, setGliding] = useState(false)
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    setGliding(true)
    const delay = hasIncident ? 0 : LEFT_RAIL_RETURN_DELAY_MS
    const t = setTimeout(() => setGliding(false), delay + LEFT_RAIL_GLIDE_MS + 60)
    return () => clearTimeout(t)
  }, [hasIncident])

  return (
    <aside
      ref={asideRef}
      className="voltaris-panel absolute left-4 z-20 w-[260px] overflow-hidden rounded-md border border-edge transition-transform motion-reduce:transition-none"
      style={{
        top: `${LEFT_RAIL_IDLE_CENTER_FRACTION * 100}%`,
        transform: `translate3d(0, calc(-50% + ${shiftPx}px), 0)`,
        transitionDuration: armed ? `${LEFT_RAIL_GLIDE_MS}ms` : '0ms',
        transitionTimingFunction: LEFT_RAIL_GLIDE_EASING,
        transitionDelay: armed && !hasIncident ? `${LEFT_RAIL_RETURN_DELAY_MS}ms` : '0ms',
        willChange: gliding ? 'transform' : undefined,
      }}
    >
      {SECTIONS.map((section) => {
        const open = openId === section.id
        return (
          <div key={section.id} className="border-b border-edge/70 last:border-b-0">
            <button
              onClick={() => setOpenId(open ? null : section.id)}
              aria-expanded={open}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] tracking-[0.18em] text-dim transition-colors hover:text-ink"
            >
              <span className={`transition-transform duration-300 ease-out motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}>▸</span>
              {section.title}
            </button>
            {/* P14b — the accordion collapses smoothly instead of snapping.
                `grid-template-rows: 1fr -> 0fr` is the only way to transition to a content
                height CSS does not know in advance (a `max-height` guess would either clip the
                longest panel or make the short ones look like they drain out slowly), and it is
                the reason this rail's total height now changes over the same 300ms rather than
                in one frame. That matters more here than in a normal accordion: the panel is
                centred on its own midpoint, so an instant height change moved BOTH edges at
                once — the jump that made the whole rail feel unfinished.
                Consequence, on purpose: all three panels are now mounted all the time (a
                closed one is a 0fr row, not an absent subtree). They are display + buttons;
                the only mount side effects are `useScenarios`' two cheap one-shot GETs, which
                now happen at load instead of flashing a loading state the first time a judge
                opens SCENARIOS — and `ScenariosPanel`'s director-phase effect, which previously
                did not run at all while the section was closed. `inert` keeps a collapsed
                panel's buttons out of the tab order; `overflow-hidden` is what actually does
                the clipping. */}
            <div
              className={`grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
              {...(open ? {} : { inert: '' })}
            >
              <div className="overflow-hidden">
                <div className="overflow-y-auto px-2.5 pb-2.5" style={{ maxHeight: sectionMaxH }}>
                  {!snapshot ? (
                    <p className="text-[13px] text-dim/70">waiting for the world…</p>
                  ) : section.id === 'fault' ? (
                    <FaultInjectionPanel
                      faults={snapshot.faults ?? []}
                      simTime={snapshot.sim_time}
                      stationIds={Object.keys(snapshot.stations).sort()}
                    />
                  ) : section.id === 'scenarios' ? (
                    <ScenariosPanel onOpenReplay={onOpenReplay} />
                  ) : (
                    <WorldControlPanel stations={snapshot.stations} />
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })}
      {/* P9 — the key to the deck's five-state colour vocabulary, PERMANENT: not an accordion
          section, because a key you have to open is a key nobody opens, and the ninety seconds a
          judge spends here does not include hunting for it. It lives in this rail rather than the
          right one because the right column's INCIDENTS list is the `flex-1` element there and is
          the only way to reopen a closed incident window — taking ~120px from it would have been
          paid for out of the one section that must never collapse (see RightRail.jsx). It is
          NOT in the status bar either: anything that changes the header's HEIGHT re-opens the
          `slice` crop maths for GW-01 and the deck (STATUS.md, lesson 6).
          Its height is accounted for in `railGeometry.js`'s SECTION_CHROME_PX. */}
      <Legend />
    </aside>
  )
}
