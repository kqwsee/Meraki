import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import memory
from .config import BASE_DIR, settings
from .db import init_db
from .routers import adventures, auth, courses, learn, pins, profile, telemetry, tools, visuals, workspace
from .services.sessions import idle_sweeper
from .services.workspace_layout import migrate_workspace_layout

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    migrate_workspace_layout()
    memory.start_memory()
    sweeper = asyncio.create_task(idle_sweeper())
    yield
    sweeper.cancel()
    memory.stop_memory()


app = FastAPI(title="Meraki", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for r in (auth, courses, pins, tools, visuals, learn, adventures, workspace, telemetry, profile):
    app.include_router(r.router)


@app.get("/api/health")
def health():
    return {"ok": True, "llm": settings.llm_provider, "memory": memory.memory_status()}


# Serve the built frontend (npm run build) from the same origin in production
_dist = BASE_DIR.parent / "frontend" / "dist"
if _dist.exists():
    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        candidate = _dist / full_path
        if full_path and candidate.is_file() and Path(candidate).resolve().is_relative_to(_dist.resolve()):
            return FileResponse(candidate)
        return FileResponse(_dist / "index.html")
