import { useEvents } from '../../useEvents'
import HoverCard from '../deck/HoverCard'

// How many ticker rows are kept around to draw from. Display-only, like the ticker itself.
const VISIBLE_EVENTS = 14

// The event ticker's own fixed height (header + body). Never changes for any reason — not on
// hover, not on selection, not on incident count — that stability is the whole point of this
// round's fix (see the `<aside>` comment below).
const TICKER_MAX_H = 240

// The vitals section's fixed height (header + body), reserved-space round. This section is now
// PERMANENT — always mounted, always this tall, whether or not anything is hovered or pinned —
// so nothing else in the column ever has to make room for it appearing. Derived from
// HoverCard.jsx's own compacted two-column layout: header row (~20px) + 1 connector row (~20px)
// + divider (~13px) + a 2-row telemetry grid (~40px, was 4 rows/~80px before compaction) +
// divider (~13px) + a 3-row component grid (~60px, was 6 rows/~120px) + this section's own p-3
// content padding (24px) ≈ 190px; rounded up to 208px for slack against a possible one-line wrap
// on the HANDSHAKE readout (see HoverCard.jsx's own comment). Not verified in a browser — if a
// human sees the vitals content clipped at the bottom of its slot, raise this constant; if there
// is visibly dead space below the content, lower it and give the room back to INCIDENTS.
const VITALS_H = 208

const SEVERITY_COLOR = {
  HIGH: 'text-rose',
  MEDIUM: 'text-amber',
  LOW: 'text-dim',
  INFO: 'text-dim',
}

const STATUS_COLOR = {
  RESOLVED: 'text-mint',
  ESCALATED: 'text-amber',
  FAILED: 'text-rose',
}

// Right rail. INCIDENTS is wired to `snapshot.incidents`, which is what gives a closed
// window a way back — without it, closing an incident window left no affordance to reopen
// it. Clicking a row reopens/raises that incident's
// window (via `onSelectIncident`, which WindowLayer listens for) and selects its station on the
// deck. The event ticker stays wired to the existing `useEvents` hook.
//
// The vitals card lives here too, as a permanent third instrument in this column rather than an
// absolutely-positioned overlay floating over the deck (Deck.jsx used to own it). Reworked three
// times now:
//   1. moved the card here, but paid for its new slot with a `flex-1 min-h-0`
//      ticker section that grew to fill the column when nothing was hovered and visibly shrank
//      the instant the card appeared — "when i dont hover over a station, the event ticker
//      extends all the way to the ground, and when i hover, it shrinks... i dont want that bug."
//   2. (hover/pin round) reverted to fixed `shrink-0` sections for INCIDENTS and EVENT TICKER,
//      with the card as a conditionally-mounted `shrink-0` child appearing below them. That kept
//      the ticker itself stable, but its own fallback — "shrink INCIDENTS' cap to make room" —
//      did the arithmetic wrong: at 1280×720 the fixed ticker (240) plus the card's *un*compacted
//      height (~286px) plus both headers already exceeded the ~632px column budget, leaving
//      INCIDENTS a cap of a few pixels — the same mistake as attempt 1, just moved to a
//      different panel.
//   3. (this round) the actual fix: the vitals section is now PERMANENT and fixed-height
//      (`VITALS_H`, always rendered, never conditional — see HoverCard.jsx for its own empty
//      state), its content compacted into two-column grids so the reserved slot is smaller, and
//      **INCIDENTS is now the one flexible element** (`flex-1 min-h-0`) that absorbs whatever
//      the viewport has left after the ticker and the vitals section take their fixed shares.
//      This is stable under hover by construction (nothing is conditional any more) and self-
//      fits at any window size, rather than depending on hand-picked pixels that only balance at
//      exactly 1280×720 — incidents is a reopen affordance with typically one or two rows in a
//      demo, so it is the right element to let flex.
//
// Pin/hover fallback (hover/pin round, unchanged by this rework): `displayId` is
// `hoveredId ?? selectedStationId` — a hover always wins over a pinned (selected) station, and
// the moment the pointer leaves, `hoveredId` goes back to null (DeckApp's `handleLeaveStation`)
// and this falls back to whichever station is still selected, if any. `pinned` is true only when
// the card is showing *because of* the selection rather than a live hover, purely so HoverCard
// can show its pin glyph — clicking the pinned station again is what clears `selectedStationId`
// and closes it (Deck.jsx's existing click-to-toggle; this file adds no second, parallel
// "pinned" state).
export default function RightRail({ snapshot, onSelectIncident, hoveredId, selectedStationId, tempHistory }) {
  // `simTime` lets the hook notice a world reset by itself (see useEvents) — without it the
  // ticker goes permanently silent after any reset or scenario run.
  const { events } = useEvents(snapshot?.sim_time)
  const incidents = [...(snapshot?.incidents ?? [])].sort((a, b) => b.opened_sim_time - a.opened_sim_time)
  const displayId = hoveredId ?? selectedStationId ?? null
  const displayStation = displayId ? snapshot?.stations?.[displayId] : null
  const pinned = !hoveredId && !!selectedStationId

  // Newest at the bottom, and only the last VISIBLE_EVENTS of them: the ticker is atmosphere
  // and evidence, not an archive — a 200-row column running the full height of the screen was
  // very long for its own good. The full log is always
  // one `GET /events` away.
  const recent = events.slice(-VISIBLE_EVENTS)

  return (
    <aside className="absolute right-4 top-4 bottom-4 z-20 flex w-[340px] min-h-0 flex-col gap-3">
      {/* The one flexible element in this column (reworked this round — see the block comment
          above): it takes whatever vertical space the ticker and vitals sections (both
          `shrink-0`, fixed) don't need. `min-h-0` overrides the flexbox default of
          `min-height: auto`, which would otherwise refuse to let this section shrink below its
          content's natural height — without it a long incident list could force the column
          taller than the viewport instead of scrolling internally. */}
      <section className="voltaris-panel flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-edge">
        <h2 className="shrink-0 border-b border-edge/70 px-3.5 py-2.5 text-[13px] tracking-[0.18em] text-dim">
          INCIDENTS
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {incidents.length === 0 && <p className="px-3.5 py-3 text-[13px] text-dim/70">No incidents yet.</p>}
          {incidents.map((inc) => (
            <button
              key={inc.incident_id}
              onClick={() => onSelectIncident?.(inc)}
              className="flex w-full flex-col gap-0.5 border-b border-edge/40 px-3.5 py-2 text-left last:border-b-0 hover:bg-edge/30"
            >
              <div className="flex items-center justify-between text-[13px]">
                <span className="text-ink">{inc.incident_id}</span>
                <span className={STATUS_COLOR[inc.status] ?? 'text-ice'}>{inc.status}</span>
              </div>
              <div className="text-[11px] text-dim">{inc.target} · {inc.type}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Fixed height, always — never resizes for the hover card, for incident count, for
          anything. */}
      <section className="voltaris-panel shrink-0 overflow-hidden rounded-md border border-edge">
        <h2 className="border-b border-edge/70 px-3.5 py-2.5 text-[13px] tracking-[0.18em] text-dim">
          EVENT TICKER
        </h2>
        <div className="voltaris-fade-top overflow-hidden px-3.5 py-2.5 text-[11px] leading-[1.45]" style={{ height: TICKER_MAX_H }}>
          {recent.length === 0 && <p className="text-dim/70">No events yet.</p>}
          <div className="flex flex-col gap-0.5">
            {recent.map((e) => (
              <div key={e.event_id} className={`truncate ${SEVERITY_COLOR[e.severity] ?? 'text-dim'}`}>
                <span className="text-dim/60">{e.sim_time.toFixed(0)}s</span>{' '}
                <span className="text-ink/65">{e.source}</span> {e.type}
                {e.previous_state && (
                  <span className="text-dim/60"> {e.previous_state}→{e.new_state}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* VITALS: permanent, fixed height, always mounted (reserved-space round) — this is the
          fix. HoverCard.jsx itself decides whether to show its empty state or a station's
          vitals; this section's own height never changes either way, so nothing above or below
          it ever has to react to a hover. */}
      <section className="voltaris-panel shrink-0 overflow-hidden rounded-md border border-edge">
        <h2 className="border-b border-edge/70 px-3.5 py-2.5 text-[13px] tracking-[0.18em] text-dim">
          VITALS
        </h2>
        <div className="overflow-hidden" style={{ height: VITALS_H }}>
          <HoverCard
            id={displayId}
            station={displayStation}
            tempHistory={tempHistory?.get(displayId) ?? []}
            pinned={pinned}
          />
        </div>
      </section>
    </aside>
  )
}
