"""The agent and its harness. Imports from world/ and pipeline/.

- `ops.py`          — the shared comparison-operator vocabulary (`equals`, `in`, `<`, ...)
  used by preconditions, safety constraints, and verifier goals/constraints alike.
- `tools.py`        — `ToolExecutor`: the twelve tools as internal Python calls. Its public
  methods ARE `IMPLEMENTED_TOOLS` — see `capabilities.py`.
- `capabilities.py` — loads `data/capabilities.json` and the drift guard that asserts it
  against `ToolExecutor`'s methods, so the declared tool set cannot diverge from the
  implemented one.
- `policy.py`       — `PolicyValidator`: the seven checks, the structured rejection codes,
  and the per-(capability, target, incident) attempt/cooldown ledger.
- `verifier.py`     — `Verifier`: evaluates goals/constraints against LIVE twin state. The
  agent's only path forward is `propose_resolution`; it cannot write RESOLVED itself.
- `context.py`      — builds the system prompt, the incident context, and the tool schema
  handed to the model.
- `harness.py`      — `AgentHarness`: the bounded agent loop. Step, action, duplicate-call
  and wall-clock budgets are enforced here, in code, not in the prompt. A budget breach
  routes to safe escalation.
- `llm_client.py`   — the only module that talks to the model, via Ollama's native
  tool-calling API. Swapping models or providers is a one-file change.
- `evaluation.py`   — scenario scoring: Detection, Action Safety, Recovery and friends.
- `stub_agent.py`   — a scripted agent with no LLM: a hardcoded tool sequence that drives
  the cooling incident to RESOLVED, with one deliberate policy rejection scripted in.
- `demo.py` / `llm_demo.py` — CLI walkthroughs for the stub and the real agent, runnable
  via `uv run python -m backend.agent.demo` and `... .llm_demo`.
"""
