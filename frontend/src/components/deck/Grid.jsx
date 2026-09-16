import { memo } from 'react'
import { PALETTE } from '../../palette'
import { project, VANISH_X, VANISH_Y, VIEWBOX_W, VIEWBOX_H, CAM_DIST, FOCAL, GRID_STEP } from './projection'

// The floor grid, drawn IN the station SVG through the same `project()` every pillar uses
// (see `./projection` and `layout.js`). This retires the old CSS `.voltaris-ground-scene` /
// `.voltaris-ground-plane` layer (`GroundPlane.jsx`, now deleted): true perspective still
// applies — lines genuinely converge to `VANISH_Y` as z -> Infinity — but the floor and the
// pillars now share one projection BY CONSTRUCTION instead of the floor being a separate CSS
// 3D layer that merely approximated the same look while the pillars used a different one.
//
// A pinhole projection maps a straight 3D line to a straight 2D line, so every grid line here
// is exactly two projected endpoints — no curve/segment approximation needed, unlike the old
// CSS plane's `rotateX` trick.
//
// `heatGradient` is the other `<defs>` this SVG needs: `StationPillar.jsx`'s heat column
// references `url(#heatGradient)`.
//
// Wrapped in React.memo with no props — the geometry here is fully static (world coordinates
// only, no station data), so it renders once and is skipped on every parent re-render caused
// by a snapshot poll.

const GRID_Z_NEAR = 0
const GRID_Z_FAR = 1500 // world units deep — past the back row, fading out toward the horizon

// Full-bleed: the floor must reach the left/right screen edges at every drawn depth, not stop
// at some arbitrary world x. A given world x covers LESS screen the further back it is (larger
// z means a bigger project() denominator), so the line that needs the most world-x to still
// reach the edge is the FARTHEST one drawn — GRID_Z_FAR. Sizing GRID_X_HALF for that one worst
// case guarantees every nearer z-line (which needs less world-x for the same screen reach)
// also reaches the edge. Solved from the inverse of project()'s x term
// (sx = VANISH_X + x*FOCAL/(z+CAM_DIST)) at sx = the viewBox edge and z = GRID_Z_FAR, then
// ceiled up to a whole GRID_STEP so the far line is never short of the edge by a fractional
// cell. Derived from the viewBox and GRID_Z_FAR rather than hardcoded, so it stays correct if
// the camera constants or GRID_Z_FAR ever change. Lines beyond the viewBox are simply clipped
// by the SVG — that is what "full bleed" means here, not that every line spans edge-to-edge.
const GRID_X_HALF =
  Math.ceil(((VIEWBOX_W / 2) * (GRID_Z_FAR + CAM_DIST)) / FOCAL / GRID_STEP) * GRID_STEP
// Horizon glow geometry. The flatten factor is shared by the gradient's `gradientTransform`
// and the ellipse's `ry` — they MUST match, or the gradient gets clipped by the shape.
const HORIZON_GLOW_R = VIEWBOX_W * 0.32
const HORIZON_GLOW_FLATTEN = 0.32

const MAJOR_EVERY = 5 // every 5th line (by world position, not array index) is the heavier one

function isMajor(worldCoord) {
  // Modulo on a possibly-negative value, normalised to land on world position, not on where a
  // given loop happened to start counting — so x = 0 is always major regardless of GRID_X_HALF.
  const idx = Math.round(worldCoord / GRID_STEP)
  return ((idx % MAJOR_EVERY) + MAJOR_EVERY) % MAJOR_EVERY === 0
}

function GridInner() {
  const xLines = []
  for (let x = -GRID_X_HALF; x <= GRID_X_HALF; x += GRID_STEP) xLines.push(x)
  const zLines = []
  for (let z = GRID_Z_NEAR; z <= GRID_Z_FAR; z += GRID_STEP) zLines.push(z)

  return (
    <>
      <defs>
        <linearGradient id="heatGradient" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor={PALETTE.rose} stopOpacity="0" />
          <stop offset="100%" stopColor={PALETTE.rose} stopOpacity="0.55" />
        </linearGradient>

        {/* Fades far/compressed lines to nothing instead of letting them moiré — same intent
            as the old CSS plane's mask, expressed in screen space. z -> sy is monotonic
            through project() (larger z always yields smaller sy, toward the horizon), so
            fading by sy here is equivalent to fading by depth without re-deriving z per line.
            The 0.74 cutoff mirrors the old plane's own mask stop, so the floor stays fully
            opaque for most of its depth and only dissolves in the last quarter on its way to
            the horizon. Luminance-only, not a visible colour — white/black here (never
            rendered) is the standard SVG mask idiom, not a design token. */}
        <linearGradient id="gridFade" x1="0" y1={VANISH_Y} x2="0" y2={VIEWBOX_H} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" stopOpacity="0" />
          <stop offset="0.74" stopColor="white" stopOpacity="1" />
          <stop offset="1" stopColor="white" stopOpacity="1" />
        </linearGradient>
        <mask id="gridFadeMask" maskUnits="userSpaceOnUse" x="0" y="0" width={VIEWBOX_W} height={VIEWBOX_H}>
          <rect x="0" y="0" width={VIEWBOX_W} height={VIEWBOX_H} fill="url(#gridFade)" />
        </mask>

        {/* P11: a faint gathering of light at the vanishing point — complements the existing
            gridFade above (which dissolves the far lines into nothing), it does not replace it.
            Centred at the same (VANISH_X, VANISH_Y) every floor line already converges toward,
            so it reads as light coming from the horizon itself rather than a decal. Radius/stop
            values are plain visual tuning (this is a decoration, not a projected quantity), not
            derived from a world coordinate the way the grid lines themselves are. */}
        {/* `gradientTransform` squashes the gradient by exactly the same factor as the ellipse
            it fills (HORIZON_GLOW_FLATTEN, below). Without it the gradient is a CIRCLE of
            r=HORIZON_GLOW_R while the painted shape is an ellipse only 0.32 as tall — so
            vertically the falloff never reaches zero inside the shape and gets hard-clipped at
            the ellipse's edge. That clip is invisible on the pale light ground and reads as a
            large brown smudge with a visible rim on the dark one. Matching the transform to the
            shape is what makes it an actual glow rather than a tinted blob. */}
        <radialGradient id="horizonGlow" gradientUnits="userSpaceOnUse"
          cx={VANISH_X} cy={VANISH_Y} r={HORIZON_GLOW_R}
          gradientTransform={`translate(0 ${VANISH_Y * (1 - HORIZON_GLOW_FLATTEN)}) scale(1 ${HORIZON_GLOW_FLATTEN})`}>
          <stop offset="0%" stopColor={PALETTE.horizonGlow} stopOpacity="0.2" />
          <stop offset="45%" stopColor={PALETTE.horizonGlow} stopOpacity="0.07" />
          <stop offset="100%" stopColor={PALETTE.horizonGlow} stopOpacity="0" />
        </radialGradient>

        {/* P11: vignette — the frame edges falling off toward the page ground (`--v-void`,
            same token the pillar haze fades toward — see StationPillar.jsx), so the floor reads
            as a place lit from the centre rather than a flat rectangle of grid. Transparent
            through the centre 55% of the radius, so it never touches the two station rows
            themselves; only the outer floor/corners darken (light theme) or blacken (dark). */}
        <radialGradient id="floorVignette" gradientUnits="userSpaceOnUse"
          cx={VIEWBOX_W / 2} cy={VIEWBOX_H * 0.55} r={VIEWBOX_W * 0.72}>
          <stop offset="55%" stopColor={PALETTE.void} stopOpacity="0" />
          <stop offset="100%" stopColor={PALETTE.void} stopOpacity="0.55" />
        </radialGradient>
      </defs>

      {/* Drawn UNDER the grid lines (next, still behind the masked <g> below) so the lines
          stay crisp on top of it — a soft wash of light, not a shape that competes with the
          linework. */}
      <ellipse cx={VANISH_X} cy={VANISH_Y} rx={HORIZON_GLOW_R} ry={HORIZON_GLOW_R * HORIZON_GLOW_FLATTEN} fill="url(#horizonGlow)" />

      <g mask="url(#gridFadeMask)">
        {/* Lines of constant x, receding in z — the "verticals" that converge toward the
            vanishing point. */}
        {xLines.map((x) => {
          const [x1, y1] = project(x, 0, GRID_Z_NEAR)
          const [x2, y2] = project(x, 0, GRID_Z_FAR)
          const major = isMajor(x)
          return (
            <line
              key={`x${x}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={major ? PALETTE.ice : PALETTE.grid}
              strokeWidth={major ? 1.5 : 1}
              opacity={major ? 0.55 : 0.6}
            />
          )
        })}
        {/* Lines of constant z, crossing the floor — compress together toward the horizon. */}
        {zLines.map((z) => {
          const [x1, y1] = project(-GRID_X_HALF, 0, z)
          const [x2, y2] = project(GRID_X_HALF, 0, z)
          const major = isMajor(z)
          return (
            <line
              key={`z${z}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={major ? PALETTE.ice : PALETTE.grid}
              strokeWidth={major ? 1.5 : 1}
              opacity={major ? 0.55 : 0.6}
            />
          )
        })}
      </g>

      {/* Vignette, drawn last (on top of the grid lines, still behind every pillar — Grid
          renders before the station <g> in the parent SVG) so only the floor itself falls off
          toward the edges, never a pillar standing on it. */}
      <rect x="0" y="0" width={VIEWBOX_W} height={VIEWBOX_H} fill="url(#floorVignette)" />
    </>
  )
}

const Grid = memo(GridInner)
export default Grid
