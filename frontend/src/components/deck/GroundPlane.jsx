import { memo } from 'react'

// The deck's floor — the grid is tilted so it reads as a plane things stand on.
// A pure CSS 3D transform: `perspective(...)` on this wrapper,
// `rotateX(...)` on the inner plane, so the grid genuinely recedes toward a horizon rather than
// being drawn to merely *look* like perspective. No dependency, no WebGL — the whole thing is
// one element with a `background-image` of layered `repeating-linear-gradient`s (minor cells,
// then heavier majors) and a mask that fades it out toward the horizon instead of letting the
// compressed far lines moiré.
//
// Deliberately NOT the SVG the stations live in. `WindowLayer`'s leader lines depend on
// `svg.getScreenCTM()` to place a line endpoint at a station's on-screen position — that call
// returns a 2D matrix and cannot represent a 3D transform. Putting the *stations* inside a
// 3D-transformed layer would send every leader line to the wrong point, permanently, not just
// while animating. So the plane is a separate, purely decorative layer behind the untouched,
// untransformed station SVG; `computeStationLayout`'s positions still land in that flat SVG
// exactly as before this reset, and the plane just needs to visually bracket where they already
// are (back row further up the screen, front row lower — see `layout.js`'s y anchors, 330/480
// out of a 600-tall viewBox, i.e. 55%/80% down the deck) rather than solve any 3D placement.
//
// Static and prop-less, like the old `Grid`: renders once, memoized, never re-renders on a
// snapshot poll.
function GroundPlaneInner() {
  return (
    <div className="voltaris-ground-scene pointer-events-none absolute inset-0 overflow-hidden">
      <div className="voltaris-ground-plane" />
    </div>
  )
}

const GroundPlane = memo(GroundPlaneInner)
export default GroundPlane
