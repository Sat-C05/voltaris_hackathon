// Every fault/incident `target` string is "ST-02/C02" (connector), "ST-02.cooling"
// (component), or a bare station id "ST-02" — the station id is always the leading segment
// before the first "." or "/", or the whole string if neither appears. Pulled out once so
// Deck.jsx, WindowLayer.jsx and DeckApp.jsx don't each keep their own copy.
export function stationOfTarget(target) {
  return target.split(/[./]/)[0]
}
