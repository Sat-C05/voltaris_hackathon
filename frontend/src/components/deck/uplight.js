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

// P9: the same five states, paired with what each one MEANS on screen. Kept here, immediately
// below the table it describes, because the package's whole rule is that the legend is generated
// FROM this module and never hand-typed a second time: a key that disagrees with the thing it
// is keying is worse than no key at all, and two lists in two files will disagree the first time
// anyone touches one of them.
//
// The wording is the operator's, not the schema's — `StationPillar`'s `classify()` is what
// actually maps snapshot fields to these five, and each `note` below is a plain-English reading
// of that function's branches in the same order it evaluates them. If `classify()` ever grows a
// sixth branch, add it in both places or the deck will show a colour the key cannot explain.
export const UPLIGHT_LEGEND = [
  { key: 'mint', label: 'HEALTHY', note: 'available, nothing wrong' },
  { key: 'amber', label: 'SESSION', note: 'a vehicle is charging' },
  { key: 'amber-desat', label: 'DEGRADED', note: 'a component is degraded, or the uplink is down' },
  { key: 'rose', label: 'FAULTED', note: 'the station or a connector has failed' },
  { key: 'isolated', label: 'ISOLATED', note: 'taken out of service by the agent' },
]
