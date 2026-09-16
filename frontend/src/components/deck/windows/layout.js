// P14: rail geometry (width, zone heights, and the left rail's idle/shifted vertical anchor) now
// lives in ONE place, `rails/railGeometry.js`, imported by both this file (to exclude the area
// from the tiler) and `LeftRail.jsx` (to position itself) — see that module's own header comment
// for why a hand-copied number here was exactly the bug this replaces.
import { RAIL_ZONE_WIDTH, LEFT_RAIL_ZONE_HEIGHT, railZones } from '../../rails/railGeometry'

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
  // `RAIL_ZONE_WIDTH` exclusion below — `tileWindows` would then have to search away from this
  // anchor even for a lone Scorecard, and the scripted anchor this map exists to define could
  // never actually be used as-is. Clamping keeps the anchor itself legal at any width, so a
  // lone Scorecard lands exactly where it should.
  scorecard: (boxW, boxH) => ({
    x: Math.min(boxW / 2 + 40, boxW - RAIL_ZONE_WIDTH - WINDOW_WIDTH - 8),
    y: boxH * 0.34,
  }),
  // The replay player — opened from the Scenarios rail's
  // golden-run table, not spawned from the snapshot, so there's no "which run just went live"
  // signal to place it near; centred low in the Deck instead, clear of the Incident (0.16) and
  // Agent Console (0.52) anchors above it. Clamped the same way `scorecard` is: at
  // AGENT_WINDOW_WIDTH (520px) centred, `boxW/2 - 260` already exceeds RAIL_ZONE_WIDTH (300) at
  // any realistic Deck width, so this anchor clears BOTH rail zones' x-range (0..300 and
  // boxW-300..boxW) by construction — which is what actually matters here, since P14 made the
  // left rail zone's y-band conditional on `hasIncident` (see `rails/railGeometry.js`) while its
  // x-range (0..RAIL_ZONE_WIDTH) never changes. The horizontal clamp below is therefore
  // defensive (keeps the window from being pushed toward the right rail's x-range on a narrow
  // viewport), not load-bearing the way `scorecard`'s is; `LEFT_RAIL_ZONE_HEIGHT + 20` as the y
  // floor is likewise just a sane minimum offset into the deck for a very short box, not a claim
  // about either zone's y-band.
  replay: (boxW, boxH) => ({
    x: Math.min(boxW / 2 - AGENT_WINDOW_WIDTH / 2, boxW - RAIL_ZONE_WIDTH - AGENT_WINDOW_WIDTH - 8),
    y: Math.max(boxH * 0.72, LEFT_RAIL_ZONE_HEIGHT + 20),
  }),
}

// Real window width per kind, for collision maths below. `replay` needs the same extra room
// `agent` does — its transport controls and reused ToolRow/VerdictStrip rows are the same
// content that justified AGENT_WINDOW_WIDTH in the first place.
export function widthFor(kind) {
  return kind === 'agent' || kind === 'replay' ? AGENT_WINDOW_WIDTH : WINDOW_WIDTH
}

// Fallback height, used only for the one frame before a window's real rendered height has been
// measured (WindowLayer's ResizeObserver reports it within a paint of mount) and as the height
// for a kind that somehow never gets measured (e.g. no ResizeObserver in an old environment).
// No longer load-bearing for collision avoidance — `tileWindows` below uses each window's
// *measured* height once available; these are simply reasonable per-kind starting guesses so a
// window doesn't spawn at height 0 for that one frame.
export const WINDOW_HEIGHT_ESTIMATE = { incident: 230, agent: 310, scorecard: 260, replay: 480 }

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function overlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return ox * oy
}

const MARGIN = 8

// Fixed placement order — kind first, then id. NEVER spawn order or object-insertion order:
// that is what keeps the arrangement stable frame to frame instead of jumping around as windows
// come and go (P13's core stability requirement).
const KIND_PRIORITY = { incident: 0, agent: 1, scorecard: 2, replay: 3 }

function compareItems(a, b) {
  const ra = KIND_PRIORITY[a.kind] ?? 99
  const rb = KIND_PRIORITY[b.kind] ?? 99
  if (ra !== rb) return ra - rb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// A kind with no scripted anchor (shouldn't happen for the four real kinds, but keeps this
// total rather than throwing) falls back to the box's own centre.
function anchorFor(kind, width, height, boxW, boxH) {
  const fn = ANCHORS[kind]
  if (fn) return fn(boxW, boxH)
  return { x: boxW / 2 - width / 2, y: boxH / 2 - height / 2 }
}

// Raster step for the two search functions below. Fine enough that, when nothing is in the
// way, the winning slot lands within a few pixels of the kind's scripted anchor — indistinguish-
// able from it, which is what keeps a lone window looking deliberately placed rather than
// packed by a generic bin-packer. Coarse enough that scanning an entire 2560x900 box for up to
// a handful of windows is instant.
const SCAN_STEP = 8

// Exhaustively search every legal position in the box (inside the margin, clear of both rail
// zones) for the one nearest `anchor` that overlaps none of `obstacles`. Exhaustive rather than
// a local search outward from the anchor, so it finds a free slot anywhere in the box if one
// exists at all — that is what makes the no-overlap guarantee real rather than "works for the
// box sizes we happened to try". Returns null if the box has no legal position for this size at
// all (e.g. the window itself is wider than the box).
function findFreeSlot(anchor, width, height, boxW, boxH, zones, obstacles) {
  const maxX = boxW - MARGIN - width
  const maxY = boxH - MARGIN - height
  if (maxX < MARGIN || maxY < MARGIN) return null
  let best = null
  let bestDist = Infinity
  for (let y = MARGIN; y <= maxY; y += SCAN_STEP) {
    for (let x = MARGIN; x <= maxX; x += SCAN_STEP) {
      const rect = { x, y, w: width, h: height }
      if (zones.some((z) => rectsIntersect(rect, z))) continue
      if (obstacles.some((o) => rectsIntersect(rect, o))) continue
      const dx = x - anchor.x
      const dy = y - anchor.y
      const dist = dx * dx + dy * dy
      if (dist < bestDist) { bestDist = dist; best = rect }
    }
  }
  return best
}

// Degrade path for when no zero-overlap slot exists anywhere (the box is genuinely too small
// for everything that wants to be on screen at once). Still hard-excludes the rail zones and
// the box margin — those never give way — but accepts the position with the *least* total
// overlap against other windows, nearest the anchor as a tiebreak. This is what turns a
// crowded run into "some windows overlap a little" instead of "a window is pushed off-screen or
// dropped", which is unrecoverable for the user.
function findLeastOverlapSlot(anchor, width, height, boxW, boxH, zones, obstacles) {
  const maxX = Math.max(MARGIN, boxW - MARGIN - width)
  const maxY = Math.max(MARGIN, boxH - MARGIN - height)
  let best = null
  let bestScore = Infinity
  for (let y = MARGIN; y <= maxY; y += SCAN_STEP) {
    for (let x = MARGIN; x <= maxX; x += SCAN_STEP) {
      const rect = { x, y, w: width, h: height }
      if (zones.some((z) => rectsIntersect(rect, z))) continue
      const overlap = obstacles.reduce((sum, o) => sum + overlapArea(rect, o), 0)
      const dx = x - anchor.x
      const dy = y - anchor.y
      // Overlap area dominates the score; distance to the anchor only breaks ties between
      // equally-overlapping spots, so the search always prefers less overlap first.
      const score = overlap * 1e7 + dx * dx + dy * dy
      if (score < bestScore) { bestScore = score; best = rect }
    }
  }
  return best
}

// tileWindows(items, boxW, boxH, hasIncident) -> { [id]: { x, y } }
//
// `items`: [{ id, kind, width, height, pinned, x, y }, ...]. `width`/`height` are that window's
// real dimensions — measured, or `WINDOW_HEIGHT_ESTIMATE`/`widthFor` as a pre-measurement
// fallback. `x`/`y` matter only when `pinned` is true, where they are the fixed position it
// already occupies on screen. `hasIncident` (default `false`) is forwarded straight to
// `railZones()` (`rails/railGeometry.js`) — it is the ONLY thing that moves the left rail's
// exclusion zone; everything else about this function is unchanged by it.
//
// Pure and side-effect-free by construction — arithmetic over the arguments only, no DOM, no
// ref, no `Date.now()` — which is what makes it unit-testable without a browser (see
// `frontend_fiels/` P13 test notes).
//
// Algorithm: pinned items are registered as fixed obstacles and never moved. Unpinned items are
// sorted into a fixed order (kind priority, then id — never spawn order, so the arrangement
// never reshuffles just because windows opened in a different sequence) and placed one at a
// time, each becoming an obstacle for the next: each is put at the legal position (inside the
// box margin, clear of both rail zones) nearest its kind's scripted anchor that does not
// overlap any already-placed obstacle, falling back to the least-overlapping legal position if
// no overlap-free one exists anywhere in the box. A single unpinned window with no other
// obstacles always lands on its scripted anchor, which is what keeps it looking intentional
// rather than packed.
export function tileWindows(items, boxW, boxH, hasIncident = false) {
  const zones = railZones(boxW, boxH, hasIncident)
  const result = {}
  const obstacles = []

  // Pinned items first, in any order (their own result never depends on each other or on the
  // unpinned items below) — they are obstacles the unpinned pass below must route around.
  for (const item of items) {
    if (!item.pinned) continue
    const w = item.width ?? widthFor(item.kind)
    const h = item.height ?? WINDOW_HEIGHT_ESTIMATE[item.kind] ?? 240
    const rect = { x: item.x ?? 0, y: item.y ?? 0, w, h }
    obstacles.push(rect)
    result[item.id] = { x: rect.x, y: rect.y }
  }

  const unpinned = items.filter((item) => !item.pinned).slice().sort(compareItems)

  for (const item of unpinned) {
    const width = item.width ?? widthFor(item.kind)
    const height = item.height ?? WINDOW_HEIGHT_ESTIMATE[item.kind] ?? 240
    const anchor = anchorFor(item.kind, width, height, boxW, boxH)
    const slot = findFreeSlot(anchor, width, height, boxW, boxH, zones, obstacles)
      ?? findLeastOverlapSlot(anchor, width, height, boxW, boxH, zones, obstacles)
      // Truly degenerate case (a window wider or taller than the box itself) — clamp into the
      // box as a last resort rather than returning nothing. Invariant 10: never lose a window.
      ?? {
        x: Math.min(Math.max(anchor.x, MARGIN), Math.max(MARGIN, boxW - MARGIN - width)),
        y: Math.min(Math.max(anchor.y, MARGIN), Math.max(MARGIN, boxH - MARGIN - height)),
      }
    obstacles.push({ x: slot.x, y: slot.y, w: width, h: height })
    result[item.id] = { x: slot.x, y: slot.y }
  }

  return result
}
