"""Run the loopback-only worker with explicit database and port settings."""

import os

import uvicorn

from .api import create_app


def main() -> None:
    try:
        port = int(os.environ.get("WORKER_PORT", "8000"))
        if not 0 <= port <= 65535:
            raise ValueError
    except ValueError:
        raise SystemExit("WORKER_PORT must be an integer from 0 to 65535.") from None
    uvicorn.run(create_app(), host="127.0.0.1", port=port, access_log=False)


if __name__ == "__main__":
    main()
