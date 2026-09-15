import { useState } from 'react'
import FaultInjectionPanel from './panels/FaultInjectionPanel'
import ScenariosPanel from './panels/ScenariosPanel'
import WorldControlPanel from './panels/WorldControlPanel'

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
export default function LeftRail({ snapshot, onOpenReplay }) {
  const [openId, setOpenId] = useState('fault')

  return (
    <aside className="voltaris-panel absolute left-4 top-4 z-20 w-[260px] overflow-hidden rounded-md border border-edge">
      {SECTIONS.map((section) => {
        const open = openId === section.id
        return (
          <div key={section.id} className="border-b border-edge/70 last:border-b-0">
            <button
              onClick={() => setOpenId(open ? null : section.id)}
              className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-[13px] tracking-[0.18em] text-dim transition-colors hover:text-ink"
            >
              <span className={`transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
              {section.title}
            </button>
            {open && (
              <div className="max-h-[320px] overflow-y-auto px-2.5 pb-2.5">
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
            )}
          </div>
        )
      })}
    </aside>
  )
}
