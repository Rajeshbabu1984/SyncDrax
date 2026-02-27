"""
SyncDrax � Signaling Server + Auth API
Built with FastAPI + uvicorn + SQLModel

Run:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Endpoints:
    WS   /ws/{room_code}/{peer_id}/{display_name}   � WebRTC signaling
    POST /auth/signup                               � Create account
    POST /auth/signin                               � Sign in, get JWT
    GET  /auth/me                                   � Get current user
    GET  /health                                    � Health check
    GET  /rooms                                     � Active room stats
"""

import json
import logging
import os
import shutil
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, status, UploadFile, File, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, EmailStr
from starlette.websockets import WebSocketState

import bcrypt as _bcrypt
from sqlmodel import Field, Session, SQLModel, create_engine, select
from jose import JWTError, jwt
from dotenv import load_dotenv

load_dotenv()

# -------------------------------------------------------------
# Config
# -------------------------------------------------------------
SECRET_KEY        = os.getenv("SECRET_KEY", "syncdrax-dev-secret-change-in-production")
ALGORITHM        = "HS256"
TOKEN_EXPIRE_DAYS = 30
ADMIN_KEY         = os.getenv("ADMIN_KEY", "syncdrax-admin-2026")

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./syncdrax.db")
UPLOADS_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)

# -------------------------------------------------------------
# Logging
# -------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("syncdrax")

MAX_PEERS_PER_ROOM = 30

# -------------------------------------------------------------
# Database � SQLModel + SQLite
# -------------------------------------------------------------
# SQLite needs check_same_thread=False; Postgres does not take that arg
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
engine = create_engine(DATABASE_URL, echo=False, connect_args=_connect_args)


class User(SQLModel, table=True):
    id:             Optional[int]  = Field(default=None, primary_key=True)
    name:           str            = Field(index=False)
    email:          str            = Field(index=True, unique=True)
    hashed_password: str
    created_at:     datetime       = Field(default_factory=lambda: datetime.now(timezone.utc))


class Channel(SQLModel, table=True):
    id:          Optional[int] = Field(default=None, primary_key=True)
    name:        str           = Field(index=True)   # e.g. "?? general"
    description: Optional[str] = None
    created_by:  int           = Field(default=0)
    created_at:  datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class ChatMessage(SQLModel, table=True):
    id:            Optional[int] = Field(default=None, primary_key=True)
    channel_id:    Optional[int] = Field(default=None)   # null → DM
    dm_to_user_id: Optional[int] = Field(default=None)
    sender_id:     int
    sender_name:   str
    content:       str           = Field(default="")
    file_url:      Optional[str] = None
    file_name:     Optional[str] = None
    reactions:     str           = Field(default="{}")   # JSON {"😀": [uid,...]}
    pinned:        bool          = Field(default=False)
    parent_id:     Optional[int] = Field(default=None)   # thread parent id
    created_at:    datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class ScheduledMessage(SQLModel, table=True):
    id:            Optional[int] = Field(default=None, primary_key=True)
    sender_id:     int
    sender_name:   str
    channel_id:    Optional[int] = Field(default=None)
    dm_to_user_id: Optional[int] = Field(default=None)
    content:       str
    send_at:       datetime
    sent:          bool          = Field(default=False)
    created_at:    datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


def create_db_tables():
    SQLModel.metadata.create_all(engine)


def migrate_db():
    """Add new columns to existing tables without losing data."""
    import sqlalchemy
    insp = sqlalchemy.inspect(engine)
    tables = insp.get_table_names()
    with engine.begin() as conn:
        if 'chatmessage' in tables:
            existing = {c['name'] for c in insp.get_columns('chatmessage')}
            if 'pinned' not in existing:
                conn.execute(sqlalchemy.text('ALTER TABLE chatmessage ADD COLUMN pinned BOOLEAN DEFAULT FALSE'))
            if 'parent_id' not in existing:
                conn.execute(sqlalchemy.text('ALTER TABLE chatmessage ADD COLUMN parent_id INTEGER DEFAULT NULL'))


def get_session():
    with Session(engine) as session:
        yield session


# -------------------------------------------------------------
# Password hashing
# -------------------------------------------------------------
def hash_password(plain: str) -> str:
    return _bcrypt.hashpw(plain.encode(), _bcrypt.gensalt()).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return _bcrypt.checkpw(plain.encode(), hashed.encode())


# -------------------------------------------------------------
# JWT
# -------------------------------------------------------------
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


# -------------------------------------------------------------
# Pydantic request / response schemas
# -------------------------------------------------------------
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


# -------------------------------------------------------------
# App
# -------------------------------------------------------------
app = FastAPI(title="SyncDrax Signaling Server", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

# Chat WebSocket connections: { user_id: WebSocket }
chat_connections: Dict[int, WebSocket] = {}


@app.on_event("startup")
def on_startup():
    create_db_tables()
    migrate_db()
    log.info("Database ready at %s", DATABASE_URL)
    # Fix corrupted emoji channel names (from PowerShell rename mangling multi-byte chars)
    _DEFAULT_CHANNELS = [
        (1, "\U0001f4e3 general",  "Company-wide announcements and general chat"),
        (2, "\U0001f3b2 random",   "Non-work banter and fun"),
        (3, "\U0001f6e0 dev",      "Engineering discussions"),
        (4, "\U0001f4e2 updates",  "Product and release updates"),
    ]
    with Session(engine) as session:
        existing = session.exec(select(Channel)).all()
        if not existing:
            for _, cname, cdesc in _DEFAULT_CHANNELS:
                session.add(Channel(name=cname, description=cdesc, created_by=0))
            session.commit()
            log.info("Default channels seeded")
        else:
            # Fix any corrupted names (contain replacement char \ufffd or literal ?)
            for ch in existing:
                fix = next((c for c in _DEFAULT_CHANNELS if c[0] == ch.id), None)
                if fix and ('?' in ch.name or '\ufffd' in ch.name):
                    ch.name = fix[1]
                    session.add(ch)
            session.commit()


import asyncio as _asyncio


async def _run_scheduler():
    """Background task: deliver scheduled messages when send_at is reached."""
    while True:
        await _asyncio.sleep(20)
        try:
            now = datetime.now(timezone.utc)
            with Session(engine) as sess:
                pending = sess.exec(
                    select(ScheduledMessage).where(
                        ScheduledMessage.sent == False,  # noqa: E712
                        ScheduledMessage.send_at <= now,
                    )
                ).all()
                for sm in pending:
                    cm = ChatMessage(
                        channel_id=sm.channel_id, dm_to_user_id=sm.dm_to_user_id,
                        sender_id=sm.sender_id, sender_name=sm.sender_name,
                        content=sm.content,
                    )
                    sess.add(cm)
                    sm.sent = True
                    sess.add(sm)
                    sess.commit()
                    sess.refresh(cm)
                    if cm.channel_id:
                        await _chat_broadcast({"type": "channel_message", "message": _msg_dict(cm)})
                    else:
                        p = {"type": "dm", "message": _msg_dict(cm)}
                        await _chat_send(cm.dm_to_user_id, p)
                        await _chat_send(cm.sender_id, p)
        except Exception as exc:
            log.warning("Scheduler error: %s", exc)


@app.on_event("startup")
async def start_scheduler():
    _asyncio.create_task(_run_scheduler())


# -------------------------------------------------------------
# Auth endpoints
# -------------------------------------------------------------
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


# -------------------------------------------------------------
# Admin endpoints
# -------------------------------------------------------------
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


# -------------------------------------------------------------
# Utility endpoints
# -------------------------------------------------------------

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


# -------------------------------------------------------------
@app.get("/health")
async def health():
    return {"status": "ok", "rooms": len(rooms)}


@app.get("/rooms")
async def room_stats():
    return {
        code: {"participants": len(peers)}
        for code, peers in rooms.items()
    }


# -------------------------------------------------------------
@app.websocket("/ws/{room_code}/{peer_id}/{display_name}")
async def ws_endpoint(ws: WebSocket, room_code: str, peer_id: str, display_name: str):
    await ws.accept()
    room_code = room_code.upper()

    # -- Enforce participant limit --
    room_peers = rooms.get(room_code, {})
    if len(room_peers) >= MAX_PEERS_PER_ROOM:
        await safe_send(ws, {"type": "room_full"})
        await ws.close()
        return

    # -- Register peer --
    rooms.setdefault(room_code, {})
    rooms[room_code][peer_id] = {"ws": ws, "name": display_name}
    log.info("[%s] %s joined as '%s'  (total: %d)", room_code, peer_id, display_name, len(rooms[room_code]))

    # -- Send existing peers to new joiner --
    existing = [
        {"id": pid, "name": info["name"]}
        for pid, info in rooms[room_code].items()
        if pid != peer_id
    ]
    await safe_send(ws, {"type": "room_state", "peers": existing})

    # -- Notify existing peers of new joiner --
    await broadcast_to_room(room_code, {
        "type":    "peer_joined",
        "peer_id": peer_id,
        "name":    display_name,
    }, exclude=peer_id)

    # -- Message loop --
    try:
        while True:
            raw = await ws.receive_text()
            msg = json.loads(raw)
            msg_type = msg.get("type", "")

            # -- WebRTC Signaling relay --
            if msg_type in ("offer", "answer", "ice"):
                to_id = msg.get("to_id")
                if to_id and to_id in rooms.get(room_code, {}):
                    relay = {**msg, "from_id": peer_id}
                    await safe_send(rooms[room_code][to_id]["ws"], relay)

            # -- Chat relay --
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
        # -- Clean up --
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


# -------------------------------------------------------------
# Chat helpers
# -------------------------------------------------------------
def _msg_dict(m: ChatMessage) -> dict:
    return {
        "id":            m.id,
        "channel_id":    m.channel_id,
        "dm_to_user_id": m.dm_to_user_id,
        "sender_id":     m.sender_id,
        "sender_name":   m.sender_name,
        "content":       m.content,
        "file_url":      m.file_url,
        "file_name":     m.file_name,
        "reactions":     json.loads(m.reactions or "{}"),
        "pinned":        bool(m.pinned),
        "parent_id":     m.parent_id,
        "ts":            m.created_at.isoformat(),
    }


async def _chat_broadcast(payload: dict, exclude_uid: Optional[int] = None):
    for uid, ws in list(chat_connections.items()):
        if uid == exclude_uid:
            continue
        await safe_send(ws, payload)


async def _chat_send(user_id: int, payload: dict):
    ws = chat_connections.get(user_id)
    if ws:
        await safe_send(ws, payload)


# -------------------------------------------------------------
# Chat Pydantic schemas
# -------------------------------------------------------------
class ChannelCreate(BaseModel):
    name:        str
    description: Optional[str] = None


class ScheduledCreate(BaseModel):
    content:       str
    channel_id:    Optional[int] = None
    dm_to_user_id: Optional[int] = None
    send_at:       str   # ISO-8601 datetime string


# -------------------------------------------------------------
# Chat REST endpoints
# -------------------------------------------------------------
@app.get("/chat/channels")
def list_channels(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    channels = session.exec(select(Channel).order_by(Channel.created_at)).all()
    return [{"id": c.id, "name": c.name, "description": c.description, "created_by": c.created_by} for c in channels]


@app.post("/chat/channels", status_code=201)
def create_channel(
    req: ChannelCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Channel name required")
    ch = Channel(name=name, description=req.description, created_by=current_user.id)
    session.add(ch)
    session.commit()
    session.refresh(ch)
    return {"id": ch.id, "name": ch.name, "description": ch.description, "created_by": ch.created_by}


@app.get("/chat/channels/{channel_id}/messages")
def channel_messages(
    channel_id: int,
    before: Optional[int] = None,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    stmt = select(ChatMessage).where(ChatMessage.channel_id == channel_id)
    if before:
        stmt = stmt.where(ChatMessage.id < before)
    stmt = stmt.order_by(ChatMessage.created_at.desc()).limit(limit)
    msgs = list(session.exec(stmt).all())
    msgs.reverse()
    return [_msg_dict(m) for m in msgs]


@app.get("/chat/users")
def list_chat_users(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    users = session.exec(select(User).where(User.id != current_user.id)).all()
    return [{"id": u.id, "name": u.name} for u in users]


@app.get("/chat/dm/{other_user_id}/messages")
def dm_messages(
    other_user_id: int,
    before: Optional[int] = None,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from sqlalchemy import or_, and_
    stmt = select(ChatMessage).where(
        ChatMessage.channel_id == None,  # noqa: E711
        or_(
            and_(ChatMessage.sender_id == current_user.id, ChatMessage.dm_to_user_id == other_user_id),
            and_(ChatMessage.sender_id == other_user_id,   ChatMessage.dm_to_user_id == current_user.id),
        ),
    )
    if before:
        stmt = stmt.where(ChatMessage.id < before)
    stmt = stmt.order_by(ChatMessage.created_at.desc()).limit(limit)
    msgs = list(session.exec(stmt).all())
    msgs.reverse()
    return [_msg_dict(m) for m in msgs]


@app.post("/chat/upload")
async def upload_file(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    import time as _time
    original = file.filename or "file"
    ext      = os.path.splitext(original)[1].lower()
    allowed  = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt", ".zip", ".mp4", ".mov"}
    safe_ext = ext if ext in allowed else ".bin"
    fname    = f"{current_user.id}_{int(_time.time() * 1000)}{safe_ext}"
    dest     = os.path.join(UPLOADS_DIR, fname)
    with open(dest, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    return {"url": f"/uploads/{fname}", "name": original}


@app.delete("/chat/channels/{channel_id}", status_code=200)
async def delete_channel(
    channel_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ch = session.get(Channel, channel_id)
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    if ch.created_by != current_user.id:
        raise HTTPException(status_code=403, detail="Only the channel owner can delete this channel")
    # Delete all messages in channel first
    msgs = session.exec(select(ChatMessage).where(ChatMessage.channel_id == channel_id)).all()
    for m in msgs:
        session.delete(m)
    session.delete(ch)
    session.commit()
    await _chat_broadcast({"type": "channel_deleted", "channel_id": channel_id})
    return {"ok": True}


# -- Pin / unpin a message --
@app.post("/chat/messages/{msg_id}/pin")
async def toggle_pin(
    msg_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    cm = session.get(ChatMessage, msg_id)
    if not cm:
        raise HTTPException(status_code=404, detail="Message not found")
    # Only the channel owner can pin (DM messages: either participant can pin)
    if cm.channel_id:
        ch = session.get(Channel, cm.channel_id)
        if ch and ch.created_by != 0 and ch.created_by != current_user.id:
            raise HTTPException(status_code=403, detail="Only the channel owner can pin messages")
    cm.pinned = not bool(cm.pinned)
    session.add(cm)
    session.commit()
    await _chat_broadcast({"type": "pin_update", "message_id": msg_id, "pinned": cm.pinned})
    return {"pinned": cm.pinned}


# -- Get pinned messages for a channel --
@app.get("/chat/channels/{channel_id}/pinned")
def pinned_messages(
    channel_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    msgs = session.exec(
        select(ChatMessage).where(
            ChatMessage.channel_id == channel_id,
            ChatMessage.pinned == True,  # noqa: E712
        ).order_by(ChatMessage.created_at)
    ).all()
    return [_msg_dict(m) for m in msgs]


# -- Search messages --
@app.get("/chat/search")
def search_messages(
    q: str = Query(..., min_length=1),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from sqlalchemy import or_
    stmt = select(ChatMessage).where(
        ChatMessage.content.contains(q),
        ChatMessage.parent_id == None,  # noqa: E711  top-level only
    ).order_by(ChatMessage.created_at.desc()).limit(40)
    msgs = session.exec(stmt).all()
    return [_msg_dict(m) for m in msgs]


# -- Get thread replies for a message --
@app.get("/chat/messages/{msg_id}/thread")
def get_thread(
    msg_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    msgs = session.exec(
        select(ChatMessage).where(ChatMessage.parent_id == msg_id)
        .order_by(ChatMessage.created_at)
    ).all()
    return [_msg_dict(m) for m in msgs]


# -- Scheduled messages --
@app.post("/chat/scheduled", status_code=201)
def create_scheduled(
    req: ScheduledCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not req.content.strip():
        raise HTTPException(status_code=400, detail="Content required")
    try:
        send_at = datetime.fromisoformat(req.send_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid send_at datetime")
    if send_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="send_at must be in the future")
    sm = ScheduledMessage(
        sender_id=current_user.id, sender_name=current_user.name,
        channel_id=req.channel_id, dm_to_user_id=req.dm_to_user_id,
        content=req.content.strip(), send_at=send_at,
    )
    session.add(sm); session.commit(); session.refresh(sm)
    return {"id": sm.id, "content": sm.content, "send_at": sm.send_at.isoformat()}


@app.get("/chat/scheduled")
def list_scheduled(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    msgs = session.exec(
        select(ScheduledMessage).where(
            ScheduledMessage.sender_id == current_user.id,
            ScheduledMessage.sent == False,  # noqa: E712
        ).order_by(ScheduledMessage.send_at)
    ).all()
    return [{"id": m.id, "content": m.content, "send_at": m.send_at.isoformat(),
             "channel_id": m.channel_id, "dm_to_user_id": m.dm_to_user_id} for m in msgs]


@app.delete("/chat/scheduled/{sm_id}")
def cancel_scheduled(
    sm_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    sm = session.get(ScheduledMessage, sm_id)
    if not sm or sm.sender_id != current_user.id:
        raise HTTPException(status_code=404, detail="Not found")
    session.delete(sm); session.commit()
    return {"ok": True}


# -------------------------------------------------------------
# Chat WebSocket
# -------------------------------------------------------------
@app.websocket("/ws/chat/{user_id}")
async def chat_ws(ws: WebSocket, user_id: int, token: str = Query(...)):
    # Authenticate via token query param
    try:
        payload = decode_token(token)
        if int(payload["sub"]) != user_id:
            await ws.close(code=4001)
            return
    except Exception:
        await ws.close(code=4001)
        return

    await ws.accept()
    chat_connections[user_id] = ws
    log.info("[chat] user %d connected  (total online: %d)", user_id, len(chat_connections))

    with Session(engine) as session:
        db_user = session.get(User, user_id)
        uname   = db_user.name if db_user else f"User{user_id}"

    await _chat_broadcast({"type": "presence", "user_id": user_id, "online": True}, exclude_uid=user_id)

    try:
        while True:
            raw   = await ws.receive_text()
            msg   = json.loads(raw)
            mtype = msg.get("type")

            # -- Channel message --
            if mtype == "channel_message":
                channel_id = msg.get("channel_id")
                content    = (msg.get("content") or "").strip()
                file_url   = msg.get("file_url")
                file_name  = msg.get("file_name")
                if not content and not file_url:
                    continue
                with Session(engine) as session:
                    cm = ChatMessage(
                        channel_id=channel_id, sender_id=user_id, sender_name=uname,
                        content=content, file_url=file_url, file_name=file_name,
                    )
                    session.add(cm); session.commit(); session.refresh(cm)
                await _chat_broadcast({"type": "channel_message", "message": _msg_dict(cm)})

            # -- Direct message --
            elif mtype == "dm":
                to_uid    = msg.get("to_user_id")
                content   = (msg.get("content") or "").strip()
                file_url  = msg.get("file_url")
                file_name = msg.get("file_name")
                if not content and not file_url:
                    continue
                with Session(engine) as session:
                    cm = ChatMessage(
                        channel_id=None, dm_to_user_id=to_uid,
                        sender_id=user_id, sender_name=uname,
                        content=content, file_url=file_url, file_name=file_name,
                    )
                    session.add(cm); session.commit(); session.refresh(cm)
                dm_payload = {"type": "dm", "message": _msg_dict(cm)}
                await _chat_send(to_uid, dm_payload)
                await _chat_send(user_id, dm_payload)

            # -- Typing indicator --
            elif mtype == "typing":
                channel_id = msg.get("channel_id")
                to_uid     = msg.get("to_user_id")
                tpl        = {"type": "typing", "user_id": user_id, "user_name": uname}
                if channel_id:
                    tpl["channel_id"] = channel_id
                    await _chat_broadcast(tpl, exclude_uid=user_id)
                elif to_uid:
                    tpl["to_user_id"] = to_uid
                    await _chat_send(to_uid, tpl)

            # -- Emoji reaction --
            elif mtype == "react":
                msg_id = msg.get("message_id")
                emoji  = msg.get("emoji", "")
                if not emoji or not msg_id:
                    continue
                with Session(engine) as session:
                    cm = session.get(ChatMessage, msg_id)
                    if not cm:
                        continue
                    reacts = json.loads(cm.reactions or "{}")
                    lst    = reacts.get(emoji, [])
                    if user_id in lst:
                        lst.remove(user_id)
                    else:
                        lst.append(user_id)
                    if lst:
                        reacts[emoji] = lst
                    elif emoji in reacts:
                        del reacts[emoji]
                    cm.reactions = json.dumps(reacts)
                    session.add(cm); session.commit()
                await _chat_broadcast({"type": "reaction_update", "message_id": msg_id, "reactions": reacts})

            # -- Thread reply --
            elif mtype == "thread_reply":
                parent_id  = msg.get("parent_id")
                content    = (msg.get("content") or "").strip()
                channel_id = msg.get("channel_id")
                dm_uid     = msg.get("dm_to_user_id")
                if not content or not parent_id:
                    continue
                with Session(engine) as session:
                    cm = ChatMessage(
                        channel_id=channel_id, dm_to_user_id=dm_uid,
                        sender_id=user_id, sender_name=uname,
                        content=content, parent_id=parent_id,
                    )
                    session.add(cm); session.commit(); session.refresh(cm)
                await _chat_broadcast({"type": "thread_reply", "message": _msg_dict(cm)})

    except (WebSocketDisconnect, Exception) as exc:
        if not isinstance(exc, WebSocketDisconnect):
            log.warning("[chat] user %d error: %s", user_id, exc)
    finally:
        chat_connections.pop(user_id, None)
        log.info("[chat] user %d disconnected", user_id)
        await _chat_broadcast({"type": "presence", "user_id": user_id, "online": False})
