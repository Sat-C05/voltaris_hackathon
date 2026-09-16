// P12 — what the deck shows before the first `/world` snapshot arrives.
//
// It replaced a single line of grey text, `WAITING FOR WORLD SNAPSHOT…`, which was honest and
// looked like a page that had failed to load. On a projector, in the seconds before the first
// poll answers, that is the first thing judges see.
//
// **This is a FALLBACK, not a splash.** It delays nothing: `Deck.jsx` renders it only on the
// `!snapshot` branch and drops it the instant a snapshot exists, mid-animation if that is when
// the poll lands. There is no timer here, no state, and nothing to wait for — the stagger is
// pure CSS `animation-delay`, so this component cannot hold the real deck back even if someone
// later wires it up wrongly. If `/world` answers in 80ms, that is how long this is on screen.
//
// Two invariants shape the wording:
//  - **Invariant 3** — `snapshot.sim_time` is the only clock on screen. So: no elapsed counter,
//    no "connecting for 3s", no progress percentage. There is no clock to read yet, so nothing
//    here is allowed to imply one.
//  - **Invariant 2** — the frontend decides nothing. Every line below reports something this
//    bundle genuinely knows about ITSELF: the projection module, the palette, the grid are all
//    loaded, because this component is executing. The one line about the backend says only that
//    the frontend is waiting, which is the single fact available. Nothing here claims the world
//    is healthy, or that the agent is up, or anything else it cannot see.
//
// Reuses `.voltaris-reveal` (P7's one-shot arrival, ~120ms) rather than adding a keyframe, so it
// is already covered by the `prefers-reduced-motion` block in index.css — under reduced motion
// the rows simply appear, which is the correct behaviour for a readout that carries information.
const ROWS = [
  { label: 'PROJECTION', value: 'READY' },
  { label: 'PALETTE', value: 'READY' },
  { label: 'FLOOR GRID', value: 'READY' },
  { label: 'STATION LAYER', value: 'READY' },
]

const STAGGER_MS = 110

export default function BootSequence() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="w-[300px]">
        <div
          className="voltaris-reveal border-b border-edge/70 pb-2 text-[13px] tracking-[0.22em] text-dim"
          style={{ animationDelay: '0ms' }}
        >
          VOLTARIS NOC
        </div>
        <ul className="pt-2">
          {ROWS.map((row, i) => (
            <li
              key={row.label}
              className="voltaris-reveal flex items-baseline justify-between gap-2 py-0.5 text-[13px]"
              style={{ animationDelay: `${(i + 1) * STAGGER_MS}ms` }}
            >
              <span className="text-dim">{row.label}</span>
              {/* The dotted leader is a border, not a run of '.' characters: a string of dots
                  reflows at a different width for every label and has to be hand-tuned per row,
                  which is exactly the kind of thing that looks fine here and ragged on a
                  borrowed laptop with a slightly different font fallback. */}
              <span className="min-w-[24px] flex-1 translate-y-[-3px] border-b border-dotted border-edge" />
              <span className="text-mint">{row.value}</span>
            </li>
          ))}
          <li
            className="voltaris-reveal flex items-baseline justify-between gap-2 py-0.5 text-[13px]"
            style={{ animationDelay: `${(ROWS.length + 1) * STAGGER_MS}ms` }}
          >
            <span className="text-dim">WORLD SNAPSHOT</span>
            <span className="min-w-[24px] flex-1 translate-y-[-3px] border-b border-dotted border-edge" />
            {/* `.voltaris-pulse` is the deck's existing slow breath, not a new animation — and it
                is the ONE looping thing on this screen, which is allowed precisely because
                nothing else is on it (Invariant 8 is a budget for the whole frame). It stops
                existing the moment the snapshot lands. */}
            <span className="voltaris-pulse text-amber">AWAITING</span>
          </li>
        </ul>
        <p className="pt-3 text-[13px] leading-snug text-dim/70">
          Polling <span className="text-ink/70">/world</span>. The deck renders as soon as the
          first snapshot arrives.
        </p>
      </div>
    </div>
  )
}
