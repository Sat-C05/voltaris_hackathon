# Voltaris — EV Autonomous NOC

Voltaris is a simulated **autonomous Network Operations Center (NOC) for EV charging infrastructure**.

It models an EV charging network, injects realistic infrastructure faults, and uses an autonomous agent to **observe, investigate, reason about the fault, select safe actions, verify the result, and recover or escalate when remote recovery is not possible**.

The system runs inside a simulated world with a controllable clock and a seedable RNG, so scenarios are repeatable and autonomous behavior is measurable.

## What Voltaris Demonstrates

Traditional EV charging infrastructure monitoring can detect that a charger is unhealthy, but detection alone is not enough.

Voltaris explores what happens when the NOC can autonomously move from:

```text
Fault
  ↓
Detection
  ↓
Investigation
  ↓
Diagnosis
  ↓
Action
  ↓
Verification
  ↓
Recovery / Escalation
```

The agent operates through a bounded set of tools and policies rather than having unrestricted access to the simulated infrastructure.

## Architecture

```text
                    ┌─────────────────────────┐
                    │       Voltaris UI       │
                    │ React + Vite + Tailwind │
                    └────────────┬────────────┘
                                 │ HTTP
                                 ▼
                    ┌─────────────────────────┐
                    │      FastAPI NOC        │
                    │ API + orchestration     │
                    └────────────┬────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
       ┌────────────┐     ┌────────────┐     ┌────────────┐
       │ EV Network │     │  Incident  │     │ Evaluation │
       │ Simulation │     │  Pipeline  │     │ & Scoring  │
       └─────┬──────┘     └─────┬──────┘     └────────────┘
             │                  │
             └──────────┬───────┘
                        ▼
               ┌─────────────────┐
               │ Autonomous Agent│
               │                 │
               │ Observe         │
               │ Reason          │
               │ Act             │
               │ Verify          │
               └────────┬────────┘
                        │
                        ▼
                  Ollama / LLM
```

### Core components

* **World simulation** — models charging stations, connectors, components, telemetry, faults, and state transitions.
* **Incident pipeline** — detects and processes network events and incidents.
* **Autonomous agent** — investigates incidents and selects actions through a bounded tool interface.
* **Safety policy & verifier** — validates proposed actions and verifies the resulting system state.
* **Evaluation engine** — measures whether the agent actually achieved the scenario's success criteria.
* **Replay system** — records and replays completed runs for reproducible demonstrations.
* **Web interface** — provides a live NOC-style view of the simulated network, incidents, agent activity, scorecard, and replay data.

## Autonomous Agent

The agent does not directly manipulate the simulated world.

Instead, it interacts through a constrained set of operational tools and must operate within the system's safety rules.

A typical run looks like:

```text
Incident detected
      ↓
Read network / charger state
      ↓
Inspect component telemetry
      ↓
Identify likely failure
      ↓
Select permitted remediation
      ↓
Execute action
      ↓
Re-check system state
      ↓
    ┌───────────────┐
    │ Recovered?    │
    └───────┬───────┘
        Yes │ No
            │
      ┌─────┴─────┐
      ▼           ▼
   Resolve     Escalate
```

The system also supports cases where remote recovery is explicitly impossible, requiring the agent to recognize that continuing to act is unsafe or ineffective and escalate instead.

## Demo Scenarios

Voltaris currently includes four fault scenarios:

### Communication Failure

A charging station's communication subsystem enters a degraded state.

The agent must diagnose the communication problem and restore healthy operation without using the forbidden connector-reset action.

### Contactor Failure

A degraded contactor affects a charging station.

The agent must identify the failure, perform an appropriate recovery sequence, and verify that the station returns to an operational state while maintaining the required safety constraints.

### Cooling Failure

A degraded cooling subsystem causes the station's thermal state to deteriorate.

The agent must recover the station while ensuring the temperature and other component-health constraints remain within safe limits.

### Unrecoverable Cooling Failure

The same type of cooling fault occurs, but remote recovery is explicitly impossible.

The correct autonomous behavior is therefore **escalation**, rather than repeatedly attempting actions that cannot resolve the underlying physical fault.

## Tech Stack

**Backend**

* Python 3.11+
* FastAPI
* Uvicorn
* Pydantic
* SQLite

**Frontend**

* React 18
* Vite
* Tailwind CSS

**Local Models**

The project is designed to run with a local model served by Ollama. The default configuration uses:

```text
gemma4:e4b
```

A compatible fallback model can also be configured in the backend.

## Running Voltaris

### Prerequisites

Install:

* Python 3.11+
* `uv`
* Node.js
* npm
* Ollama

Pull the configured local model:

```bash
ollama pull gemma4:e4b
```

### Development mode

Start the backend:

```bash
uv sync
uv run python -m backend
```

The API runs on:

```text
http://127.0.0.1:8000
```

Then, in a second terminal:

```bash
cd frontend
npm install
npm run dev
```

The development interface is available at the Vite URL shown in the terminal.

### Demo mode

For a single-process demonstration, build the frontend:

```bash
cd frontend
npm install
npm run build
```

Then start the backend:

```bash
cd ..
uv run python -m backend
```

The backend serves the built frontend alongside the API.

## Verification

Scenario runs accept a seed, so the simulated world can be driven under the same conditions again, and each run is scored against the scenario's own success criteria rather than on whether it looked plausible.

Completed runs are recorded by the replay system and can be played back exactly as they happened.

Runtime data and generated databases are excluded from version control.

## Project Background

Voltaris is a hackathon adaptation of an autonomous NOC concept for EV charging infrastructure, built around a simulated network so the full detect → investigate → act → verify loop can be demonstrated end to end. Everything needed to run, drive and evaluate it is in this repository.
