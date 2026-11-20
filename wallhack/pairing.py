"""Opt-in LAN access for the mobile companion, protected by a random pairing token.

Default: the server binds 127.0.0.1 and none of this is active. With `lan` enabled the server binds
0.0.0.0 and every request from a non-loopback client must carry the pairing token, either as the
`wallhack_pair` HttpOnly cookie (set by GET /pair?token=...) or as `Authorization: Bearer <token>`.
Requests from the machine itself (loopback) are trusted so the owner can open the dashboard and
show the pairing URL. The token lives in memory only and changes on every start.
"""
import hmac
import json
import secrets
import socket
from typing import Optional

COOKIE_NAME = "wallhack_pair"
PAIR_PATH = "/pair"
LOOPBACK_CLIENTS = ("127.0.0.1", "::1", "localhost")
TOKEN_BYTES = 24


def new_token() -> str:
    return secrets.token_urlsafe(TOKEN_BYTES)


def is_loopback(host: Optional[str]) -> bool:
    return host in LOOPBACK_CLIENTS


def host_name(header: Optional[str]) -> str:
    """Hostname part of a Host header value, lowercased, without port or IPv6 brackets."""
    value = (header or "").strip().lower()
    if value.startswith("["):
        return value[1:].partition("]")[0]
    return value.partition(":")[0]


def lan_address() -> str:
    """This machine's LAN IPv4 address. Connecting a UDP socket sends no packet."""
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        return probe.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        probe.close()


def token_matches(supplied: Optional[str], expected: str) -> bool:
    return bool(supplied) and hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


def _credential(headers: dict) -> Optional[str]:
    auth = headers.get(b"authorization", b"").decode("latin-1")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    for part in headers.get(b"cookie", b"").decode("latin-1").split(";"):
        name, _, value = part.strip().partition("=")
        if name == COOKIE_NAME:
            return value
    return None


class PairingMiddleware:
    """Pure ASGI middleware so WebSocket connections are checked too."""

    def __init__(self, app, token: str, allowed_hosts=()):
        self.app, self.token = app, token
        self.allowed_hosts = frozenset(h.lower() for h in allowed_hosts)

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        client = (scope.get("client") or (None, None))[0]
        headers = dict(scope["headers"])
        if is_loopback(client):
            # Loopback is trusted only for the owner's own host names. A rebinding page reaches
            # this socket with a foreign Host header and must not inherit that trust.
            if host_name(headers.get(b"host", b"").decode("latin-1")) in self.allowed_hosts:
                return await self.app(scope, receive, send)
            return await self._refuse(scope, receive, send, 400, "host not allowed")
        if scope["path"] == PAIR_PATH:
            return await self.app(scope, receive, send)
        if token_matches(_credential(headers), self.token):
            return await self.app(scope, receive, send)
        await self._refuse(scope, receive, send, 401, "pairing required: scan the QR code shown on the host machine")

    @staticmethod
    async def _refuse(scope, receive, send, status, detail):
        if scope["type"] == "websocket":
            await receive()
            return await send({"type": "websocket.close", "code": 1008})
        body = json.dumps({"detail": detail}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})
