import { useSnapshot } from './useSnapshot'
import { useEvents } from './useEvents'
import Header from './components/Header'
import NetworkMap from './components/NetworkMap'
import IncidentPanel from './components/IncidentPanel'
import AgentTimeline from './components/AgentTimeline'
import EventLog from './components/EventLog'
import FaultInjectionForm from './components/FaultInjectionForm'

// The classic page: header · network map · incident panel · agent timeline · event log
// · fault-injection form. Everything here renders exclusively from `/world` —
// the one exception is the event log, which reads the separate append-only `/events` stream
// and never feeds back into anything this component renders from `/world`.
export default function App() {
  const { snapshot, error } = useSnapshot()
  const { events, reset: resetEvents } = useEvents()

  const incidents = snapshot?.incidents ?? []
  // The timeline follows whichever incident is currently running an agent, falling back to the
  // most recently opened incident once the run has finished — so a RESOLVED/ESCALATED outcome
  // stays visible on screen instead of the panel going blank the moment the run ends.
  const mostRecent = [...incidents].sort((a, b) => b.opened_sim_time - a.opened_sim_time)[0]
  const runId = snapshot?.active_run?.run_id ?? mostRecent?.agent_run_id ?? null

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-mono p-6 flex flex-col gap-4">
      <Header snapshot={snapshot} />

      {error && <p className="text-red-400 text-sm">snapshot unavailable: {error}</p>}

      {snapshot && (
        <>
          <NetworkMap stations={snapshot.stations} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" style={{ minHeight: '20rem' }}>
            <IncidentPanel incidents={incidents} activeRun={snapshot.active_run} stations={snapshot.stations} />
            <AgentTimeline runId={runId} />
          </div>

          <EventLog events={events} />

          <FaultInjectionForm
            faults={snapshot.faults ?? []}
            simTime={snapshot.sim_time}
            onReset={resetEvents}
          />
        </>
      )}
    </div>
  )
}
