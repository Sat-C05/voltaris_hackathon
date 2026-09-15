"""Single source for every tunable constant in the system.

These values are depended on by several components at once — the simulator, the policy
validator, the agent harness and the frontend's mirrored copy in `frontend/src/contracts.js`
— so changing one in isolation will desynchronise the others.
"""

# ── The clock ─────────────────────────────────────────────────────────────────
TICK_INTERVAL_REAL = 0.5   # wall-clock seconds between ticks
TICK_SIM_SECONDS = 15      # 30x: at 10x the cooling demo takes 5m45s to open an incident,
                           # against a 2-minute demo target.
SIM_TIME_SCALE = TICK_SIM_SECONDS / TICK_INTERVAL_REAL   # 30x

# Durations shorter than one tick round UP to the next tick boundary.

# ── Incident identity ─────────────────────────────────────────────────────────
INCIDENT_OPEN_WINDOW_SIM_SECONDS = 600

# ── Thresholds ────────────────────────────────────────────────────────────────
TEMP_WARNING = 65.0       # emits THERMAL_WARNING (edge-triggered)
TEMP_PROTECTION = 78.0    # forces connector -> FAULTED
TEMP_SAFE = 55.0          # recovery constraint
AMBIENT_TEMP_C = 32.0     # relax floor
AMBIENT_RELAX_C_PER_SIM_MIN = -1.5   # not a fault -> no severity multiplier


# ── Fault severity is a rate multiplier ───────────────────────────────────────
def severity_multiplier(severity: float) -> float:
    """Scales per-sim-minute effect RATES only.

    Never applied to set-values (handshake_success_rate, comm_latency_ms,
    session_drop_probability, the power cap) or to the ambient relax rate.
    """
    return 0.5 + severity

# ── Action limits are counted per (capability, target) per INCIDENT ───────────
# Attempts do NOT reset on a verification retry, so a station that cannot be recovered
# escalates through the agent's own reasoning (ATTEMPT_LIMIT_REACHED) rather than by
# breaching the MAX_ACTIONS guardrail.

# ── Agent budgets ─────────────────────────────────────────────────────────────
MAX_STEPS = 20
MAX_ACTIONS = 5
MAX_CONSECUTIVE_OBSERVATIONS = 6
DUPLICATE_CALL_LIMIT = 2
WALL_CLOCK_TIMEOUT_SECONDS = 120   # the ONLY wall-clock value in the system
MAX_VERIFICATION_RETRIES = 2
DEFAULT_SETTLE_SIM_SECONDS = 60

# ── Model ─────────────────────────────────────────────────────────────────────
OLLAMA_HOST = "http://localhost:11434"
MODEL_NAME = "gemma4:e4b"     # fallback: "qwen3.5:9b"
MODEL_NUM_CTX = 16384         # cap KV cache; the real transcript never exceeds ~7K

# ── Paths ─────────────────────────────────────────────────────────────────────
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
WORLDS_DIR = DATA_DIR / "worlds"
SCENARIOS_DIR = DATA_DIR / "scenarios"
CAPABILITIES_FILE = DATA_DIR / "capabilities.json"
PROTOCOL_FILE = DATA_DIR / "protocol.md"
DB_PATH = Path(__file__).parent.parent / "voltaris.db"
# A separate file from DB_PATH on purpose. `POST /world/reset` deletes DB_PATH to give every
# scenario a clean events/incidents slate (api/app.py's `build_state()`) -- a recorded golden
# run must survive exactly that reset, or capturing one and then resetting the world to run
# the next scenario would erase it.
GOLDEN_RUNS_DB_PATH = Path(__file__).parent.parent / "golden_runs.db"
