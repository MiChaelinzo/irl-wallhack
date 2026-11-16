"""FastAPI application: JSON API, WebSocket stream and static dashboard."""
import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__
from .config import LOCAL_HOSTS, Config, load_config
from .runtime import Runtime

STATIC = Path(__file__).parent / "static"
WS_INTERVAL_S = 0.5
log = logging.getLogger("wallhack")


class SettingsUpdate(BaseModel):
    source: Optional[str] = None
    scenario: Optional[str] = None
    sensitivity: Optional[float] = None


def create_app(config: Optional[Config] = None) -> FastAPI:
    config = config or load_config()
    runtime = Runtime(config)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if config.background:
            runtime.start()
        yield
        runtime.stop()

    app = FastAPI(title="Wallhack WiFi sensing", version=__version__, lifespan=lifespan)
    app.state.runtime = runtime
    if config.host in LOCAL_HOSTS:
        # Blocks DNS rebinding: a loopback server must only answer to its own names.
        app.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1"])

    @app.get("/api/status")
    def status():
        return runtime.status()

    @app.get("/api/samples")
    def samples(limit: int = Query(200, ge=1, le=6000), link: Optional[str] = None, since: int = 0):
        with runtime.lock:
            rows = [s for s in runtime.samples if s["seq"] > since and (link is None or s["link"] == link)]
        return rows[-limit:]

    @app.get("/api/events")
    def events(limit: int = Query(100, ge=1, le=500)):
        with runtime.lock:
            return [e.as_dict() for e in list(runtime.engine.events)[-limit:]][::-1]

    @app.get("/api/links")
    def links():
        with runtime.lock:
            return runtime.engine.link_states()

    @app.get("/api/zones")
    def zones():
        with runtime.lock:
            return list(runtime.engine.zones().values())

    @app.get("/api/environment")
    def environment():
        """Environment readings, or null when no sensors are configured and the source is real."""
        return runtime.environment()

    @app.get("/api/vitals")
    def vitals():
        return runtime.vitals()

    @app.get("/api/settings")
    def get_settings():
        return runtime.settings()

    def require_same_origin(request: Request) -> None:
        origin = request.headers.get("origin")
        if origin is not None and urlparse(origin).netloc != request.headers.get("host"):
            raise HTTPException(status_code=403, detail="cross-origin request refused")

    @app.post("/api/calibrate")
    def calibrate(request: Request):
        """Reset learned baselines. Run it while the monitored space is empty and still."""
        require_same_origin(request)
        runtime.calibrate()
        return {"calibrated": True}

    @app.post("/api/settings")
    async def post_settings(request: Request):
        require_same_origin(request)
        # Requiring JSON forces a CORS preflight for cross-site pages, which this server never approves.
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise HTTPException(status_code=415, detail="Content-Type must be application/json")
        try:
            update = SettingsUpdate(**(await request.json()))
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=f"invalid settings: {exc}")
        try:
            await run_in_threadpool(runtime.update_settings, update.source, update.scenario, update.sensitivity)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        return runtime.settings()

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        # Browsers do not apply the same-origin policy to WebSockets, so check it here.
        origin = sock.headers.get("origin")
        if origin is not None and urlparse(origin).netloc != sock.headers.get("host"):
            await sock.close(code=1008)
            return
        await sock.accept()
        last = 0
        try:
            while True:
                with runtime.lock:
                    if runtime.seq < last:  # source was reconfigured and numbering restarted
                        last = 0
                    new = [s for s in runtime.samples if s["seq"] > last][-600:]
                if new:
                    last = new[-1]["seq"]
                await sock.send_json({"status": runtime.status(), "zones": zones(),
                                      "links": links(), "samples": new,
                                      "events": events(limit=20)})
                await asyncio.sleep(WS_INTERVAL_S)
        except (WebSocketDisconnect, RuntimeError):
            return

    if STATIC.is_dir():
        @app.get("/", include_in_schema=False)
        def index():
            page = STATIC / "index.html"
            if not page.is_file():
                raise HTTPException(status_code=404, detail="dashboard not installed")
            return FileResponse(page)

        app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
