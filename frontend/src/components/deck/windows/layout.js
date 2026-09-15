// Scripted spawn anchors for the window layer — a plain map,
// never a computed/random point. Anchors are fractions of the Deck's own box (not the whole
// screen), so they never depend on the rails' size and never land on top of them: both rails
// float in the top corners, and every anchor here is centred, clearing both by construction.
// Widened from an original 360/620: raising body text to 13px needs more horizontal room so
// numbers and status words stop wrapping awkwardly.
export const WINDOW_WIDTH = 400
// The Agent Console is anchored lower-middle and wide. Widened once already (see
// WINDOW_WIDTH's own comment), then found to eat the screen at 680px while a run was live.
// Re-derived from content rather than picked by feel:
// the two budget meters that must sit on one row without their bars being squeezed to nothing
// (`MeterBar`: a 96px label + a 48px value + two 8px gaps = 160px of fixed chrome per meter,
// plus a usable ~80px bar — two side by side with the row's own 12px gap needs ~476px before
// window padding) is the widest recurring content, comfortably covering the longest single
// tool-call row too (e.g. "T+0912  ◈ OBSERVE   get_station_state  ST-02", ~46 monospace
// characters at 13px ≈ 360px). 520px clears both with the same ~24px window padding the 400px
// Incident window uses, while being meaningfully lighter than 680 — not verified in a browser
// (no browser available here); if the two budget meters still wrap to separate lines at this
// width, that reads as compact rather than broken, but a human should confirm it looks
// intentional rather than cramped.
export const AGENT_WINDOW_WIDTH = 520

// Declared here rather than beside RAIL_ZONE_HEIGHT below because `ANCHORS.scorecard` clamps
// against it (see its comment). Value unchanged.
const RAIL_ZONE_WIDTH = 300

export const ANCHORS = {
  // "Anchor: upper-middle of the Deck".
  incident: (boxW, boxH) => ({ x: boxW / 2 - WINDOW_WIDTH / 2, y: boxH * 0.16 }),
  // "Anchor: lower-middle, wide" — low enough to clear the Incident window above it.
  agent: (boxW, boxH) => ({ x: boxW / 2 - AGENT_WINDOW_WIDTH / 2, y: boxH * 0.52 }),
  // "Anchor: right of centre" — offset right from the Deck's own centre line, at a
  // vertical band between the Incident window (0.16) and the Agent Console (0.52) so the
  // common Incident → Agent → Scorecard trio for one run doesn't stack in a single column.
  // The offset is CLAMPED to keep the window clear of the right rail zone: at 1280x720 (the
  // rehearsal resolution) a bare `boxW / 2 + 40` puts the right edge at ~1080, inside the
  // `RAIL_ZONE_WIDTH` exclusion below — `candidateSlots` would then reject ring 0, and the
  // scripted anchor this map exists to define could never actually be used. Clamping keeps
  // ring 0 legal at any width, so a lone Scorecard lands exactly where it should.
  scorecard: (boxW, boxH) => ({
    x: Math.min(boxW / 2 + 40, boxW - RAIL_ZONE_WIDTH - WINDOW_WIDTH - 8),
    y: boxH * 0.34,
  }),
  // The replay player — opened from the Scenarios rail's
  // golden-run table, not spawned from the snapshot, so there's no "which run just went live"
  // signal to place it near; centred low in the Deck instead, clear of the Incident (0.16) and
  // Agent Console (0.52) anchors above it. Clamped the same way `scorecard` is, but on the
  // AXIS that actually needs it here: at AGENT_WINDOW_WIDTH (520px) centred, `y * 0.72` already
  // sits well below RAIL_ZONE_HEIGHT (420, declared below) at any realistic Deck height, so the
  // rect never intersects either rail zone's y-band regardless of x — the horizontal clamp is
  // therefore defensive (keeps the window from being pushed toward the right rail's x-range on
  // a narrow viewport) rather than load-bearing the way scorecard's is.
  replay: (boxW, boxH) => ({
    x: Math.min(boxW / 2 - AGENT_WINDOW_WIDTH / 2, boxW - RAIL_ZONE_WIDTH - AGENT_WINDOW_WIDTH - 8),
    y: Math.max(boxH * 0.72, RAIL_ZONE_HEIGHT + 20),
  }),
}

// Real window width per kind, for collision maths below. `replay` needs the same extra room
// `agent` does — its transport controls and reused ToolRow/VerdictStrip rows are the same
// content that justified AGENT_WINDOW_WIDTH in the first place.
export function widthFor(kind) {
  return kind === 'agent' || kind === 'replay' ? AGENT_WINDOW_WIDTH : WINDOW_WIDTH
}

// The real rendered height isn't known at spawn time (content streams in after), so this is a
// per-kind *estimate* used only to keep new windows from landing on top of existing ones — not
// a layout constraint enforced anywhere else. Sized off the real content: an ~8-line incident
// card, and budgets plus a handful of tool-call rows before the console scrolls.
// `agent` lowered to match AgentConsoleWindow.jsx's own tool-log
// scroll cap shrinking from `max-h-72` (288px) to `max-h-64` (256px) plus its tighter row
// padding/gaps — same ~52px of fixed chrome (titlebar + window padding + budgets + divider +
// occasional guardrail band) the original 340 estimate implied against its 288px cap
// (340 - 288 = 52), carried forward against the new 256px cap: 256 + 52 = 308, rounded to 310.
// `scorecard` derived from ScorecardWindow.jsx's actual content, same method as the other two:
// an optional scenario-id row (~18px) + an outcome row (~18px) + an optional escalation-reason
// line (~14px) + a divider (~9px) + up to four score rows at 13px each (~72px) + a second
// divider (~9px) + a two-line counts block (~32px), all inside the window's own 24px (p-3 top +
// bottom) padding, plus the outer flex's `gap-2` between the six top-level blocks (~5 * 8px =
// 40px). 18+18+14+9+72+9+32 = 172, +24 padding +40 gaps = 236, rounded up for the no-scenario
// fallback's shorter but still occasionally two-line dim message. Not verified in a browser.
//
// `replay` derived from ReplayWindow.jsx's actual content, same method: the REPLAY badge row
// (~20px) + a two-line header (run_id/scenario, outcome/recorded_at, ~36px) + a divider (~9px)
// + the play/restart/speed button row (~24px) + the scrub input (~16px) + the position readout
// row (~16px) + a second divider (~9px) + the ALL/TOOL CALLS filter row (~20px) + the log's own
// `max-h-64` scroll cap (256px, same bound as `agent`'s). 20+36+9+24+16+16+9+20+256 = 406,
// inside the window's own 24px (p-3 top+bottom) padding plus the outer flex's `gap-1.5` across
// nine top-level blocks (8 gaps * ~6px = 48px): 406+24+48 = 478, rounded to 480. Not verified in
// a browser.
export const WINDOW_HEIGHT_ESTIMATE = { incident: 230, agent: 310, scorecard: 260, replay: 480 }

// Both rails float in the top corners and must never be covered by a spawned window.
// Widths are generous overestimates of the rails' own widths (LeftRail/RightRail) plus their
// `left-4`/`right-4`/`top-4` insets; height is a generous overestimate of how tall either rail's
// accordion content can get. A candidate slot that intersects either zone is rejected below.
const RAIL_ZONE_HEIGHT = 420

function railZones(boxW) {
  return [
    { x: 0, y: 0, w: RAIL_ZONE_WIDTH, h: RAIL_ZONE_HEIGHT }, // left rail
    { x: boxW - RAIL_ZONE_WIDTH, y: 0, w: RAIL_ZONE_WIDTH, h: RAIL_ZONE_HEIGHT }, // right rail
  ]
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

// Ordered candidate slots for a newly-spawning window of `kind`, within the Deck box
// The first candidate is always that kind's scripted anchor, so the common single-incident /
// single-run demo case looks exactly as it always has. Further candidates step outward in a
// small grid around that anchor — same row first (left/right), then rows below/above it — so
// a second window of the same kind, or one that would otherwise land on a dragged window, finds
// the nearest clear spot rather than jumping somewhere arbitrary. Callers filter out anything
// that collides with an existing window or a rail zone, and fall back to the old +24/+24
// cascade only if every candidate here is taken (see WindowLayer.jsx's `anchorFor`).
export function candidateSlots(kind, boxW, boxH) {
  const width = widthFor(kind)
  const height = WINDOW_HEIGHT_ESTIMATE[kind] ?? 240
  const primary = ANCHORS[kind](boxW, boxH)
  const stepX = width + 32
  const stepY = height + 24
  const zones = railZones(boxW)

  const candidates = []
  const seen = new Set()
  const push = (x, y) => {
    x = Math.round(x)
    y = Math.round(y)
    if (x < 8 || y < 8 || x + width > boxW - 8 || y + height > boxH - 8) return
    const rect = { x, y, w: width, h: height }
    if (zones.some((z) => rectsIntersect(rect, z))) return
    const key = `${x},${y}`
    if (seen.has(key)) return
    seen.add(key)
    candidates.push({ x, y })
  }

  // Ring 0: the scripted anchor itself. Rings 1-3: offsets in both axes, nearest first.
  for (let ring = 0; ring <= 3; ring++) {
    for (let row = -ring; row <= ring; row++) {
      for (let col = -ring; col <= ring; col++) {
        // Only the new ring's outer shell — inner cells were already emitted by a smaller ring.
        if (Math.max(Math.abs(row), Math.abs(col)) !== ring) continue
        push(primary.x + col * stepX, primary.y + row * stepY)
      }
    }
  }
  return candidates
}
