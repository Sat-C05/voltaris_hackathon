// The single pinhole projection shared by the grid and every station on the deck. Everything
// visible on the floor plane — grid lines, station bases, pillar geometry — derives its
// screen position from `project()` so the floor and the objects standing on it share one
// projection BY CONSTRUCTION, not by the hand-tuned per-row scale fudge this replaces. See
// frontend_fiels/01-implementation-plan.md §0 for the full diagnosis and decision (Option C).
//
// World space: `x` is left/right, `y` is up from the floor (`y = 0` is the floor plane), `z`
// is depth away from the camera (larger z = further away). World units are deliberately the
// same scale as the pillar's existing hand-authored local geometry (`w=90 h=160` etc. in
// StationPillar.jsx) — so a pillar's local coordinates plug straight into `project()`/
// `depthScale()` with no unit conversion.
//
// The maths below happens entirely in JS; the `<svg>` element that renders it stays
// untransformed (no CSS 3D transform anywhere on it). That is what keeps
// `svg.getScreenCTM()` — which `WindowLayer`'s leader lines depend on — a valid, simple 2D
// matrix. Perspective and 2D leader lines are not in conflict; only a *CSS-transformed*
// perspective would be (CLAUDE.md invariant 6).

export const VIEWBOX_W = 1000
export const VIEWBOX_H = 600

// The floor's vanishing point — the screen point every floor-level (y=0) coordinate converges
// toward as z -> Infinity. Unchanged from the old CSS ground plane's horizon (38% down).
export const VANISH_X = VIEWBOX_W / 2
export const VANISH_Y = VIEWBOX_H * 0.38

// Pinhole camera parameters, in world units. There is no physical rig behind these — they are
// tuned, once, so the two station rows land at a similar screen depth/size to what the old
// hand-tuned BACK_SCALE/FRONT_SCALE pair produced (see layout.js for the row z values these
// pair with). Unlike that pair, changing one of these three constants now changes the WHOLE
// scene consistently — grid and every pillar together — because everything reads through the
// same `project()`/`depthScale()` below rather than each having its own fudge.
// Camera tuning, set by the orchestrator against a rendered preview of the real scene rather
// than derived: CAM_HEIGHT 400 -> 360 tilts the floor toward the viewer and widens the gap
// between the two station rows (~93px -> ~125px of screen separation), which is what makes the
// deck read as a place with depth rather than two bands of objects. A P0b brief quoted a stale
// baseline for this constant; the value below is the absolute approved one, not a delta.
export const CAM_HEIGHT = 360 // camera height above the floor plane
export const CAM_DIST = 300 // camera setback folded into the projection denominator
export const FOCAL = 560 // pinhole focal length

// World (x, y, z) -> screen [sx, sy], in the SVG's own viewBox units.
//
//   sx = VANISH_X + (x * FOCAL) / (z + CAM_DIST)
//   sy = VANISH_Y + ((CAM_HEIGHT - y) * FOCAL) / (z + CAM_DIST)
//
// Floor lines (y = 0) converge to the horizon at sy = VANISH_Y as z -> Infinity for free —
// nothing else needs to special-case that.
export function project(x, y, z) {
  const denom = z + CAM_DIST
  const sx = VANISH_X + (x * FOCAL) / denom
  const sy = VANISH_Y + ((CAM_HEIGHT - y) * FOCAL) / denom
  return [sx, sy]
}

// The local scale factor at depth z: how many screen units one world unit covers there.
// Every point `project()` computes at a given z divides by the same `(z + CAM_DIST)`, so this
// is also the EXACT scale a flat, camera-facing object at that z can be drawn with via a
// single translate+scale, instead of re-deriving every one of its vertices individually —
// see StationPillar.jsx's own comment for why that equivalence is exact, not an approximation,
// for the pillar's geometry specifically. P11 (atmospheric depth) also wants this directly,
// for haze/opacity-by-distance.
export function depthScale(z) {
  return FOCAL / (z + CAM_DIST)
}

// World-unit grid spacing, shared by Grid.jsx (drawing the floor lines) and layout.js
// (snapping station positions onto a grid intersection, and sizing the row spread). One
// shared constant is what guarantees a station and the grid line under it stay aligned —
// two independently "close enough" numbers is exactly the kind of drift this package removes.
export const GRID_STEP = 60
