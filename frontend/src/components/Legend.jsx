import { UPLIGHT, UPLIGHT_LEGEND } from './deck/uplight'

// P9 — the key to the deck's colour vocabulary. A judge has about ninety seconds and no
// narrator; a pillar turning from green to amber-grey is meaningless to them unless something
// on screen says what amber-grey means. This is that something, and it is the cheapest possible
// win: no new data, no new motion, no new poll.
//
// **Generated from `deck/uplight.js`, never hand-typed.** `UPLIGHT` is the colour table
// `StationPillar` actually paints with and `UPLIGHT_LEGEND` is its wording, both in that one
// file. A key that disagrees with the thing it is keying is worse than no key, and a second
// hand-written copy disagrees the first time anyone touches either one. If you find yourself
// adding a row here, you are in the wrong file.
//
// Everything here is static: no props, no snapshot, no state. It is the one element on the deck
// that is deliberately not live.
export default function Legend() {
  return (
    <div className="border-t border-edge/70 px-2.5 py-2">
      <h3 className="pb-1.5 text-[13px] tracking-[0.18em] text-dim">STATION KEY</h3>
      <ul className="flex flex-col gap-0.5">
        {UPLIGHT_LEGEND.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            {/* The swatch is the pillar's own status mark in miniature: a filled floor ellipse
                with its outline, which is exactly what `StationPillar` draws at a station's
                base — not a square chip. The eye matches shape faster than it matches hue, so a
                key drawn in a different shape from the thing it keys makes the reader do the
                translation themselves. */}
            <svg width="18" height="12" viewBox="-9 -6 18 12" className="shrink-0">
              <ellipse cx="0" cy="0" rx="7.5" ry="4" fill={UPLIGHT[row.key]} opacity="0.55" />
              <ellipse cx="0" cy="0" rx="7.5" ry="4" fill="none" stroke={UPLIGHT[row.key]} strokeWidth="1.2" />
            </svg>
            {/* 13px is the floor for UI text (Invariant 9). The `note` on each row of
                `UPLIGHT_LEGEND` is deliberately NOT rendered: at 13px in a 260px rail every one
                of them wrapped to two or three lines, which took the legend to ~190px and pushed
                the whole centred rail off the bottom of a 900px deck — measured, not guessed.
                The label IS the meaning; the note stays in `uplight.js` as documentation for
                whoever edits the table next. Shrinking the text to fit was the other option and
                is not one, per Invariant 9. */}
            <span className="text-[13px] text-ink">{row.label}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
