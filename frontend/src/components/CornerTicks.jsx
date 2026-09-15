// 4px L-shaped corner ticks — shared by the window chrome (`deck/windows/Window.jsx`) and the
// status bar's instrument clusters, so "this is instrument-grade hardware" reads consistently
// across every panel on screen rather than being a one-off window detail.
export default function CornerTicks({ className = 'border-ice/60' }) {
  const base = `pointer-events-none absolute h-2 w-2 ${className}`
  return (
    <>
      <span className={`${base} left-0 top-0 border-l border-t`} />
      <span className={`${base} right-0 top-0 border-r border-t`} />
      <span className={`${base} bottom-0 left-0 border-b border-l`} />
      <span className={`${base} bottom-0 right-0 border-b border-r`} />
    </>
  )
}
