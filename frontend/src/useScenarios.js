import { useCallback, useEffect, useState } from 'react'

/**
 * The scenario rail's data: `GET /scenarios` for the ids,
 * `GET /runs/golden` for the recorded-run table. Both are cheap, low-frequency reads — fetched
 * on mount and whenever `refreshToken` changes (the caller bumps it after a run ends), not
 * polled on an interval like the snapshot.
 */
export function useScenarios(refreshToken = 0) {
  const [scenarioIds, setScenarioIds] = useState([])
  const [goldenRuns, setGoldenRuns] = useState([])
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [scenariosRes, goldenRes] = await Promise.all([
        fetch('/scenarios'),
        fetch('/runs/golden'),
      ])
      if (scenariosRes.ok) {
        const data = await scenariosRes.json()
        setScenarioIds(data.scenarios ?? [])
      }
      if (goldenRes.ok) {
        const data = await goldenRes.json()
        setGoldenRuns(data.runs ?? [])
      }
      setError(null)
    } catch (e) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh, refreshToken])

  return { scenarioIds, goldenRuns, error, refresh }
}
