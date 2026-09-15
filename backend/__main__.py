"""Run the whole system as one process:  python -m backend

One process is deliberate: reset between demos must be one thing to restart.
"""

import uvicorn

if __name__ == "__main__":
    uvicorn.run("backend.api.app:app", host="127.0.0.1", port=8000, reload=False)
