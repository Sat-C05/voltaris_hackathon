import { memo } from 'react'
import { TEMP_PROTECTION, AMBIENT_TEMP_C, COMPONENTS } from '../../contracts'
import { UPLIGHT } from './uplight'
import { PALETTE } from '../../palette'
import { project } from './projection'

const HEALTH_COLOR = { HEALTHY: PALETTE.mint, DEGRADED: PALETTE.amber, FAILED: PALETTE.rose }

// P11: atmospheric depth. `layout.scale` already IS `depthScale(layout.z)` (see layout.js's
// own comment on `rowIds.forEach` and projection.js's `depthScale()` doc) — so every effect
// below reads `scale` (already in `signature()`, no new field needed) rather than re-deriving
// depthScale(z) a second time from `z`.
//
// `depthFraction` maps that scale to a continuous 0..1 depth fraction — 0 at a fixed reference
// "near" scale (0.95: a little closer than any real front-row station, today depthScale(420)
// ~= 0.78), rising smoothly with no step as scale shrinks (Invariant 2: depth is geometry, not
// a threshold). It is shared by the haze wash and the contact shadow below so both effects
// track the same notion of "how far back is this pillar."
const HAZE_NEAR_SCALE = 0.8
function depthFraction(scale) {
  return Math.max(0, Math.min(1, 1 - scale / HAZE_NEAR_SCALE))
}

// Haze cap: even a pillar all the way back never crosses this opacity of void wash over its
// plain structural material — see the P11 brief's "do not bury a fault" trap. This wash is
// applied ONLY to the plinth/cabinet/head's neutral fills (never the status ellipse, the
// cabinet's status tint/outline pass, or the FAULT screen text), so a faulted back-row station
// stays at full status contrast regardless of how far back it sits — the cap only ever governs
// how much the plain material fades, never the status colour, so it is safe to set high enough
// to be actually visible (today's rows: ~2% at the front, ~23% at the back).
const HAZE_MAX = 0.55

// Contact shadow: softens (opacity drops, never below SHADOW_OPACITY_FLOOR of its near-field
// value) and lengthens (widens by up to SHADOW_RX_GROW) continuously with the same depth
// fraction, instead of a fixed ellipse at every depth.
const SHADOW_RX_GROW = 0.4
const SHADOW_OPACITY_FLOOR = 0.45

// P0b: the pillar's own solid body as real world-space boxes, projected per-vertex — this is
// the part of the pillar that has actual depth (P0 left it a flat billboard). Everything else
// in this file (cable, screen, uplink arc, rings, status ellipse, contact shadow, chevrons) is
// still a flat shape at a single z and keeps the exact translate+scale shortcut P0 established
// (see projection.js's `depthScale()` comment for why that is an exact closed form, not an
// approximation, for a flat camera-facing object at one z).
//
// Local coordinates below are WORLD units: `lx` left/right, `ly` UP from the floor (world y,
// unlike the flat shapes elsewhere in this file which use SVG's y-down convention), `lz` a
// further depth offset from the pillar's own z (which is already snapped to a grid
// intersection by layout.js — lz = 0 is that same front plane, so the pillar's base still
// lands exactly on the grid).
//
// PLINTH_H + CABINET_H + HEAD_H = 160, matching `h` below and the `PILLAR_H = 160`
// WindowLayer.jsx (not owned by this package) hardcodes to find "the top of the pillar" from
// layout.y/.scale — keeping this total unchanged is what keeps that leader-line anchor correct
// without touching that file.
const PLINTH_HALF_W = 48 // slightly wider than the cabinet, per the original design
const PLINTH_H = 20
const PLINTH_DEPTH = 46 // a wide, shallow base slab

const CABINET_HALF_W = 45 // = w/2 below, unchanged silhouette width
const CABINET_H = 116
const CABINET_DEPTH = 40 // roughly half the 90-wide footprint, per the brief

const HEAD_HALF_W_BOTTOM = 29
const HEAD_HALF_W_TOP = 20 // narrower at the top — a real tapered cap, not a painted diagonal
const HEAD_H = 24
const HEAD_DEPTH = 28

// One projected vertex of a pillar box, relative to the station's own world base (worldX, 0, z)
// — the same point layout.js already snapped onto a grid intersection.
function pt(worldX, z, lx, ly, lz) {
  return project(worldX + lx, ly, z + lz)
}

// P1: the pillar's own head-top anchor, projected once here so a second file (UplinkBeams.jsx)
// can start a beam at exactly the same point this pillar's own uplink arc is anchored to
// (`headTopFlat` below) without re-deriving PLINTH_H + CABINET_H + HEAD_H or duplicating the
// height constants into a second file — one source, per the P1 brief. `layout` is the same
// per-station object `layout.js`/`Deck.jsx` already pass this component
// (`{ x, y, scale, z, worldX }`); this reads only `worldX`/`z` from it, the same two fields the
// head-top projection below uses.
export function uplinkAnchor(layout) {
  return project(layout.worldX, PLINTH_H + CABINET_H + HEAD_H, layout.z)
}

// A tapered box (a plain box when hwTop === hwBottom): bottom half-width `hwBottom`, top
// half-width `hwTop`, from world y `y0` to `y1`, extruded `depth` world units back from the
// pillar's own front plane (lz = 0). Returns the three faces a camera above the floor can ever
// see — front, left, right (the caller picks whichever side is actually visible), top — each as
// an array of projected [sx, sy] points. The back face and underside are never returned: they
// never face the camera, by construction, not by a hidden-face test.
function tapBox(worldX, z, hwBottom, hwTop, y0, y1, depth) {
  const bl = pt(worldX, z, -hwBottom, y0, 0), br = pt(worldX, z, hwBottom, y0, 0)
  const tl = pt(worldX, z, -hwTop, y1, 0), tr = pt(worldX, z, hwTop, y1, 0)
  const blB = pt(worldX, z, -hwBottom, y0, depth), brB = pt(worldX, z, hwBottom, y0, depth)
  const tlB = pt(worldX, z, -hwTop, y1, depth), trB = pt(worldX, z, hwTop, y1, depth)
  return {
    front: [bl, br, tr, tl],
    left: [bl, tl, tlB, blB],
    right: [br, tr, trB, brB],
    top: [tl, tr, trB, tlB],
  }
}

function pathD(pts) {
  return pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'} ${px.toFixed(2)} ${py.toFixed(2)}`).join(' ') + ' Z'
}

// State -> appearance. EXPORTED since P8: `StatePings.jsx` tints a state-change ring with the
// tone of the state the station is arriving at, and must use this exact function rather than a
// copy — a ring in a different colour from the pillar it is drawn around reads as a bug to
// someone who knows neither colour's meaning. Export only; no behaviour here changed.
// Every branch below reads
// only `station` (a slice of snapshot.stations[id]) — never a derived "is this okay" boolean
// computed elsewhere. The frontend does not decide outcomes; it just maps snapshot
// fields to colour.
export function classify(station) {
  const isolated = station.status === 'UNAVAILABLE'
  const faulted = station.status === 'FAULTED' ||
    Object.values(station.connectors).some((c) => c.status === 'FAULTED')
  const charging = Object.values(station.connectors).some((c) =>
    ['PREPARING', 'CHARGING', 'FINISHING'].includes(c.status))
  const failedComponents = COMPONENTS.filter((c) => station.components[c]?.health === 'FAILED')
  const degradedComponents = COMPONENTS.filter((c) => station.components[c]?.health === 'DEGRADED')
  const linkDown = station.communication_state !== 'CONNECTED'

  let halo = 'mint'
  if (isolated) halo = 'isolated'
  else if (faulted) halo = 'rose'
  else if (failedComponents.length > 0) halo = 'rose'
  else if (degradedComponents.length > 0 || linkDown) halo = 'amber-desat'
  else if (charging) halo = 'amber'

  return { isolated, faulted, charging, failedComponents, degradedComponents, linkDown, halo }
}


function tempOpacity(tempC) {
  const t = (tempC - AMBIENT_TEMP_C) / (TEMP_PROTECTION - AMBIENT_TEMP_C)
  return Math.max(0, Math.min(0.9, t * 0.9))
}

// P2: travelling dashes along the charging cable, same `.voltaris-packet-flow` technique P1
// used for uplink packets (an animated `stroke-dashoffset`, nothing else — see index.css). The
// dash/gap period is fixed; `--cable-shift` below is always an exact multiple of it so the loop
// never visibly jumps (UplinkBeams.jsx's own comment on `shift` explains why). Only
// `animation-duration` varies per station, continuously from `telemetry.power_kw` — more power,
// faster flow (Invariant 2: render the field, never a threshold).
const CABLE_DASH = 3
const CABLE_GAP = 5
const CABLE_SHIFT = -(CABLE_DASH + CABLE_GAP) * 10 // px — 10x the period, direction-only, not path length
// Normalises against the backend's own rated ceiling (`RATED_POWER_KW = 50.0`,
// backend/world/simulator.py) rather than an invented cap — telemetry can still report above it
// (the P1/P2 fixture's ST-02 does, at 62kW), so this clamps to 1.0 instead of letting an
// out-of-range reading spin the animation faster than designed (Invariant 2's "clamp so a huge
// value can't strobe"). Same inline-constant pattern UplinkBeams.jsx already uses for
// `comm_latency_ms` normalisation — not in contracts.js because it is a visual scale, not a
// decision threshold.
const RATED_POWER_KW = 50
function cableFlowDurationS(powerKw) {
  const t = Math.max(0, Math.min(1, powerKw / RATED_POWER_KW))
  // 4.2s (near-idle draw, e.g. PREPARING/FINISHING at ~0kW) down to 2.0s (at/above rated power)
  // — deliberately in the same quiet register as P1's packets (1.5s-4.5s), never faster than a
  // genuine fault's 2.6s pulse by much, so the two ambient motions never together read louder
  // than a real fault (Invariant 8 — bias quieter than feels right).
  return 4.2 - t * 2.2
}

function StationPillarInner({ id, station, layout, selected, dimmed, faultPending, onHover, onLeave, onClick }) {
  // `layout.js` computes these through the shared pinhole `project()`/`depthScale()` (see
  // `./projection`) — `x, y` is the station's world-space base (world y = 0) already projected
  // to screen space, and `scale` IS `depthScale(layout.z)`, not a hand-picked per-row fudge.
  // `z`/`worldX` (world-space, not projected) are what the pillar's own box geometry below
  // projects per-vertex, and what decides which side face is visible.
  const { x, y, scale, z, worldX } = layout
  const cls = classify(station)
  const w = 90, h = 160
  // P11: see depthFraction()/HAZE_*/SHADOW_* above — the pillar's own continuous "how far back
  // is it" value, derived from `scale` alone (no new signature field).
  const depthT = depthFraction(scale)
  const haze = HAZE_MAX * depthT
  // P2: the three stop conditions from the brief, all already computed by `classify()` above —
  // no second copy of "is a session live" here. `cls.charging` alone is not enough: a station
  // can only ever be reclassified isolated/faulted OR charging in the halo above, but the brief
  // is explicit that isolation and a fault must kill the flow even if a connector's own status
  // string still happens to say otherwise.
  const showCableFlow = cls.charging && !cls.isolated && !cls.faulted
  const heatOpacity = tempOpacity(station.telemetry.temperature_c)
  const hold = station.maintenance_hold

  // Face visibility, computed from the station's position relative to the vanishing point
  // (worldX = 0), not hardcoded: a station right of centre (worldX > 0) is off to the camera's
  // right, so the camera sees around to its LEFT face; one left of centre sees the RIGHT face.
  // A dead-centre station (worldX === 0) has no visible side face at all (it's edge-on to the
  // camera) — either choice below is equally correct there since that face projects to zero
  // width.
  const showLeftFace = worldX >= 0
  const sideOf = (box) => (showLeftFace ? box.left : box.right)

  // The three stacked solids, each a real world-space box projected through `project()` at the
  // station's own (worldX, z) — see the constants and `tapBox()` above.
  const plinth = tapBox(worldX, z, PLINTH_HALF_W, PLINTH_HALF_W, 0, PLINTH_H, PLINTH_DEPTH)
  const cabinetY0 = PLINTH_H, cabinetY1 = PLINTH_H + CABINET_H
  const cabinet = tapBox(worldX, z, CABINET_HALF_W, CABINET_HALF_W, cabinetY0, cabinetY1, CABINET_DEPTH)
  const headY0 = cabinetY1, headY1 = cabinetY1 + HEAD_H
  const head = tapBox(worldX, z, HEAD_HALF_W_BOTTOM, HEAD_HALF_W_TOP, headY0, headY1, HEAD_DEPTH)

  // P0c: two extra decoration anchors, each a real projected world point (not a hand-picked
  // local offset from the floor) — the cabinet's own top face (where the head sits) and the
  // head's own top face. Both project through the exact same `project()`/`depthScale()` this
  // box body uses, at the pillar's own z, so a decoration anchored here can never drift from
  // the geometry it belongs to even if PLINTH_H/CABINET_H/HEAD_H change later. `x, y, scale`
  // (the floor anchor, world y = 0) already come from `layout` this same way — see
  // `computeStationLayout` in layout.js.
  const [cabinetTopX, cabinetTopY] = project(worldX, cabinetY1, z)
  // Same anchor as `uplinkAnchor(layout)` above (headY1 === PLINTH_H + CABINET_H + HEAD_H) —
  // computed inline here rather than via a `layout` round-trip since this scope already has
  // `worldX`/`z`/`headY1` unpacked; UplinkBeams.jsx (which only has `layout`, not these locals)
  // is the one that calls the exported helper.
  const [headTopX, headTopY] = project(worldX, headY1, z)
  const cabinetTopFlat = `translate(${cabinetTopX}, ${cabinetTopY}) scale(${scale})`
  const headTopFlat = `translate(${headTopX}, ${headTopY}) scale(${scale})`

  // Shading: same three-tone material as before this pass (deck/panelLight/panelLighter, and
  // the hold* set while on maintenance hold) — only which GEOMETRY each tone lands on is new.
  // A left face and a right face are never both drawn (sideOf above always picks exactly one),
  // so the "flip" is the geometry flipping under a fixed tone, not the tone itself changing.
  const plinthFrontFill = hold ? PALETTE.holdPanelDark : PALETTE.panelLight
  const plinthSideTopFill = hold ? PALETTE.holdPanelDarker : PALETTE.panelLighter
  const cabinetFrontFill = hold ? PALETTE.holdPanel : PALETTE.deck
  const cabinetSideFill = hold ? PALETTE.holdPanelDark : PALETTE.panelLight
  // The ONLY condition that earns a pulse. Everything else breathes almost imperceptibly —
  // if three things pulse at once, nothing reads as wrong.
  const alert = cls.faulted || cls.failedComponents.length > 0
  // Line 2 of the in-scene screen. Was falling back to `id` here, so an idle station printed
  // its id twice (`ST-03 / ST-03`, line 1 is always the id). Real snapshot fields only: FAULT
  // when faulted, power draw while charging (as before), otherwise the station's own
  // temperature — never an invented status word.
  const screenText = cls.faulted ? 'FAULT' : (
    Object.values(station.connectors).find((c) => c.status === 'CHARGING')
      ? `${station.telemetry.power_kw.toFixed(0)} kW`
      : `${station.telemetry.temperature_c.toFixed(0)}°C`
  )

  const ringComponents = COMPONENTS.map((name, i) => ({
    name,
    health: station.components[name]?.health ?? 'HEALTHY',
    angle: (i / COMPONENTS.length) * 2 * Math.PI,
  }))

  // The flat local-coordinate shapes below (reticle, contact shadow, status ellipse, screen,
  // cable, chevrons, isolated ring, component ring, selection rect) all still use this single
  // translate+scale, anchored at the station's own floor point (world y = 0) — the exact closed
  // form of projecting every one of their local (lx, ly) vertices individually through
  // `project(worldX + lx, -ly, z)` for a fixed z (see `depthScale()`'s own comment in
  // projection.js). The heat column and uplink arc use the same closed form but anchored higher
  // up the pillar (`cabinetTopFlat`/`headTopFlat` above), so they stay attached to the cabinet
  // and head respectively rather than being offset by a hand-picked distance from the floor.
  // Only the pillar's own solid body (plinth/cabinet/head) below breaks out of it, because it
  // is the one part of this pillar with real depth (lz != 0 at some of its corners) — a uniform
  // scale is not a valid projection for that.
  const flat = `translate(${x}, ${y}) scale(${scale})`

  // P0c: the box body's own paths carry ink/status strokes as ABSOLUTE screen widths (their
  // vertices are already individually projected, unlike the `flat`-wrapped decorations above,
  // which get their stroke widths divided down by `scale` for free as part of that group's own
  // transform). Without this, a strokeWidth like "2" stays a full 2 screen px at every depth
  // instead of reading as the same THIN line the original, single-transform pillar drew — the
  // extra visual weight is what made the status tint read as a solid block instead of a thin
  // outline. `sw(n)` restores that depth-scaled thinness explicitly.
  const sw = (n) => n * scale

  return (
    <g
      // An ordinary 2D SVG transform on this <g> (and the `flat` one above), never a CSS 3D
      // one — the outer <svg> itself stays untransformed, so `svg.getScreenCTM()`
      // (WindowLayer's leader lines) is unaffected.
      opacity={dimmed ? 0.6 : 1}
      style={{ cursor: 'pointer', transition: 'opacity 240ms ease' }}
      onMouseEnter={() => onHover?.(id)}
      onMouseLeave={() => onLeave?.(id)}
      onClick={(e) => { e.stopPropagation(); onClick?.(id) }}
      data-station={id}
    >
      <g transform={flat}>
        {/* armed-fault reticle: a faint amber target on this station while a fault is pending */}
        {faultPending && (
          <g className="voltaris-pulse-slow" opacity="0.8">
            <circle cx="0" cy="0" r="46" fill="none" stroke={PALETTE.amber} strokeWidth="1.5" strokeDasharray="4 4" />
            <circle cx="0" cy="0" r="6" fill="none" stroke={PALETTE.amber} strokeWidth="1.5" />
          </g>
        )}

        {/* contact shadow — the light-theme replacement for the old dark-ground drop shadow.
            Neutral, never status-coloured: it's what grounds the pillar on the plane,
            the status fill/outline below is what carries the state. P11: softens (lower
            opacity, floored at SHADOW_OPACITY_FLOOR of this near-field value) and lengthens
            (wider, by up to SHADOW_RX_GROW) continuously with depthT — a near-field pillar
            (depthT ~= 0) renders exactly the pre-P11 ellipse unchanged. */}
        <ellipse
          cx="0" cy="4"
          rx={w * 0.62 * (1 + depthT * SHADOW_RX_GROW)}
          ry={11 * (1 + depthT * 0.15)}
          fill={PALETTE.ink}
          opacity={0.18 * (1 - depthT * (1 - SHADOW_OPACITY_FLOOR))}
        />

        {/* STATUS FILL/OUTLINE. The original uplight did not survive the move to a light
            theme: a glow spilling upward reads as light only against darkness, and on a pale
            ground it looks like a smudge. On paper, status has to read as ink and fill
            instead — a solid-filled plinth the pillar stands
            on, plus a coloured outline on the pillar's own body. Same five `UPLIGHT` states as
            before, same "only a genuine fault pulses" rule; only the rendering changed. */}
        <g className={alert ? 'voltaris-pulse' : 'voltaris-breathe'}>
          <ellipse cx="0" cy="5" rx={w * 0.58} ry="12" fill={UPLIGHT[cls.halo]} opacity={cls.isolated ? 0.35 : 0.55} />
          <ellipse cx="0" cy="5" rx={w * 0.58} ry="12" fill="none" stroke={UPLIGHT[cls.halo]} strokeWidth="1.5" opacity="0.9" />
        </g>
      </g>

      {/* heat column: rises from the cabinet's own top face (world y = cabinetY1), not an
          arbitrary offset from the floor — anchored at `cabinetTopFlat` (see above) so it stays
          attached to the cabinet regardless of PLINTH_H/CABINET_H tuning. */}
      {heatOpacity > 0.02 && (
        <g transform={cabinetTopFlat}>
          <rect x={-w / 4} y={-90} width={w / 2} height="90" fill="url(#heatGradient)" opacity={heatOpacity} />
        </g>
      )}

      {/* pillar body — real world-space boxes, each vertex individually projected through
          `project()` at the station's own (worldX, z) (see `tapBox()` above), instead of flat
          path strings at a fixed angle. Same three sub-forms as before this pass (foot/plinth,
          cabinet, head with a tapered cap), same three-tone material, same silhouette height
          (160 world units) — only the geometry is now honestly 3D. Painter's order: each form
          draws its side face, then its top face (where it has one), then its front face last
          (nearest the camera, so it paints over the shared edges cleanly); plinth, then
          cabinet, then head, bottom to top. Exactly one of each form's left/right side faces is
          ever drawn — `sideOf()` picks it from the station's own position, not a hardcoded
          angle, and flips which physical face it is (never which tone) as that position
          crosses the vanishing point. */}
      <g opacity={cls.failedComponents.length > 0 ? 0.55 : 1}>
        {/* foot / plinth: a short, wide slab the cabinet stands on. Its front-bottom edge sits
            exactly at (worldX, 0, z) — the same grid intersection layout.js already snapped
            the station onto, so the base still lands on the grid. */}
        <path d={pathD(sideOf(plinth))} fill={plinthSideTopFill} stroke={PALETTE.ink} strokeWidth={sw(1.5)} />
        <path d={pathD(plinth.top)} fill={plinthSideTopFill} stroke={PALETTE.ink} strokeWidth={sw(1)} opacity="0.85" />
        <path d={pathD(plinth.front)} fill={plinthFrontFill} stroke={PALETTE.ink} strokeWidth={sw(1.5)} />
        {/* P11: atmospheric haze — a `--v-void` wash over the plinth's plain structural
            material only (never the status ellipse below), fading it toward the page ground
            continuously with depth. See HAZE_MAX/depthFraction above for why this can never
            bury a status colour. */}
        {haze > 0.005 && (
          <g opacity={haze}>
            <path d={pathD(sideOf(plinth))} fill={PALETTE.void} />
            <path d={pathD(plinth.top)} fill={PALETTE.void} />
            <path d={pathD(plinth.front)} fill={PALETTE.void} />
          </g>
        )}

        {/* cabinet body: sits on the foot, no top face of its own — the head above supplies
            the roofline, the way a real charger's control head sits on a taller cabinet. */}
        <path d={pathD(sideOf(cabinet))} fill={cabinetSideFill} stroke={PALETTE.ink} strokeWidth={sw(1.5)} />
        <path d={pathD(cabinet.front)} fill={cabinetFrontFill} stroke={PALETTE.ink} strokeWidth={sw(1.5)} />
        {/* P11: same haze wash as the plinth, on the cabinet's plain material — drawn BEFORE
            the status tint/outline pass below, so that pass always lands at full, un-hazed
            strength no matter how far back this pillar sits. This ordering is the mechanism
            behind "do not bury a fault": the rose status colour is never touched by this <g>. */}
        {haze > 0.005 && (
          <g opacity={haze}>
            <path d={pathD(sideOf(cabinet))} fill={PALETTE.void} />
            <path d={pathD(cabinet.front)} fill={PALETTE.void} />
          </g>
        )}
        {/* status tint + outline — EXACTLY ONE pass over the whole pillar, here on the cabinet
            front only (the largest, most legible face). P0b had this same 0.12 wash on both the
            cabinet front and the head front, which — combined with those paths' now-unscaled
            stroke widths (see `sw()` above) — is what made the status colour read as a filled
            block instead of the original's paper-white-plus-thin-outline restraint. The head
            keeps its plain structural outline below (no status tint) — the ellipse, the cabinet
            outline and the screen text already carry the state, so the head doesn't need to
            repeat it. */}
        <path d={pathD(cabinet.front)} fill={UPLIGHT[cls.halo]} opacity="0.12" />
        <path d={pathD(cabinet.front)} fill="none" stroke={UPLIGHT[cls.halo]} strokeWidth={sw(2)} />

        {/* head: a distinct, narrower display bezel on top of the cabinet. The taper (bottom
            half-width > top half-width) is the box version of the old chamfered cap — a real
            extra pair of corners the projection draws for us, not a painted-on diagonal. Plain
            structural outline only — see the single-tint-pass note above. */}
        <path d={pathD(sideOf(head))} fill={cabinetSideFill} stroke={PALETTE.ink} strokeWidth={sw(1.5)} />
        <path d={pathD(head.top)} fill={plinthSideTopFill} stroke={PALETTE.ink} strokeWidth={sw(1)} opacity="0.9" />
        <path d={pathD(head.front)} fill={cabinetFrontFill} stroke={PALETTE.ink} strokeWidth={sw(1.5)} />
        {/* P11: same haze wash, on the head's plain material. The head carries no status tint
            of its own (see the comment below), so this is the head's only P11 change. */}
        {haze > 0.005 && (
          <g opacity={haze}>
            <path d={pathD(sideOf(head))} fill={PALETTE.void} />
            <path d={pathD(head.top)} fill={PALETTE.void} />
            <path d={pathD(head.front)} fill={PALETTE.void} />
          </g>
        )}

        {/* screen, cable + holster: flat, camera-facing shapes at the pillar's own single z —
            the SVG text here cannot be perspective-warped, so it stays on the same
            translate+scale shortcut as the rest of `flat`'s group, sized by the same
            depthScale(z) as everything else, not skewed to the box faces around it. Local
            coordinates unchanged from before this pass: the head's new local y range
            (-136..-160) still comfortably contains the screen rect's old position. */}
        <g transform={flat}>
          <rect x="-24" y="-153" width="44" height="22" rx="2" fill={PALETTE.void} stroke={PALETTE.ink} />
          <text x="-20" y="-144" fill={PALETTE.ice} fontSize="9" fontFamily="ui-monospace, monospace" letterSpacing="0.04em">
            {id}
          </text>
          <text x="-20" y="-134" fill={cls.faulted ? PALETTE.rose : PALETTE.ink} fontSize="9" fontFamily="ui-monospace, monospace">
            {screenText}
          </text>

          {/* charging cable: leaves the cabinet's side, hangs in a curve, and ends in a
              connector resting in a holster on the plinth. Neutral ink throughout — status
              keeps reading through the plinth ellipse and the outlines above, not through
              this. Kept at its original fixed local x (always the cabinet's local-right side)
              per the brief: this is a decoration, not a face, and does not flip with the view. */}
          <path
            d="M 40 -70 C 62 -54, 60 -28, 49 -13"
            fill="none"
            stroke={PALETTE.ink}
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.75"
          />
          {/* P2: energy travelling IN the cable, not a second cable — same `d`, overlaid, only
              while a session is actually live (`showCableFlow`, above). Amber, not ice: amber is
              already this deck's "a session in progress" colour (uplight.js's own comment, and
              the halo/cabinet-outline tint this same charging station already wears above) — a
              second accent (`ice`, already spoken for by the screen-id text and the selection
              outline on this very pillar) would read as a competing signal instead of the same
              state continuing into the cable. No new palette token needed either way. */}
          {showCableFlow && (
            <path
              d="M 40 -70 C 62 -54, 60 -28, 49 -13"
              fill="none"
              stroke={PALETTE.amber}
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeDasharray={`${CABLE_DASH} ${CABLE_GAP}`}
              opacity="0.8"
              className="voltaris-cable-flow"
              style={{
                '--cable-shift': `${CABLE_SHIFT}px`,
                animationDuration: `${cableFlowDurationS(station.telemetry.power_kw)}s`,
              }}
            />
          )}
          <rect x="39" y="-19" width="15" height="10" rx="3" fill={PALETTE.ink} opacity="0.15" stroke={PALETTE.ink} strokeWidth="1" />
          <rect x="42.5" y="-17.5" width="8" height="7" rx="1.5" fill={PALETTE.ink} opacity="0.85" />
        </g>
      </g>

      {/* uplink arc — anchored at the head's own top face (`headTopFlat`, projected above),
          not an arbitrary distance above the floor, so it stays sitting just above the head
          regardless of PLINTH_H/CABINET_H/HEAD_H tuning. Flickers/breaks when the link is not
          CONNECTED. */}
      <g transform={headTopFlat}>
        <path
          d="M -14 -20 A 14 14 0 0 1 14 -20"
          fill="none"
          stroke={cls.linkDown ? PALETTE.rose : PALETTE.uplinkIdle}
          strokeWidth="2"
          strokeDasharray={cls.linkDown ? '3 3' : undefined}
          className={cls.linkDown ? 'voltaris-flicker' : undefined}
        />
      </g>

      <g transform={flat}>
        {/* maintenance hold: hazard chevrons at the base */}
        {hold && (
          <g fill={PALETTE.amber} opacity="0.9">
            <path d="M -30 14 L -22 8 L -14 14 Z" />
            <path d="M 14 14 L 22 8 L 30 14 Z" />
          </g>
        )}

        {/* isolated ring — blue, not red: the system doing the right thing */}
        {cls.isolated && (
          <circle cx="0" cy={-h / 2} r={w * 0.72} fill="none" stroke={UPLIGHT.isolated} strokeWidth="1.5" opacity="0.7" />
        )}

        {/* component ring: six tiny arcs around the base, one per component in COMPONENTS order */}
        {ringComponents.map(({ name, health, angle }) => {
          const r = w * 0.62
          const a0 = angle - 0.22
          const a1 = angle + 0.22
          const p0 = [r * Math.sin(a0), 8 + r * 0.28 * Math.cos(a0)]
          const p1 = [r * Math.sin(a1), 8 + r * 0.28 * Math.cos(a1)]
          return (
            <path
              key={name}
              d={`M ${p0[0]} ${p0[1]} A ${r} ${r * 0.28} 0 0 1 ${p1[0]} ${p1[1]}`}
              fill="none"
              stroke={HEALTH_COLOR[health] ?? PALETTE.dim}
              strokeWidth={health === 'HEALTHY' ? 2 : 3}
              opacity={health === 'HEALTHY' ? 0.5 : 1}
              className={health !== 'HEALTHY' ? 'voltaris-pulse' : undefined}
            />
          )
        })}

        {selected && (
          <rect x={-w / 2 - 8} y={-h - 24} width={w + 16 - 14} height={h + 24} fill="none" stroke={PALETTE.ice} strokeWidth="1" strokeDasharray="2 3" opacity="0.7" />
        )}
      </g>
    </g>
  )
}

// Signature-based comparator: the snapshot is a brand-new object graph every poll (fresh JSON),
// so reference equality would always fail. Compare the primitive fields this pillar actually
// renders instead — one station's temperature changing must not force a
// re-render of the other three plus the grid.
//
// P0b: `layout.x/.y/.scale/.worldX/.z` must be in here too. Before this package the pillar was
// a flat billboard whose geometry never depended on `layout` beyond the position/scale it was
// already redrawn at, so omitting them from the signature was harmless; now the box's face
// visibility (`showLeftFace`, derived from `worldX`) and every projected vertex (derived from
// `worldX`/`z`) depend on `layout` directly, so a `layout`-only change (e.g. the station count
// changing, which reflows every row) must still invalidate the memo.
function signature(props) {
  const s = props.station
  const l = props.layout
  return JSON.stringify([
    s.status,
    s.connectors,
    s.components,
    s.communication_state,
    Math.round(s.telemetry.temperature_c * 10),
    Math.round(s.telemetry.power_kw),
    s.maintenance_hold,
    props.selected,
    props.dimmed,
    props.faultPending,
    l.x,
    l.y,
    l.scale,
    l.worldX,
    l.z,
  ])
}

function areEqual(prev, next) {
  return signature(prev) === signature(next)
}

const StationPillar = memo(StationPillarInner, areEqual)
export default StationPillar
