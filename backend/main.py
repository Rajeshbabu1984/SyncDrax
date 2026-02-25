"""
Syncora — Signaling Server + Auth API
Built with FastAPI + uvicorn + SQLModel

Run:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Endpoints:
    WS   /ws/{room_code}/{peer_id}/{display_name}   — WebRTC signaling
    POST /auth/signup                               — Create account
    POST /auth/signin                               — Sign in, get JWT
    GET  /auth/me                                   — Get current user
    GET  /health                                    — Health check
    GET  /rooms                                     — Active room stats
"""

import json
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from starlette.websockets import WebSocketState

import bcrypt as _bcrypt
from sqlmodel import Field, Session, SQLModel, create_engine, select
from jose import JWTError, jwt
from dotenv import load_dotenv

load_dotenv()

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────
SECRET_KEY        = os.getenv("SECRET_KEY", "syncora-dev-secret-change-in-production")
ALGORITHM        = "HS256"
TOKEN_EXPIRE_DAYS = 30
ADMIN_KEY         = os.getenv("ADMIN_KEY", "syncora-admin-2026")

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./syncora.db")

# ─────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("syncora")

MAX_PEERS_PER_ROOM = 30

# ─────────────────────────────────────────────────────────────
# Database — SQLModel + SQLite
# ─────────────────────────────────────────────────────────────
# SQLite needs check_same_thread=False; Postgres does not take that arg
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, echo=False, connect_args=_connect_args)


class User(SQLModel, table=True):
    id:             Optional[int]  = Field(default=None, primary_key=True)
    name:           str            = Field(index=False)
    email:          str            = Field(index=True, unique=True)
    hashed_password: str
    created_at:     datetime       = Field(default_factory=lambda: datetime.now(timezone.utc))


def create_db_tables():
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session


# ─────────────────────────────────────────────────────────────
# Password hashing
# ─────────────────────────────────────────────────────────────
def hash_password(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


# ─────────────────────────────────────────────────────────────
# JWT
# ─────────────────────────────────────────────────────────────
bearer_scheme = HTTPBearer(auto_error=False)


def create_token(user_id: int, email: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRE_DAYS)
    return jwt.encode({"sub": str(user_id), "email": email, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    session: Session = Depends(get_session),
) -> User:
    if not creds:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = decode_token(creds.credentials)
        user_id = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user


# ─────────────────────────────────────────────────────────────
# Pydantic request / response schemas
# ─────────────────────────────────────────────────────────────
class SignUpRequest(BaseModel):
    name:     str
    email:    str
    password: str


class SignInRequest(BaseModel):
    email:    str
    password: str


class AuthResponse(BaseModel):
    token: str
    user:  dict


# ─────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────
app = FastAPI(title="Syncora Signaling Server", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup():
    create_db_tables()
    log.info("Database ready at %s", DATABASE_URL)


# ─────────────────────────────────────────────────────────────
# Auth endpoints
# ─────────────────────────────────────────────────────────────
@app.post("/auth/signup", response_model=AuthResponse)
def signup(req: SignUpRequest, session: Session = Depends(get_session)):
    req.name  = req.name.strip()
    req.email = req.email.strip().lower()

    if not req.name or not req.email or not req.password:
        raise HTTPException(status_code=400, detail="All fields are required")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    existing = session.exec(select(User).where(User.email == req.email)).first()
    if existing:
        raise HTTPException(status_code=409, detail="An account with that email already exists")

    user = User(name=req.name, email=req.email, hashed_password=hash_password(req.password))
    session.add(user)
    session.commit()
    session.refresh(user)

    token = create_token(user.id, user.email)
    log.info("New user signed up: %s (%s)", user.name, user.email)
    return {"token": token, "user": {"id": user.id, "name": user.name, "email": user.email}}


@app.post("/auth/signin", response_model=AuthResponse)
def signin(req: SignInRequest, session: Session = Depends(get_session)):
    req.email = req.email.strip().lower()
    user = session.exec(select(User).where(User.email == req.email)).first()
    if not user or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect email or password")

    token = create_token(user.id, user.email)
    log.info("User signed in: %s (%s)", user.name, user.email)
    return {"token": token, "user": {"id": user.id, "name": user.name, "email": user.email}}


@app.get("/auth/me")
def me(current_user: User = Depends(get_current_user)):
    return {"id": current_user.id, "name": current_user.name, "email": current_user.email}


# ─────────────────────────────────────────────────────────────
# Admin endpoints
# ─────────────────────────────────────────────────────────────
from fastapi import Header


def require_admin(x_admin_key: Optional[str] = Header(default=None)):
    if not x_admin_key or x_admin_key != ADMIN_KEY:
        raise HTTPException(status_code=403, detail="Forbidden: invalid admin key")


@app.get("/admin/users")
def admin_list_users(
    session: Session = Depends(get_session),
    _: None = Depends(require_admin),
):
    users = session.exec(select(User).order_by(User.created_at.desc())).all()
    return [
        {"id": u.id, "name": u.name, "email": u.email, "joined": u.created_at.isoformat()}
        for u in users
    ]


@app.delete("/admin/users/{user_id}")
def admin_delete_user(
    user_id: int,
    session: Session = Depends(get_session),
    _: None = Depends(require_admin),
):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    session.delete(user)
    session.commit()
    log.info("Admin terminated user %d (%s / %s)", user_id, user.name, user.email)
    return {"ok": True, "deleted": user_id}


# ─────────────────────────────────────────────────────────────
# Utility endpoints
# ─────────────────────────────────────────────────────────────

# In-memory room registry  { room_code: { peer_id: { ws, name } } }
rooms: Dict[str, Dict[str, dict]] = {}


async def safe_send(ws: WebSocket, payload: dict):
    """Send JSON to a single client, swallowing errors."""
    try:
        if ws.client_state == WebSocketState.CONNECTED:
            await ws.send_text(json.dumps(payload))
    except Exception as exc:
        log.warning("safe_send failed: %s", exc)


async def broadcast_to_room(room_code: str, payload: dict, exclude: str | None = None):
    """Broadcast JSON to all peers in a room except `exclude`."""
    if room_code not in rooms:
        return
    for pid, info in list(rooms[room_code].items()):
        if pid == exclude:
            continue
        await safe_send(info["ws"], payload)


# ─────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "rooms": len(rooms)}


@app.get("/rooms")
async def room_stats():
    return {
        code: {"participants": len(peers)}
        for code, peers in rooms.items()
    }


# ─────────────────────────────────────────────────────────────
@app.websocket("/ws/{room_code}/{peer_id}/{display_name}")
async def ws_endpoint(ws: WebSocket, room_code: str, peer_id: str, display_name: str):
    await ws.accept()
    room_code = room_code.upper()

    # ── Enforce participant limit ──
    room_peers = rooms.get(room_code, {})
    if len(room_peers) >= MAX_PEERS_PER_ROOM:
        await safe_send(ws, {"type": "room_full"})
        await ws.close()
        return

    # ── Register peer ──
    rooms.setdefault(room_code, {})
    rooms[room_code][peer_id] = {"ws": ws, "name": display_name}
    log.info("[%s] %s joined as '%s'  (total: %d)", room_code, peer_id, display_name, len(rooms[room_code]))

    # ── Send existing peers to new joiner ──
    existing = [
        {"id": pid, "name": info["name"]}
        for pid, info in rooms[room_code].items()
        if pid != peer_id
    ]
    await safe_send(ws, {"type": "room_state", "peers": existing})

    # ── Notify existing peers of new joiner ──
    await broadcast_to_room(room_code, {
        "type":    "peer_joined",
        "peer_id": peer_id,
        "name":    display_name,
    }, exclude=peer_id)

    # ── Message loop ──
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            msg_type = msg.get("type", "")

            # ── WebRTC Signaling relay ──
            if msg_type in ("offer", "answer", "ice"):
                to_id = msg.get("to_id")
                if to_id and to_id in rooms.get(room_code, {}):
                    relay = {**msg, "from_id": peer_id}
                    await safe_send(rooms[room_code][to_id]["ws"], relay)

            # ── Chat relay ──
            elif msg_type == "chat":
                await broadcast_to_room(room_code, {
                    "type":      "chat",
                    "from_id":   peer_id,
                    "from_name": display_name,
                    "text":      msg.get("text", ""),
                    "ts":        msg.get("ts", 0),
                }, exclude=peer_id)

            else:
                log.debug("Unknown message type '%s' from %s", msg_type, peer_id)

    except (WebSocketDisconnect, Exception) as exc:
        if not isinstance(exc, WebSocketDisconnect):
            log.warning("[%s] %s error: %s", room_code, peer_id, exc)

    finally:
        # ── Clean up ──
        if room_code in rooms and peer_id in rooms[room_code]:
            del rooms[room_code][peer_id]
            log.info("[%s] %s left  (total: %d)", room_code, peer_id, len(rooms.get(room_code, {})))

        # Notify others
        await broadcast_to_room(room_code, {
            "type":    "peer_left",
            "peer_id": peer_id,
        })

        # Remove empty rooms
        if room_code in rooms and not rooms[room_code]:
            del rooms[room_code]
            log.info("[%s] Room deleted (empty)", room_code)
