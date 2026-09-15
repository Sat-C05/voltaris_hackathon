import { PALETTE } from '../../palette'

// The five station status states — the vocabulary survived the move to a light theme even
// though how a pillar *renders* them changed completely. Originally a glow
// spilling upward off the pillar's base (a halo, then a "grounded uplight" cone+core); on a
// light ground a glow reads as a smudge, not light, so `StationPillar.jsx` now uses these as a
// flat status fill/outline plus a neutral contact shadow instead. Kept as its own small module
// (rather than inlined in StationPillar) because it is still the one place all five states and
// their colours are enumerated together.
//
// `amber-desat` and `isolated` used to be raw hex here (they have no other Tailwind consumer of
// their own) — moved into palette.js's token table so they
// pick up a dark-theme value too, same as every other status colour.
export const UPLIGHT = {
  mint: PALETTE.mint, // healthy
  amber: PALETTE.amber, // a session in progress
  'amber-desat': PALETTE.amberDesat, // degraded component, or the uplink down — muted toward `dim`
  rose: PALETTE.rose, // failed component, or the station/connector faulted
  isolated: PALETTE.isolated, // taken out of service by the agent — deliberately not red
}
