"""
SyncTact � Signaling Server + Auth API
Built with FastAPI + uvicorn + SQLModel

Run:
    pip install -r requirements.txt
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Endpoints:
    WS   /ws/{room_code}/{peer_id}/{display_name}   � WebRTC signaling
    POST /auth/verify-and-signup                    � Create account
    POST /auth/signin                               � Sign in, get JWT
    GET  /auth/me                                   � Get current user
    GET  /health                                    � Health check
    GET  /rooms                                     � Active room stats
"""

import asyncio
import base64
import csv
import hashlib
import io
import json
import logging
import os
import re
import secrets
import smtplib
import shutil
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Dict, List, Optional

import httpx
import pyotp
import qrcode
from bs4 import BeautifulSoup
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from starlette.requests import Request
from starlette.responses import StreamingResponse

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, status, UploadFile, File, Query, Header
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
# Without SECRET_KEY a random key is used, so tokens stop working on every restart.
SECRET_KEY        = os.getenv("SECRET_KEY") or secrets.token_urlsafe(48)
ALGORITHM        = "HS256"
TOKEN_EXPIRE_DAYS = 30
# Without ADMIN_KEY the admin-key endpoints are disabled.
ADMIN_KEY         = os.getenv("ADMIN_KEY", "")
MAX_UPLOAD_BYTES  = 25 * 1024 * 1024
GEMINI_API_KEY    = os.getenv("Syntact_Key") or os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL      = os.getenv("GEMINI_MODEL", "gemini-flash-latest")
# Tried when the main model is overloaded or rate-limited; set to "" to disable.
GEMINI_FALLBACK_MODEL = os.getenv("GEMINI_FALLBACK_MODEL", "gemini-flash-lite-latest")
GEMINI_API_BASE   = "https://generativelanguage.googleapis.com/v1beta/models"

# Email delivery (daily digest). The first configured provider is used: Resend, Brevo, then SMTP.
# Render's free instances block outbound SMTP ports, so use an HTTPS API provider there.
RESEND_API_KEY = os.getenv("RESEND_API_KEY", "")
BREVO_API_KEY  = os.getenv("BREVO_API_KEY", "")
SMTP_HOST      = os.getenv("SMTP_HOST", "smtp.gmail.com")
SMTP_PORT      = int(os.getenv("SMTP_PORT", "587"))
SMTP_USER      = os.getenv("SMTP_USER", "")
SMTP_PASSWORD  = os.getenv("SMTP_PASSWORD", "")
FROM_EMAIL     = os.getenv("FROM_EMAIL") or SMTP_USER or ("onboarding@resend.dev" if RESEND_API_KEY else "")
FROM_NAME      = os.getenv("FROM_NAME", "SyncTact")

# Video calls between different networks need a TURN relay. Either:
#   METERED_TURN_DOMAIN + METERED_TURN_API_KEY  (free 20 GB/month at metered.ca), or
#   TURN_URLS (comma-separated) + TURN_USERNAME + TURN_CREDENTIAL  (Twilio, coturn, ...)
METERED_TURN_DOMAIN  = os.getenv("METERED_TURN_DOMAIN", "").strip().removeprefix("https://").strip("/")
METERED_TURN_API_KEY = os.getenv("METERED_TURN_API_KEY", "").strip()
TURN_URLS            = os.getenv("TURN_URLS", "").strip()
TURN_USERNAME        = os.getenv("TURN_USERNAME", "").strip()
TURN_CREDENTIAL      = os.getenv("TURN_CREDENTIAL", "").strip()

# On Render's free plan the local disk is wiped on every deploy/restart, so production needs
# DATABASE_URL pointing at a hosted Postgres (Neon, Supabase, Render Postgres, ...).
DATABASE_URL = os.getenv("DATABASE_URL", "").strip() or "sqlite:///./synctact.db"
# Hosts hand out postgres:// URLs; SQLAlchemy needs a dialect name, and 2.1+ defaults to psycopg 3
# while requirements.txt installs psycopg2.
for _prefix in ("postgres://", "postgresql://"):
    if DATABASE_URL.startswith(_prefix):
        DATABASE_URL = "postgresql+psycopg2://" + DATABASE_URL[len(_prefix):]
UPLOADS_DIR  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "uploads")
os.makedirs(UPLOADS_DIR, exist_ok=True)


# -------------------------------------------------------------
# Logging
# -------------------------------------------------------------
logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("synctact")

MAX_PEERS_PER_ROOM = 30

# -------------------------------------------------------------
# Database � SQLModel + SQLite
# -------------------------------------------------------------
# SQLite needs check_same_thread=False; Postgres does not take that arg
_connect_args = {"check_same_thread": False} if DATABASE_URL.startswith("sqlite") else {}
# pre_ping: hosted Postgres closes idle connections (and Neon suspends idle databases)
engine = create_engine(DATABASE_URL, echo=False, connect_args=_connect_args, pool_pre_ping=True)


class User(SQLModel, table=True):
    id:              Optional[int]  = Field(default=None, primary_key=True)
    name:            str            = Field(index=False)
    email:           str            = Field(index=True, unique=True)
    hashed_password: str
    banned:          bool           = Field(default=False)
    avatar_url:      Optional[str]  = Field(default=None)       # /uploads/avatars/...
    status:          Optional[str]  = Field(default=None)       # status message
    bio:             Optional[str]  = Field(default=None)       # short bio
    role:            str            = Field(default='member')   # 'admin'|'moderator'|'member'
    presence:        str            = Field(default='online')   # 'online'|'away'|'dnd'|'offline'
    totp_secret:     Optional[str]  = Field(default=None)
    totp_enabled:    bool           = Field(default=False)
    title:           Optional[str]  = Field(default=None)       # custom title e.g. "CEO & Founder"
    created_at:      datetime       = Field(default_factory=lambda: datetime.now(timezone.utc))


class Channel(SQLModel, table=True):
    id:               Optional[int] = Field(default=None, primary_key=True)
    name:             str           = Field(index=True)
    description:      Optional[str] = None
    created_by:       int           = Field(default=0)
    slowmode_seconds: int           = Field(default=0)
    category_id:      Optional[int] = Field(default=None)
    welcome_message:  Optional[str] = Field(default=None)
    readonly:         bool          = Field(default=False)   # only mods/admins can post
    archived:         bool          = Field(default=False)   # soft-archived
    channel_type:     str           = Field(default='text')  # text | moodboard
    server_id:        Optional[int] = Field(default=None, index=True)
    created_at:       datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class ChatMessage(SQLModel, table=True):
    id:            Optional[int]      = Field(default=None, primary_key=True)
    channel_id:    Optional[int]      = Field(default=None)   # null → DM
    dm_to_user_id: Optional[int]      = Field(default=None)
    sender_id:     int
    sender_name:   str
    content:       str                = Field(default="")
    file_url:      Optional[str]      = None
    file_name:     Optional[str]      = None
    reactions:     str                = Field(default="{}")   # JSON {"😀": [uid,...]}
    pinned:        bool               = Field(default=False)
    parent_id:     Optional[int]      = Field(default=None)   # thread parent id
    bot_name:      Optional[str]      = Field(default=None)   # set for bot/webhook messages
    edited:        bool               = Field(default=False)
    edited_at:     Optional[datetime] = Field(default=None)
    forwarded_from: Optional[int]     = Field(default=None)   # original message id
    created_at:    datetime           = Field(default_factory=lambda: datetime.now(timezone.utc))


class Poll(SQLModel, table=True):
    id:            Optional[int] = Field(default=None, primary_key=True)
    creator_id:    int
    creator_name:  str
    question:      str
    options_json:  str            # JSON array of option strings
    channel_id:    Optional[int] = Field(default=None)
    dm_to_user_id: Optional[int] = Field(default=None)
    created_at:    datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class PollVote(SQLModel, table=True):
    id:           Optional[int] = Field(default=None, primary_key=True)
    poll_id:      int           = Field(index=True)
    user_id:      int
    option_index: int
    created_at:   datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


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


class Bot(SQLModel, table=True):
    id:            Optional[int] = Field(default=None, primary_key=True)
    owner_id:      int
    name:          str
    avatar:        str           = Field(default="🤖")
    webhook_token: str           = Field(index=True)
    created_at:    datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class RecurringTask(SQLModel, table=True):
    id:               Optional[int]      = Field(default=None, primary_key=True)
    owner_id:         int
    channel_id:       Optional[int]      = Field(default=None)
    message:          str
    interval_minutes: int                = Field(default=60)   # how often to post
    last_run:         Optional[datetime] = Field(default=None) # last time it fired
    active:           bool               = Field(default=True)
    open_url:         Optional[str]      = Field(default=None)   # browser URL to auto-open when task fires
    url_target:       str                = Field(default="self")  # "self" = only owner | "channel" = everyone (channel owner only)
    created_at:       datetime           = Field(default_factory=lambda: datetime.now(timezone.utc))


class Bookmark(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    user_id:    int           = Field(index=True)
    message_id: int
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class ChannelCategory(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    name:       str
    created_by: int
    position:   int           = Field(default=0)
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class ChannelCategoryLink(SQLModel, table=True):
    id:          Optional[int] = Field(default=None, primary_key=True)
    category_id: int           = Field(index=True)
    channel_id:  int           = Field(index=True)


class ChatServer(SQLModel, table=True):
    """A Discord-style server. is_home is the shared one everyone belongs to."""
    id:         Optional[int] = Field(default=None, primary_key=True)
    name:       str
    owner_id:   int           = Field(default=0)
    is_home:    bool          = Field(default=False)
    icon_url:   Optional[str] = Field(default=None)
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class ServerMember(SQLModel, table=True):
    id:        Optional[int] = Field(default=None, primary_key=True)
    server_id: int           = Field(index=True)
    user_id:   int           = Field(index=True)
    role:      str           = Field(default="member")   # 'owner' | 'member'
    joined_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class InviteLink(SQLModel, table=True):
    id:         Optional[int]      = Field(default=None, primary_key=True)
    code:       str                = Field(index=True, unique=True)
    channel_id: Optional[int]      = Field(default=None)   # None = server-wide invite
    server_id:  Optional[int]      = Field(default=None, index=True)
    created_by: int
    uses:       int                = Field(default=0)
    max_uses:   Optional[int]      = Field(default=None)   # None = unlimited
    expires_at: Optional[datetime] = Field(default=None)
    created_at: datetime           = Field(default_factory=lambda: datetime.now(timezone.utc))


# ── Moderation models ─────────────────────────────────────────────────────────

class MutedUser(SQLModel, table=True):
    id:          Optional[int]      = Field(default=None, primary_key=True)
    user_id:     int                = Field(index=True)
    channel_id:  Optional[int]      = Field(default=None)  # None = all channels
    muted_until: Optional[datetime] = Field(default=None)  # None = permanent
    muted_by:    int
    created_at:  datetime           = Field(default_factory=lambda: datetime.now(timezone.utc))


class KickedUser(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    user_id:    int           = Field(index=True)
    channel_id: int
    kicked_by:  int
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class BadWord(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    word:       str           = Field(index=True)
    added_by:   int
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class AuditLog(SQLModel, table=True):
    id:               Optional[int] = Field(default=None, primary_key=True)
    action:           str
    actor_id:         int
    actor_name:       str
    target_user_id:   Optional[int] = Field(default=None)
    target_user_name: Optional[str] = Field(default=None)
    channel_id:       Optional[int] = Field(default=None)
    detail:           Optional[str] = Field(default=None)
    created_at:       datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserXP(SQLModel, table=True):
    id:       Optional[int] = Field(default=None, primary_key=True)
    user_id:  int           = Field(index=True, unique=True)
    xp:       int           = Field(default=0)
    level:    int           = Field(default=1)
    updated_at: datetime    = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserWarning(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    user_id:    int           = Field(index=True)
    user_name:  str
    reason:     str
    warned_by:  int
    warned_by_name: str
    channel_id: Optional[int] = Field(default=None)
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserSession(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    user_id:    int           = Field(index=True)
    token_hash: str           = Field(index=True)
    device:     Optional[str] = Field(default=None)
    ip_addr:    Optional[str] = Field(default=None)
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_used:  datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))
    active:     bool          = Field(default=True)


class WebhookConfig(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    channel_id: int           = Field(index=True)
    name:       str
    token:      str           = Field(index=True)
    created_by: int
    active:     bool          = Field(default=True)
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class ChannelRole(SQLModel, table=True):
    id:          Optional[int] = Field(default=None, primary_key=True)
    channel_id:  int           = Field(index=True)
    user_id:     int           = Field(index=True)
    role:        str           = Field(default='member')
    assigned_by: int
    created_at:  datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class ServerSetting(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    key:        str           = Field(index=True, unique=True)
    value:      str           = Field(default='')
    updated_by: Optional[int] = Field(default=None)
    updated_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class UserBlock(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    blocker_id: int           = Field(index=True)
    blocked_id: int           = Field(index=True)
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class MessageTemplate(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    user_id:    int           = Field(index=True)
    title:      str
    content:    str
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class Reminder(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    user_id:    int           = Field(index=True)
    channel_id: Optional[int] = Field(default=None)
    content:    str
    remind_at:  datetime
    sent:       bool          = Field(default=False)
    created_at: datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class CalendarEvent(SQLModel, table=True):
    id:          Optional[int] = Field(default=None, primary_key=True)
    channel_id:  Optional[int] = Field(default=None, index=True)
    creator_id:  int
    creator_name: str
    title:        str
    description:  Optional[str] = Field(default=None)
    starts_at:    datetime
    ends_at:      Optional[datetime] = Field(default=None)
    created_at:   datetime      = Field(default_factory=lambda: datetime.now(timezone.utc))


class CalendarEventRsvp(SQLModel, table=True):
    id:       Optional[int] = Field(default=None, primary_key=True)
    event_id: int           = Field(index=True)
    user_id:  int
    name:     str
    status:   str           = Field(default='yes')  # yes|no|maybe
    created_at: datetime    = Field(default_factory=lambda: datetime.now(timezone.utc))


class Task(SQLModel, table=True):
    id:           Optional[int]      = Field(default=None, primary_key=True)
    channel_id:   Optional[int]      = Field(default=None, index=True)
    creator_id:   int
    creator_name: str
    title:        str
    description:  Optional[str]      = Field(default=None)
    assignee_id:  Optional[int]      = Field(default=None)
    assignee_name: Optional[str]     = Field(default=None)
    status:       str                = Field(default='todo')  # todo | doing | done
    created_at:   datetime           = Field(default_factory=lambda: datetime.now(timezone.utc))


def create_db_tables():
    SQLModel.metadata.create_all(engine)


def migrate_db():
    """Add new columns to existing tables without losing data."""
    import sqlalchemy
    insp = sqlalchemy.inspect(engine)
    tables = insp.get_table_names()
    quote = engine.dialect.identifier_preparer.quote   # "user" is a reserved word in Postgres

    def _ddl(ddl: str) -> str:
        _, _, table, rest = ddl.split(" ", 3)            # "ALTER TABLE <table> ADD COLUMN ..."
        if engine.dialect.name != "sqlite":
            rest = rest.replace(" DATETIME ", " TIMESTAMP ")
        return f"ALTER TABLE {quote(table)} {rest}"

    with engine.begin() as conn:
        if 'chatmessage' in tables:
            existing = {c['name'] for c in insp.get_columns('chatmessage')}
            for col, ddl in [
                ('pinned',         'ALTER TABLE chatmessage ADD COLUMN pinned BOOLEAN DEFAULT FALSE'),
                ('parent_id',      'ALTER TABLE chatmessage ADD COLUMN parent_id INTEGER DEFAULT NULL'),
                ('bot_name',       'ALTER TABLE chatmessage ADD COLUMN bot_name VARCHAR DEFAULT NULL'),
                ('edited',         'ALTER TABLE chatmessage ADD COLUMN edited BOOLEAN DEFAULT FALSE'),
                ('edited_at',      'ALTER TABLE chatmessage ADD COLUMN edited_at DATETIME DEFAULT NULL'),
                ('forwarded_from', 'ALTER TABLE chatmessage ADD COLUMN forwarded_from INTEGER DEFAULT NULL'),
            ]:
                if col not in existing:
                    conn.execute(sqlalchemy.text(_ddl(ddl)))
        if 'user' in tables:
            existing = {c['name'] for c in insp.get_columns('user')}
            for col, ddl in [
                ('banned',       'ALTER TABLE user ADD COLUMN banned BOOLEAN DEFAULT FALSE'),
                ('avatar_url',   'ALTER TABLE user ADD COLUMN avatar_url VARCHAR DEFAULT NULL'),
                ('status',       'ALTER TABLE user ADD COLUMN status VARCHAR DEFAULT NULL'),
                ('bio',          'ALTER TABLE user ADD COLUMN bio VARCHAR DEFAULT NULL'),
                ('role',         "ALTER TABLE user ADD COLUMN role VARCHAR DEFAULT 'member'"),
                ('presence',     "ALTER TABLE user ADD COLUMN presence VARCHAR DEFAULT 'online'"),
                ('totp_secret',  'ALTER TABLE user ADD COLUMN totp_secret VARCHAR DEFAULT NULL'),
                ('totp_enabled', 'ALTER TABLE user ADD COLUMN totp_enabled BOOLEAN DEFAULT FALSE'),
                ('title',        'ALTER TABLE user ADD COLUMN title VARCHAR DEFAULT NULL'),
            ]:
                if col not in existing:
                    conn.execute(sqlalchemy.text(_ddl(ddl)))
        if 'channel' in tables:
            existing = {c['name'] for c in insp.get_columns('channel')}
            for col, ddl in [
                ('slowmode_seconds', 'ALTER TABLE channel ADD COLUMN slowmode_seconds INTEGER DEFAULT 0'),
                ('category_id',      'ALTER TABLE channel ADD COLUMN category_id INTEGER DEFAULT NULL'),
                ('welcome_message',  'ALTER TABLE channel ADD COLUMN welcome_message VARCHAR DEFAULT NULL'),
                ('readonly',         'ALTER TABLE channel ADD COLUMN readonly BOOLEAN DEFAULT FALSE'),
                ('archived',         'ALTER TABLE channel ADD COLUMN archived BOOLEAN DEFAULT FALSE'),
                ('channel_type',      "ALTER TABLE channel ADD COLUMN channel_type VARCHAR DEFAULT 'text'"),
                ('server_id',         'ALTER TABLE channel ADD COLUMN server_id INTEGER DEFAULT NULL'),
            ]:
                if col not in existing:
                    conn.execute(sqlalchemy.text(_ddl(ddl)))
        if 'chatserver' in tables:
            existing = {c['name'] for c in insp.get_columns('chatserver')}
            if 'icon_url' not in existing:
                conn.execute(sqlalchemy.text(_ddl(
                    'ALTER TABLE chatserver ADD COLUMN icon_url VARCHAR DEFAULT NULL')))
        if 'invitelink' in tables:
            existing = {c['name'] for c in insp.get_columns('invitelink')}
            if 'server_id' not in existing:
                conn.execute(sqlalchemy.text(_ddl(
                    'ALTER TABLE invitelink ADD COLUMN server_id INTEGER DEFAULT NULL')))
        # UserXP table is created by SQLModel create_all; no manual column migration needed
        # UserWarning table likewise created by create_all


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


def email_provider() -> Optional[str]:
    if RESEND_API_KEY:
        return "resend"
    if BREVO_API_KEY and FROM_EMAIL:
        return "brevo"
    if SMTP_USER and SMTP_PASSWORD:
        return "smtp"
    return None


def send_email(to_email: str, subject: str, text_body: str, html_body: Optional[str] = None) -> bool:
    """Send one email through the configured provider. Returns True on success."""
    provider = email_provider()
    if not provider:
        log.warning("Email delivery not configured — skipping email to %s", to_email)
        return False
    try:
        if provider == "resend":
            r = httpx.post(
                "https://api.resend.com/emails",
                headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
                json={"from": f"{FROM_NAME} <{FROM_EMAIL}>", "to": [to_email], "subject": subject,
                      "text": text_body, **({"html": html_body} if html_body else {})},
                timeout=15,
            )
            r.raise_for_status()
        elif provider == "brevo":
            r = httpx.post(
                "https://api.brevo.com/v3/smtp/email",
                headers={"api-key": BREVO_API_KEY, "accept": "application/json"},
                json={"sender": {"name": FROM_NAME, "email": FROM_EMAIL}, "to": [{"email": to_email}],
                      "subject": subject, "textContent": text_body,
                      **({"htmlContent": html_body} if html_body else {})},
                timeout=15,
            )
            r.raise_for_status()
        else:
            msg = MIMEMultipart("alternative")
            msg["Subject"] = subject
            msg["From"] = f"{FROM_NAME} <{FROM_EMAIL}>"
            msg["To"] = to_email
            msg.attach(MIMEText(text_body, "plain"))
            if html_body:
                msg.attach(MIMEText(html_body, "html"))
            if SMTP_PORT == 465:
                with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                    server.login(SMTP_USER, SMTP_PASSWORD)
                    server.sendmail(FROM_EMAIL, to_email, msg.as_string())
            else:
                with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15) as server:
                    server.starttls()
                    server.login(SMTP_USER, SMTP_PASSWORD)
                    server.sendmail(FROM_EMAIL, to_email, msg.as_string())
        log.info("Email sent to %s via %s", to_email, provider)
        return True
    except httpx.HTTPStatusError as e:
        log.error("Email to %s via %s rejected: %s %s", to_email, provider, e.response.status_code, e.response.text[:300])
    except Exception as e:
        log.error("Failed to send email to %s via %s: %s", to_email, provider, e)
    return False



# -------------------------------------------------------------
# Volt AI assistant
# -------------------------------------------------------------
VOLT_EMAIL = "volt@bot.synctact.internal"
VOLT_USER_ID: Optional[int] = None
_volt_busy: set = set()   # user ids with a Volt reply in progress (one AI call per user at a time)
VOLT_SYSTEM_PROMPT = (
    "You are Volt, the friendly AI assistant built into SyncTact, a team chat and video meeting app. "
    "Answer clearly and concisely. Use Markdown (bold, lists, `code`, fenced code blocks) when it helps."
)


def _ensure_volt_user() -> None:
    """Volt is a real (non-loginable) account so people can DM it like anyone else."""
    global VOLT_USER_ID
    with Session(engine) as s:
        u = s.exec(select(User).where(User.email == VOLT_EMAIL)).first()
        if not u:
            # A random bcrypt hash that no password matches
            u = User(name="Volt", email=VOLT_EMAIL, hashed_password=hash_password(secrets.token_urlsafe(32)),
                     role="bot", status="AI assistant — ask me anything", title="Bot")
            s.add(u); s.commit(); s.refresh(u)
            log.info("Created Volt bot account (id %d)", u.id)
        VOLT_USER_ID = u.id


class GeminiError(Exception):
    def __init__(self, message: str, busy: bool = False):
        super().__init__(message)
        self.busy = busy   # overloaded / rate-limited rather than misconfigured


_GEMINI_RETRYABLE = {429, 500, 502, 503, 504}


async def gemini_generate(contents: list, system: Optional[str] = None) -> str:
    """Call Gemini, retrying temporary overloads and then trying the fallback model.

    contents: list of {"role": "user"|"model", "parts": [{"text": ...}]}. Raises GeminiError.
    """
    if not GEMINI_API_KEY:
        raise GeminiError("AI is not configured \u2014 set the `GEMINI_API_KEY` (or `Syntact_Key`) "
                          "environment variable on the server.")
    body = {"contents": contents}
    if system:
        body["system_instruction"] = {"parts": [{"text": system}]}
    models = [GEMINI_MODEL] + ([GEMINI_FALLBACK_MODEL] if GEMINI_FALLBACK_MODEL and GEMINI_FALLBACK_MODEL != GEMINI_MODEL else [])
    last_error, busy = "unknown error", False
    async with httpx.AsyncClient(timeout=30) as hc:
        for model in models:
            for attempt in range(2):
                try:
                    r = await hc.post(f"{GEMINI_API_BASE}/{model}:generateContent",
                                      headers={"x-goog-api-key": GEMINI_API_KEY}, json=body)
                except httpx.HTTPError as e:
                    log.warning("Gemini %s network error: %s", model, e)
                    last_error, busy = "couldn't reach the AI service", True
                else:
                    if r.status_code == 200:
                        cand = (r.json().get("candidates") or [{}])[0]
                        return "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", [])).strip()
                    try:
                        detail = r.json().get("error", {}).get("message", "unknown error")
                    except ValueError:
                        detail = "unknown error"
                    log.warning("Gemini %s error %d: %s", model, r.status_code, detail[:300])
                    last_error = f"Gemini API error {r.status_code} \u2014 {detail}"
                    busy = r.status_code in _GEMINI_RETRYABLE
                    if not busy:
                        raise GeminiError(last_error)
                if attempt == 0:
                    await asyncio.sleep(1.5)
    raise GeminiError(last_error, busy=busy)


async def _volt_generate(contents: list, system: str = VOLT_SYSTEM_PROMPT) -> str:
    """Like gemini_generate, but always returns text to show the user."""
    try:
        text = await gemini_generate(contents, system)
    except GeminiError as e:
        if e.busy:
            return "\u26a1 Volt: The AI service is busy right now. Please try again in a minute."
        return f"\u26a1 Volt: {e}"
    return text[:4000] or "\u26a1 Volt: I couldn't come up with a reply to that \u2014 try rephrasing?"


async def _volt_dm_reply(user_id: int) -> None:
    """Answer the latest message in a user's private conversation with Volt."""
    if user_id in _volt_busy:
        return
    _volt_busy.add(user_id)
    try:
        # Messages sent while a reply was being generated get answered in the next round.
        for _ in range(3):
            await _volt_dm_reply_inner(user_id)
            with Session(engine) as s:
                last = s.exec(
                    select(ChatMessage).where(
                        ChatMessage.channel_id == None,  # noqa: E711
                        ((ChatMessage.sender_id == user_id) & (ChatMessage.dm_to_user_id == VOLT_USER_ID)) |
                        ((ChatMessage.sender_id == VOLT_USER_ID) & (ChatMessage.dm_to_user_id == user_id)),
                    ).order_by(ChatMessage.id.desc()).limit(1)
                ).first()
            if not last or last.sender_id == VOLT_USER_ID or not last.content:
                break
    finally:
        _volt_busy.discard(user_id)


async def _volt_send_typing(user_id: int) -> None:
    await _chat_send(user_id, {"type": "typing", "user_id": VOLT_USER_ID, "user_name": "Volt",
                               "to_user_id": user_id})


async def _volt_typing(user_id: int) -> None:
    # The client clears "is typing" after 3 s, so keep refreshing it while the AI works.
    while True:
        await asyncio.sleep(2.5)
        await _volt_send_typing(user_id)


async def _volt_dm_reply_inner(user_id: int) -> None:
    await _volt_send_typing(user_id)
    typing = asyncio.create_task(_volt_typing(user_id))
    try:
        await _volt_dm_reply_generate(user_id)
    finally:
        typing.cancel()


async def _volt_dm_reply_generate(user_id: int) -> None:
    with Session(engine) as s:
        from sqlalchemy import or_, and_
        hist = s.exec(
            select(ChatMessage).where(
                ChatMessage.channel_id == None,  # noqa: E711
                or_(and_(ChatMessage.sender_id == user_id, ChatMessage.dm_to_user_id == VOLT_USER_ID),
                    and_(ChatMessage.sender_id == VOLT_USER_ID, ChatMessage.dm_to_user_id == user_id)),
            ).order_by(ChatMessage.created_at.desc()).limit(20)
        ).all()
    contents = []
    for m in reversed(hist):
        if not m.content:
            continue
        role = "model" if m.sender_id == VOLT_USER_ID else "user"
        if contents and contents[-1]["role"] == role:
            contents[-1]["parts"][0]["text"] += "\n" + m.content
        else:
            contents.append({"role": role, "parts": [{"text": m.content}]})
    while contents and contents[0]["role"] != "user":
        contents.pop(0)
    if not contents:
        return
    reply = await _volt_generate(contents)
    with Session(engine) as s:
        cm = ChatMessage(channel_id=None, dm_to_user_id=user_id, sender_id=VOLT_USER_ID,
                         sender_name="Volt", content=reply, bot_name="Volt")
        s.add(cm); s.commit(); s.refresh(cm)
        d = _msg_dict(cm)
    await _chat_send(user_id, {"type": "dm", "message": d})


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
    user = _user_for_token(creds.credentials, session)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if user.banned:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account banned")
    return user


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _user_for_token(token: str, session: Session) -> Optional[User]:
    """Return the user for a valid JWT whose session has not been revoked."""
    try:
        user_id = int(decode_token(token)["sub"])
    except (JWTError, KeyError, ValueError):
        return None
    active = session.exec(select(UserSession).where(
        UserSession.token_hash == _token_hash(token),
        UserSession.user_id == user_id,
        UserSession.active == True,  # noqa: E712
    )).first()
    if not active:
        return None
    return session.get(User, user_id)


def _is_staff(user: User) -> bool:
    return getattr(user, "role", "member") in ("admin", "moderator")


def _can_manage_channel(user: User, ch: Optional["Channel"]) -> bool:
    """Staff can manage any channel; owners can manage their own. System channels (created_by=0) are staff-only."""
    if not ch:
        return False
    return _is_staff(user) or (ch.created_by != 0 and ch.created_by == user.id)


def _can_view_message(user: User, cm: "ChatMessage") -> bool:
    if cm.channel_id is not None:
        return True
    return user.id in (cm.sender_id, cm.dm_to_user_id)


def _server_dict(srv: "ChatServer", role: str) -> dict:
    return {"id": srv.id, "name": srv.name, "owner_id": srv.owner_id,
            "is_home": srv.is_home, "role": role, "icon_url": srv.icon_url}


def _join_server(session: Session, server_id: int, user_id: int, role: str = "member") -> bool:
    """Add a membership if there isn't one. Returns True when a row was added."""
    existing = session.exec(select(ServerMember).where(
        ServerMember.server_id == server_id, ServerMember.user_id == user_id)).first()
    if existing:
        return False
    session.add(ServerMember(server_id=server_id, user_id=user_id, role=role))
    return True


def _is_server_member(session: Session, user_id: int, server_id: Optional[int]) -> bool:
    """True if the user belongs to the server. The home server auto-joins any signed-in user."""
    if not server_id:
        return True
    if session.exec(select(ServerMember).where(
            ServerMember.server_id == server_id, ServerMember.user_id == user_id)).first():
        return True
    srv = session.get(ChatServer, server_id)
    if srv and srv.is_home and user_id:
        _join_server(session, server_id, user_id)
        session.commit()
        return True
    return False


def _my_server_ids(session: Session, user_id: int) -> set:
    home = session.exec(select(ChatServer).where(ChatServer.is_home == True)).first()  # noqa: E712
    if home:
        _is_server_member(session, user_id, home.id)
    return set(session.exec(select(ServerMember.server_id).where(ServerMember.user_id == user_id)).all())


def _ensure_home_server() -> None:
    """Put pre-existing channels into a shared home server so they aren't left ownerless."""
    with Session(engine) as session:
        home = session.exec(select(ChatServer).where(ChatServer.is_home == True)).first()  # noqa: E712
        orphans = session.exec(select(Channel).where(Channel.server_id == None)).all()  # noqa: E711
        if not home and not orphans:
            return
        if not home:
            first = session.exec(select(User).where(User.role != "bot").order_by(User.id)).first()
            home = ChatServer(name="SyncTact", owner_id=first.id if first else 0, is_home=True)
            session.add(home)
            session.commit()
            session.refresh(home)
            log.info("Created home server '%s'", home.name)
        for ch in orphans:
            ch.server_id = home.id
            session.add(ch)
        if home.owner_id:
            _join_server(session, home.id, home.owner_id, "owner")
        session.commit()


def _admin_key_ok(key: Optional[str]) -> bool:
    return bool(ADMIN_KEY) and bool(key) and secrets.compare_digest(key, ADMIN_KEY)


def require_staff(
    x_admin_key: Optional[str] = Header(default=None),
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    session: Session = Depends(get_session),
) -> User:
    """Moderator/admin user, or the admin panel authenticating with X-Admin-Key."""
    if _admin_key_ok(x_admin_key):
        return User(id=0, name="Admin", email="", hashed_password="", role="admin")
    user = get_current_user(creds, session)
    if not _is_staff(user):
        raise HTTPException(status_code=403, detail="Moderators only")
    return user


def require_staff_or_channel_owner(
    channel_id: Optional[int] = None,
    x_admin_key: Optional[str] = Header(default=None),
    creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
    session: Session = Depends(get_session),
) -> User:
    """Like require_staff, but also lets the owner of `channel_id` through."""
    if _admin_key_ok(x_admin_key):
        return User(id=0, name="Admin", email="", hashed_password="", role="admin")
    user = get_current_user(creds, session)
    if _is_staff(user):
        return user
    if channel_id is not None and _can_manage_channel(user, session.get(Channel, channel_id)):
        return user
    raise HTTPException(status_code=403, detail="Only the channel owner or a moderator can do this")


def _create_session(session: Session, user: User, request: Request) -> str:
    token = create_token(user.id, user.email)
    ua = request.headers.get("user-agent", "")[:200]
    session.add(UserSession(user_id=user.id, token_hash=_token_hash(token), device=ua,
                            ip_addr=get_remote_address(request)))
    session.commit()
    return token


# -------------------------------------------------------------
# Pydantic request / response schemas
# -------------------------------------------------------------
class SignInRequest(BaseModel):
    email:     str
    password:  str
    totp_code: Optional[str] = None


class SignUpRequest(BaseModel):
    name:     str
    email:    EmailStr
    password: str


class AuthResponse(BaseModel):
    token: str
    user:  dict


# -------------------------------------------------------------
# App
# -------------------------------------------------------------
limiter = Limiter(key_func=get_remote_address)
app = FastAPI(title="SyncTact Signaling Server", version="2.0.0")
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/uploads", StaticFiles(directory=UPLOADS_DIR), name="uploads")

# Chat WebSocket connections: { user_id: WebSocket }
chat_connections: Dict[int, WebSocket] = {}

# Slowmode tracking: { (user_id, channel_id): last_message_unix_timestamp }
_slowmode_last: Dict[tuple, float] = {}

# Bad words cache (reloaded from DB on startup and on change)
_bad_words_cache: set = set()

def _reload_bad_words():
    global _bad_words_cache
    with Session(engine) as s:
        _bad_words_cache = {bw.word.lower() for bw in s.exec(select(BadWord)).all()}

def _filter_bad_words(text: str) -> str:
    """Replace bad words with asterisks."""
    if not _bad_words_cache:
        return text
    words = text.split()
    result = []
    for w in words:
        clean = w.lower().strip(".,!?;:'\"")
        if clean in _bad_words_cache:
            result.append('*' * len(w))
        else:
            result.append(w)
    return ' '.join(result)

def _log_audit(session: Session, action: str, actor_id: int, actor_name: str,
               target_user_id: int = None, target_user_name: str = None,
               channel_id: int = None, detail: str = None):
    entry = AuditLog(
        action=action, actor_id=actor_id, actor_name=actor_name,
        target_user_id=target_user_id, target_user_name=target_user_name,
        channel_id=channel_id, detail=detail,
    )
    session.add(entry)
    session.commit()


@app.on_event("startup")
def on_startup():
    create_db_tables()
    migrate_db()
    _reload_bad_words()
    log.info("Database ready")
    if not os.getenv("SECRET_KEY"):
        log.warning("SECRET_KEY is not set: using a random key, so all sessions end when the server restarts")
    if not ADMIN_KEY:
        log.warning("ADMIN_KEY is not set: admin-key endpoints are disabled")
    if engine.dialect.name == "sqlite" and os.getenv("RENDER"):
        log.warning("DATABASE_URL is not set: using a local SQLite file, which Render erases on every "
                    "deploy and restart (all users, channels and messages are lost). Set DATABASE_URL to a Postgres database.")
    log.info("Database: %s", engine.dialect.name)
    if email_provider():
        log.info("Email delivery: %s (from %s)", email_provider(), FROM_EMAIL)
    if METERED_TURN_API_KEY and METERED_TURN_DOMAIN:
        log.info("TURN relay: Metered (%s)", METERED_TURN_DOMAIN)
    elif TURN_URLS and TURN_USERNAME and TURN_CREDENTIAL:
        log.info("TURN relay: %s", TURN_URLS.split(",")[0].strip())
    else:
        log.warning("No TURN server configured: video calls only connect when both people can reach "
                    "each other directly. Set METERED_TURN_DOMAIN and METERED_TURN_API_KEY, or TURN_URLS, "
                    "TURN_USERNAME and TURN_CREDENTIAL.")
    # Fix corrupted emoji channel names (from PowerShell rename mangling multi-byte chars)
    _DEFAULT_CHANNELS = [
        (1, "\U0001f4e3 general",  "Company-wide announcements and general chat"),
        (2, "\U0001f3b2 random",   "Non-work banter and fun"),
        (3, "\U0001f6e0 dev",      "Engineering discussions"),
        (4, "\U0001f4e2 updates",  "Product and release updates"),
    ]
    _ensure_volt_user()
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
    _ensure_home_server()


import asyncio as _asyncio


async def _run_scheduler():
    """Background task: deliver scheduled messages + fire recurring tasks."""
    while True:
        await _asyncio.sleep(20)
        try:
            now = datetime.now(timezone.utc)
            with Session(engine) as sess:
                # -- One-time scheduled messages --
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

                # -- Recurring tasks (Volt auto-posts) --
                rt_all = sess.exec(
                    select(RecurringTask).where(RecurringTask.active == True)  # noqa: E712
                ).all()
                for rt in rt_all:
                    if rt.last_run is None:
                        due = True
                    else:
                        elapsed = (now - rt.last_run.replace(tzinfo=timezone.utc)).total_seconds() / 60
                        due = elapsed >= rt.interval_minutes
                    if due:
                        cm = ChatMessage(
                            channel_id=rt.channel_id,
                            sender_id=0,
                            sender_name="Volt",
                            content=rt.message,
                            bot_name="Volt",
                        )
                        sess.add(cm)
                        rt.last_run = now
                        sess.add(rt)
                        sess.commit()
                        sess.refresh(cm)
                        if cm.channel_id:
                            _bcast = {"type": "channel_message", "message": _msg_dict(cm)}
                            _bcast.update(_open_url_fields(sess, rt.open_url, rt.url_target or "self",
                                                           rt.owner_id, rt.channel_id))
                            await _chat_broadcast(_bcast)
        except Exception as exc:
            log.warning("Scheduler error: %s", exc)


@app.on_event("startup")
async def start_scheduler():
    _asyncio.create_task(_run_scheduler())


# -------------------------------------------------------------
# Auth endpoints
# -------------------------------------------------------------
@app.post("/auth/signup", response_model=AuthResponse)
@limiter.limit("5/minute")
def signup(req: SignUpRequest, request: Request, session: Session = Depends(get_session)):
    name  = req.name.strip()[:64]
    email = str(req.email).strip().lower()
    if not name or not req.password:
        raise HTTPException(status_code=400, detail="All fields are required")
    if len(req.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")
    if session.exec(select(User).where(User.email == email)).first():
        raise HTTPException(status_code=409, detail="An account with that email already exists")

    user = User(name=name, email=email, hashed_password=hash_password(req.password))
    session.add(user)
    session.commit()
    session.refresh(user)
    _my_server_ids(session, user.id)   # home server membership
    token = _create_session(session, user, request)
    log.info("New user signed up: %s (%s)", user.name, user.email)
    return {"token": token, "user": {"id": user.id, "name": user.name, "email": user.email}}


@app.post("/auth/signin", response_model=AuthResponse)
@limiter.limit("10/minute")
def signin(req: SignInRequest, request: Request, session: Session = Depends(get_session)):
    req.email = req.email.strip().lower()
    user = session.exec(select(User).where(User.email == req.email)).first()
    if not user or not verify_password(req.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    if getattr(user, 'banned', False):
        raise HTTPException(status_code=403, detail="Account banned")
    if user.totp_enabled:
        if not req.totp_code:
            raise HTTPException(status_code=401, detail="2fa_required")
        if not pyotp.TOTP(user.totp_secret).verify(req.totp_code.strip(), valid_window=1):
            raise HTTPException(status_code=401, detail="Invalid two-factor code")
    token = _create_session(session, user, request)
    log.info("User signed in: %s (%s)", user.name, user.email)
    return {"token": token, "user": {"id": user.id, "name": user.name, "email": user.email}}


@app.get("/auth/me")
def me(current_user: User = Depends(get_current_user)):
    return {
        "id": current_user.id, "name": current_user.name, "email": current_user.email,
        "role": getattr(current_user, "role", "member"),
        "presence": getattr(current_user, "presence", "online"),
        "totp_enabled": getattr(current_user, "totp_enabled", False),
        "avatar_url": current_user.avatar_url,
        "title": getattr(current_user, "title", None),
    }


# -------------------------------------------------------------
# Sessions endpoints
# -------------------------------------------------------------
@app.get("/auth/sessions")
def list_sessions(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(select(UserSession).where(UserSession.user_id == current_user.id, UserSession.active == True)).all()
    return [{"id": r.id, "device": r.device, "ip_addr": r.ip_addr, "created_at": str(r.created_at), "last_used": str(r.last_used)} for r in rows]

@app.delete("/auth/sessions/{sid}")
def revoke_session(sid: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = session.get(UserSession, sid)
    if not row or row.user_id != current_user.id:
        raise HTTPException(404)
    row.active = False
    session.add(row); session.commit()
    return {"ok": True}

@app.post("/auth/signout")
def signout(creds: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
            session: Session = Depends(get_session)):
    if creds:
        row = session.exec(select(UserSession).where(UserSession.token_hash == _token_hash(creds.credentials))).first()
        if row:
            row.active = False
            session.add(row); session.commit()
    return {"ok": True}


# -------------------------------------------------------------
# 2FA endpoints
# -------------------------------------------------------------
@app.post("/auth/2fa/setup")
def twofa_setup(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, current_user.id)
    if user.totp_enabled:
        raise HTTPException(400, "2FA is already enabled; disable it first")
    secret = pyotp.random_base32()
    user.totp_secret = secret
    session.add(user); session.commit()
    uri = pyotp.totp.TOTP(secret).provisioning_uri(name=user.email, issuer_name="SyncTact")
    img = qrcode.make(uri)
    buf = io.BytesIO(); img.save(buf, format="PNG"); buf.seek(0)
    qr_b64 = base64.b64encode(buf.read()).decode()
    return {"secret": secret, "otpauth_uri": uri, "qr_data_url": f"data:image/png;base64,{qr_b64}"}

@app.post("/auth/2fa/confirm")
def twofa_confirm(body: dict, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, current_user.id)
    if not user.totp_secret:
        raise HTTPException(400, "2FA not set up")
    if not pyotp.TOTP(user.totp_secret).verify(str(body.get("code", "")).strip(), valid_window=1):
        raise HTTPException(400, "Invalid code")
    user.totp_enabled = True
    session.add(user); session.commit()
    return {"ok": True}

@app.post("/auth/2fa/verify")
def twofa_verify(body: dict, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, current_user.id)
    if not user.totp_enabled:
        raise HTTPException(400, "2FA not enabled")
    if not pyotp.TOTP(user.totp_secret).verify(str(body.get("code", "")).strip(), valid_window=1):
        raise HTTPException(400, "Invalid code")
    return {"ok": True}

@app.delete("/auth/2fa")
def twofa_disable(code: str = "", current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, current_user.id)
    if user.totp_enabled and not pyotp.TOTP(user.totp_secret).verify(code.strip(), valid_window=1):
        raise HTTPException(400, "Enter a valid 2FA code to disable 2FA")
    user.totp_enabled = False; user.totp_secret = None
    session.add(user); session.commit()
    return {"ok": True}


# -------------------------------------------------------------
# Presence
# -------------------------------------------------------------
@app.patch("/users/me/presence")
async def update_presence(body: dict, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    allowed = {"online", "away", "dnd", "offline"}
    pres = body.get("presence", "online")
    if pres not in allowed:
        raise HTTPException(400, "Invalid presence value")
    user = session.get(User, current_user.id)
    user.presence = pres
    session.add(user); session.commit()
    await _chat_broadcast({"type": "user_status", "user_id": current_user.id, "presence": pres})
    return {"ok": True, "presence": pres}


# -------------------------------------------------------------
# Server settings
# -------------------------------------------------------------
@app.get("/settings")
def get_settings(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(select(ServerSetting)).all()
    return {r.key: r.value for r in rows}

@app.patch("/settings")
def update_settings(body: dict, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if getattr(current_user, "role", "member") not in ("admin", "moderator"):
        raise HTTPException(403, "Insufficient permissions")
    for k, v in body.items():
        row = session.exec(select(ServerSetting).where(ServerSetting.key == k)).first()
        if row:
            row.value = str(v); row.updated_by = current_user.id; row.updated_at = datetime.utcnow()
            session.add(row)
        else:
            session.add(ServerSetting(key=k, value=str(v), updated_by=current_user.id))
    session.commit()
    return {"ok": True}


# -------------------------------------------------------------
# Channel roles / members
# -------------------------------------------------------------
@app.get("/channels/{channel_id}/members")
def channel_members(channel_id: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    sids = session.exec(select(ChatMessage.sender_id).where(ChatMessage.channel_id == channel_id).distinct()).all()
    uids = list({r for r in sids if r})
    users = session.exec(select(User).where(User.id.in_(uids))).all() if uids else []
    roles_rows = session.exec(select(ChannelRole).where(ChannelRole.channel_id == channel_id)).all()
    role_map = {r.user_id: r.role for r in roles_rows}
    return [{"id": u.id, "name": u.name, "avatar": u.avatar_url,
             "role": role_map.get(u.id, getattr(u, "role", "member")),
             "presence": getattr(u, "presence", "online")} for u in users]

@app.put("/channels/{channel_id}/members/{user_id}/role")
def set_channel_role(channel_id: int, user_id: int, body: dict,
                     current_user: User = Depends(get_current_user),
                     session: Session = Depends(get_session)):
    if getattr(current_user, "role", "member") not in ("admin", "moderator"):
        raise HTTPException(403, "Insufficient permissions")
    role_val = body.get("role", "member")
    if role_val not in ("admin", "moderator", "member"):
        raise HTTPException(400, "role must be admin, moderator or member")
    row = session.exec(select(ChannelRole).where(ChannelRole.channel_id == channel_id, ChannelRole.user_id == user_id)).first()
    if row:
        row.role = role_val; session.add(row)
    else:
        session.add(ChannelRole(channel_id=channel_id, user_id=user_id, role=role_val, assigned_by=current_user.id))
    session.commit()
    return {"ok": True}


# -------------------------------------------------------------
# Webhooks
# -------------------------------------------------------------
@app.get("/webhooks")
def list_webhooks(channel_id: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if not _can_manage_channel(current_user, session.get(Channel, channel_id)):
        raise HTTPException(403, "Only the channel owner or a moderator can view webhooks")
    rows = session.exec(select(WebhookConfig).where(WebhookConfig.channel_id == channel_id, WebhookConfig.active == True)).all()
    return [{"id": r.id, "name": r.name, "token": r.token, "channel_id": r.channel_id} for r in rows]

@app.post("/webhooks")
def create_webhook(body: dict, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    cid = body.get("channel_id"); name = body.get("name", "Webhook")
    if not cid:
        raise HTTPException(400, "channel_id required")
    if not _can_manage_channel(current_user, session.get(Channel, cid)):
        raise HTTPException(403, "Only the channel owner or a moderator can create webhooks")
    tok = secrets.token_urlsafe(32)
    wh = WebhookConfig(channel_id=cid, name=str(name)[:80], token=tok, created_by=current_user.id)
    session.add(wh); session.commit(); session.refresh(wh)
    return {"id": wh.id, "name": wh.name, "token": wh.token, "channel_id": wh.channel_id}

@app.delete("/webhooks/{wid}")
def delete_webhook(wid: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    row = session.get(WebhookConfig, wid)
    if not row:
        raise HTTPException(404)
    if row.created_by != current_user.id and not _can_manage_channel(current_user, session.get(Channel, row.channel_id)):
        raise HTTPException(403, "Not your webhook")
    row.active = False; session.add(row); session.commit()
    return {"ok": True}

@app.post("/webhook/{token}")
async def receive_webhook(token: str, body: dict, session: Session = Depends(get_session)):
    wh = session.exec(select(WebhookConfig).where(WebhookConfig.token == token, WebhookConfig.active == True)).first()
    if not wh:
        raise HTTPException(404, "Webhook not found")
    content = str(body.get("content", "")).strip()[:2000]
    sender = str(body.get("sender_name", wh.name))[:100]
    if not content:
        raise HTTPException(400, "content required")
    msg = ChatMessage(channel_id=wh.channel_id, sender_id=0, sender_name=sender,
                      content=content, bot_name=wh.name)
    session.add(msg); session.commit(); session.refresh(msg)
    await _chat_broadcast({"type": "channel_message", "channel_id": wh.channel_id,
                           "message": {"id": msg.id, "content": msg.content,
                                       "sender_name": msg.sender_name, "sender_id": 0,
                                       "bot_name": msg.bot_name,
                                       "ts": str(msg.created_at), "reactions": {}}})
    return {"ok": True, "message_id": msg.id}


# -------------------------------------------------------------
# Export chat history
# -------------------------------------------------------------
@app.get("/chat/channels/{channel_id}/export")
def export_channel(channel_id: int, format: str = "json",
                   current_user: User = Depends(get_current_user),
                   session: Session = Depends(get_session)):
    rows = session.exec(
        select(ChatMessage)
        .where(ChatMessage.channel_id == channel_id)
        .order_by(ChatMessage.created_at.asc())
    ).all()
    data = [{"id": m.id, "sender": m.sender_name, "content": m.content,
             "created_at": str(m.created_at)} for m in rows]
    if format == "csv":
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["id", "sender", "content", "created_at", "msg_type"])
        writer.writeheader(); writer.writerows(data)
        return StreamingResponse(io.BytesIO(buf.getvalue().encode()),
                                 media_type="text/csv",
                                 headers={"Content-Disposition": f"attachment; filename=channel_{channel_id}.csv"})
    import json
    return StreamingResponse(io.BytesIO(json.dumps(data, indent=2).encode()),
                             media_type="application/json",
                             headers={"Content-Disposition": f"attachment; filename=channel_{channel_id}.json"})


# -------------------------------------------------------------
# Audit log viewer
# -------------------------------------------------------------
@app.get("/audit-log")
def get_audit_log(limit: int = 50, channel_id: Optional[int] = None,
                  current_user: User = Depends(require_staff),
                  session: Session = Depends(get_session)):
    q = select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
    if channel_id:
        q = select(AuditLog).where(AuditLog.channel_id == channel_id).order_by(AuditLog.created_at.desc()).limit(limit)
    rows = session.exec(q).all()
    return [{"id": r.id, "action": r.action, "actor_id": r.actor_id,
             "target_id": r.target_user_id, "channel_id": r.channel_id,
             "detail": r.detail, "created_at": str(r.created_at)} for r in rows]


# -------------------------------------------------------------
# Analytics
# -------------------------------------------------------------
@app.get("/analytics/activity")
def analytics_activity(channel_id: Optional[int] = None, days: int = 7,
                        current_user: User = Depends(get_current_user),
                        session: Session = Depends(get_session)):
    cutoff = datetime.utcnow() - timedelta(days=days)
    q = select(ChatMessage).where(ChatMessage.created_at >= cutoff)
    if channel_id:
        q = q.where(ChatMessage.channel_id == channel_id)
    rows = session.exec(q).all()
    counts: dict = defaultdict(int)
    for m in rows:
        day = str(m.created_at)[:10]
        counts[day] += 1
    result = sorted([{"date": k, "count": v} for k, v in counts.items()], key=lambda x: x["date"])
    return result

@app.get("/analytics/leaderboard")
def analytics_leaderboard(channel_id: Optional[int] = None, limit: int = 10,
                           current_user: User = Depends(get_current_user),
                           session: Session = Depends(get_session)):
    q = select(ChatMessage).where(ChatMessage.sender_id != 0)
    if channel_id:
        q = q.where(ChatMessage.channel_id == channel_id)
    rows = session.exec(q).all()
    counts: dict = defaultdict(int)
    uid_set = set()
    for m in rows:
        counts[m.sender_id] += 1
        uid_set.add(m.sender_id)
    users = {u.id: u.name for u in session.exec(select(User).where(User.id.in_(list(uid_set)))).all()} if uid_set else {}
    top = sorted(counts.items(), key=lambda x: -x[1])[:limit]
    return [{"user_id": uid, "name": users.get(uid, "Unknown"), "count": cnt} for uid, cnt in top]


# ─────────────────────────────────────────────────────────────
# User Blocking
# ─────────────────────────────────────────────────────────────

@app.get("/blocks")
def list_blocks(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    blocks = session.exec(select(UserBlock).where(UserBlock.blocker_id == current_user.id)).all()
    blocked_ids = [b.blocked_id for b in blocks]
    names = {}
    if blocked_ids:
        for u in session.exec(select(User).where(User.id.in_(blocked_ids))).all():
            names[u.id] = u.name
    return [{"id": b.id, "blocked_id": b.blocked_id, "name": names.get(b.blocked_id, "Unknown")} for b in blocks]


@app.post("/blocks/{target_id}")
def block_user(target_id: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if target_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot block yourself")
    existing = session.exec(select(UserBlock).where(UserBlock.blocker_id == current_user.id, UserBlock.blocked_id == target_id)).first()
    if existing:
        return {"ok": True, "already": True}
    session.add(UserBlock(blocker_id=current_user.id, blocked_id=target_id))
    session.commit()
    return {"ok": True}


@app.delete("/blocks/{target_id}")
def unblock_user(target_id: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    b = session.exec(select(UserBlock).where(UserBlock.blocker_id == current_user.id, UserBlock.blocked_id == target_id)).first()
    if b:
        session.delete(b); session.commit()
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# User Badges  (computed dynamically from message count + tenure)
# ─────────────────────────────────────────────────────────────

_BADGE_TIERS = [
    (1,    "Newcomer",    "#64748b", "fa-solid fa-seedling"),
    (50,   "Regular",     "#10b981", "fa-solid fa-star"),
    (200,  "Active",      "#3b82f6", "fa-solid fa-bolt"),
    (500,  "Veteran",     "#f59e0b", "fa-solid fa-crown"),
    (1000, "Legend",      "#a855f7", "fa-solid fa-dragon"),
]

def _compute_badges(user: User, msg_count: int) -> list:
    badges = []
    Badge = next((b for b in reversed(_BADGE_TIERS) if msg_count >= b[0]), _BADGE_TIERS[0])
    badges.append({"label": Badge[1], "color": Badge[2], "icon": Badge[3], "type": "activity"})
    # Tenure badge
    days = (datetime.now(timezone.utc) - user.created_at.replace(tzinfo=timezone.utc) if user.created_at.tzinfo is None else datetime.now(timezone.utc) - user.created_at).days
    if days >= 365:
        badges.append({"label": "Veteran Member", "color": "#f59e0b", "icon": "fa-solid fa-medal", "type": "tenure"})
    elif days >= 30:
        badges.append({"label": "Member", "color": "#10b981", "icon": "fa-solid fa-user-check", "type": "tenure"})
    if user.role in ('admin', 'moderator'):
        badges.append({"label": user.role.capitalize(), "color": "#ef4444" if user.role == 'admin' else "#f59e0b", "icon": "fa-solid fa-shield-halved", "type": "role"})
    return badges


@app.get("/badges/me")
def get_my_badges(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    cnt = len(session.exec(select(ChatMessage).where(ChatMessage.sender_id == current_user.id)).all())
    return {"message_count": cnt, "badges": _compute_badges(current_user, cnt)}


@app.get("/badges/{user_id}")
def get_user_badges(user_id: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    user = session.get(User, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    cnt = len(session.exec(select(ChatMessage).where(ChatMessage.sender_id == user_id)).all())
    return {"message_count": cnt, "badges": _compute_badges(user, cnt)}


# ─────────────────────────────────────────────────────────────
# Message Templates / Snippets
# ─────────────────────────────────────────────────────────────

class TemplateIn(BaseModel):
    title:   str
    content: str


@app.get("/templates")
def list_templates(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(select(MessageTemplate).where(MessageTemplate.user_id == current_user.id)).all()
    return [{"id": t.id, "title": t.title, "content": t.content} for t in rows]


@app.post("/templates")
def create_template(body: TemplateIn, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    t = MessageTemplate(user_id=current_user.id, title=body.title[:80], content=body.content[:2000])
    session.add(t); session.commit(); session.refresh(t)
    return {"id": t.id, "title": t.title, "content": t.content}


@app.delete("/templates/{tid}")
def delete_template(tid: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    t = session.get(MessageTemplate, tid)
    if not t or t.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Not found")
    session.delete(t); session.commit()
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# Reminders  (/remind slash command)
# ─────────────────────────────────────────────────────────────

class ReminderIn(BaseModel):
    content:    str
    minutes:    Optional[int]  = None  # relative
    remind_at:  Optional[str]  = None  # ISO datetime absolute
    channel_id: Optional[int]  = None


@app.post("/remind")
def create_reminder(body: ReminderIn, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if body.minutes:
        at = datetime.now(timezone.utc) + timedelta(minutes=body.minutes)
    elif body.remind_at:
        at = datetime.fromisoformat(body.remind_at.replace("Z", "+00:00"))
    else:
        raise HTTPException(status_code=400, detail="Provide minutes or remind_at")
    r = Reminder(user_id=current_user.id, channel_id=body.channel_id, content=body.content[:500], remind_at=at)
    session.add(r); session.commit(); session.refresh(r)
    return {"id": r.id, "remind_at": r.remind_at.isoformat()}


@app.get("/remind/pending")
def pending_reminders(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    now = datetime.now(timezone.utc)
    rows = session.exec(select(Reminder).where(
        Reminder.user_id == current_user.id,
        Reminder.sent == False,
        Reminder.remind_at <= now,
    )).all()
    out = []
    for r in rows:
        out.append({"id": r.id, "content": r.content, "channel_id": r.channel_id,
                    "remind_at": r.remind_at.isoformat()})
        r.sent = True; session.add(r)
    session.commit()
    return out


# ─────────────────────────────────────────────────────────────
# Calendar Events
# ─────────────────────────────────────────────────────────────

class EventIn(BaseModel):
    title:       str
    description: Optional[str] = None
    starts_at:   str
    ends_at:     Optional[str] = None
    channel_id:  Optional[int] = None


@app.get("/events")
def list_events(channel_id: Optional[int] = None, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    q = select(CalendarEvent)
    if channel_id:
        q = q.where(CalendarEvent.channel_id == channel_id)
    rows = session.exec(q.order_by(CalendarEvent.starts_at)).all()
    out = []
    for e in rows:
        rsvps = session.exec(select(CalendarEventRsvp).where(CalendarEventRsvp.event_id == e.id)).all()
        out.append({
            "id": e.id, "title": e.title, "description": e.description,
            "starts_at": e.starts_at.isoformat(), "ends_at": e.ends_at.isoformat() if e.ends_at else None,
            "creator_id": e.creator_id, "creator_name": e.creator_name, "channel_id": e.channel_id,
            "rsvps": [{"user_id": r.user_id, "name": r.name, "status": r.status} for r in rsvps],
        })
    return out


@app.post("/events")
def create_event(body: EventIn, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    e = CalendarEvent(
        channel_id=body.channel_id, creator_id=current_user.id, creator_name=current_user.name,
        title=body.title[:200], description=body.description,
        starts_at=datetime.fromisoformat(body.starts_at.replace("Z", "+00:00")),
        ends_at=datetime.fromisoformat(body.ends_at.replace("Z", "+00:00")) if body.ends_at else None,
    )
    session.add(e); session.commit(); session.refresh(e)
    return {"id": e.id, "title": e.title, "starts_at": e.starts_at.isoformat()}


@app.post("/events/{event_id}/rsvp")
def rsvp_event(event_id: int, status: str = "yes", current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if status not in ("yes", "no", "maybe"):
        raise HTTPException(status_code=400, detail="status must be yes|no|maybe")
    existing = session.exec(select(CalendarEventRsvp).where(CalendarEventRsvp.event_id == event_id, CalendarEventRsvp.user_id == current_user.id)).first()
    if existing:
        existing.status = status; session.add(existing)
    else:
        session.add(CalendarEventRsvp(event_id=event_id, user_id=current_user.id, name=current_user.name, status=status))
    session.commit()
    return {"ok": True, "status": status}


@app.delete("/events/{event_id}")
def delete_event(event_id: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    e = session.get(CalendarEvent, event_id)
    if not e:
        raise HTTPException(status_code=404, detail="Event not found")
    if e.creator_id != current_user.id and current_user.role not in ('admin', 'moderator'):
        raise HTTPException(status_code=403, detail="Forbidden")
    session.delete(e); session.commit()
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# Channel archive / readonly toggle
# ─────────────────────────────────────────────────────────────

class ChannelSettingsIn(BaseModel):
    archived: Optional[bool] = None
    readonly: Optional[bool] = None
    name:        Optional[str]  = None
    description: Optional[str] = None
    welcome_message: Optional[str] = None
    slowmode_seconds: Optional[int] = None


@app.patch("/channels/{channel_id}/settings")
def update_channel_settings(channel_id: int, body: ChannelSettingsIn,
                              current_user: User = Depends(get_current_user),
                              session: Session = Depends(get_session)):
    if current_user.role not in ('admin', 'moderator'):
        raise HTTPException(status_code=403, detail="Moderator required")
    ch = session.get(Channel, channel_id)
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    if body.archived is not None:  ch.archived = body.archived
    if body.readonly is not None:  ch.readonly = body.readonly
    if body.name is not None:      ch.name = body.name[:80]
    if body.description is not None: ch.description = body.description[:300]
    if body.welcome_message is not None: ch.welcome_message = body.welcome_message[:500]
    if body.slowmode_seconds is not None: ch.slowmode_seconds = max(0, body.slowmode_seconds)
    session.add(ch); session.commit()
    return {"ok": True, "channel_id": channel_id, "archived": ch.archived, "readonly": ch.readonly}


# ─────────────────────────────────────────────────────────────
# Server Discovery
# ─────────────────────────────────────────────────────────────

@app.get("/discovery")
def server_discovery(session: Session = Depends(get_session)):
    """Return all non-archived channels with member/message counts."""
    channels = session.exec(select(Channel).where(Channel.archived == False)).all()
    out = []
    for ch in channels:
        msg_count = len(session.exec(select(ChatMessage).where(ChatMessage.channel_id == ch.id)).all())
        out.append({
            "id": ch.id, "name": ch.name, "description": ch.description or "",
            "message_count": msg_count,
            "created_at": ch.created_at.isoformat(),
        })
    return sorted(out, key=lambda x: -x["message_count"])


# ─────────────────────────────────────────────────────────────
# File Browser  (all files shared in a channel)
# ─────────────────────────────────────────────────────────────

@app.get("/files/{channel_id}")
def channel_files(channel_id: int, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    rows = session.exec(
        select(ChatMessage).where(
            ChatMessage.channel_id == channel_id,
            ChatMessage.file_url != None,
        ).order_by(ChatMessage.created_at.desc())
    ).all()
    return [{"id": m.id, "file_url": m.file_url, "file_name": m.file_name,
             "sender_name": m.sender_name, "ts": m.created_at.isoformat()} for m in rows]


# ─────────────────────────────────────────────────────────────
# Translation proxy  (MyMemory — free, no key needed)
# ─────────────────────────────────────────────────────────────

@app.get("/translate")
async def translate_text(text: str = Query(..., max_length=500),
                          target: str = Query(default="en"),
                          current_user: User = Depends(get_current_user)):
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get("https://api.mymemory.translated.net/get",
                                  params={"q": text, "langpair": f"auto|{target}"})
            data = r.json()
            translated = data.get("responseData", {}).get("translatedText", text)
    except Exception:
        translated = text
    return {"original": text, "translated": translated, "target": target}


# ─────────────────────────────────────────────────────────────
# Video / Voice Call signaling via chat WS  (REST: initiate call)
# ─────────────────────────────────────────────────────────────

@app.post("/channels/{channel_id}/call")
async def start_call(channel_id: int, current_user: User = Depends(get_current_user)):
    room_code = f"ch{channel_id}"
    await _chat_broadcast({
        "type":         "call_started",
        "channel_id":   channel_id,
        "room_code":    room_code,
        "started_by":   current_user.id,
        "started_name": current_user.name,
    })
    return {"room_code": room_code}


@app.delete("/channels/{channel_id}/call")
async def end_call(channel_id: int, current_user: User = Depends(get_current_user)):
    await _chat_broadcast({"type": "call_ended", "channel_id": channel_id})
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# Notification sound preferences  (server just stores the pref)
# ─────────────────────────────────────────────────────────────

class NotifPrefIn(BaseModel):
    sounds_enabled: bool = True
    sound_theme:    str  = "default"  # default|minimal|none


@app.patch("/notif-prefs")
def update_notif_prefs(body: NotifPrefIn, current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    from sqlmodel import text as sql_text
    for k, v in [("notif_sounds_" + str(current_user.id), str(body.sounds_enabled)), ("notif_theme_" + str(current_user.id), body.sound_theme)]:
        existing = session.exec(select(ServerSetting).where(ServerSetting.key == k)).first()
        if existing:
            existing.value = v; session.add(existing)
        else:
            session.add(ServerSetting(key=k, value=v, updated_by=current_user.id))
    session.commit()
    return {"ok": True}


# ─────────────────────────────────────────────────────────────
# Email Digest stub  (requires SMTP_* env vars for real sending)
# ─────────────────────────────────────────────────────────────

@app.post("/email-digest")
async def trigger_email_digest(current_user: User = Depends(get_current_user), session: Session = Depends(get_session)):
    if not email_provider():
        return {"ok": False, "detail": "Email delivery is not configured on the server"}

    since = datetime.now(timezone.utc) - timedelta(hours=24)
    msgs = session.exec(
        select(ChatMessage)
        .where(ChatMessage.created_at >= since)
        .where(ChatMessage.channel_id.is_not(None) |
               (ChatMessage.sender_id == current_user.id) |
               (ChatMessage.dm_to_user_id == current_user.id))
        .order_by(ChatMessage.created_at.desc()).limit(20)
    ).all()
    body_lines = [f"• [{m.sender_name}] {m.content[:120]}" for m in msgs if m.content]
    body_text = "Your SyncTact digest (last 24 h):\n\n" + "\n".join(body_lines[:20])
    if not await asyncio.to_thread(send_email, current_user.email, "SyncTact Daily Digest", body_text):
        return {"ok": False, "detail": "Could not send the digest email"}
    return {"ok": True, "sent_to": current_user.email}


# -------------------------------------------------------------
# Admin endpoints
# -------------------------------------------------------------
def require_admin(x_admin_key: Optional[str] = Header(default=None)):
    if not _admin_key_ok(x_admin_key):
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
_STUN_SERVERS = [
    {"urls": "stun:stun.l.google.com:19302"},
    {"urls": "stun:stun1.l.google.com:19302"},
]


def _static_turn_servers() -> list:
    urls = [u.strip() for u in TURN_URLS.split(",") if u.strip()]
    if not urls or not TURN_USERNAME or not TURN_CREDENTIAL:
        return []
    return [{"urls": urls if len(urls) > 1 else urls[0],
             "username": TURN_USERNAME, "credential": TURN_CREDENTIAL}]


@app.get("/ice-servers")
async def ice_servers():
    """STUN plus a TURN relay, for meeting peer connections. No login required (guests join calls)."""
    if METERED_TURN_API_KEY and METERED_TURN_DOMAIN:
        try:
            async with httpx.AsyncClient(timeout=8) as client:
                r = await client.get(
                    f"https://{METERED_TURN_DOMAIN}/api/v1/turn/credentials",
                    params={"apiKey": METERED_TURN_API_KEY},
                )
            data = r.json() if r.status_code == 200 else None
            if isinstance(data, list) and data:
                return {"iceServers": data}
            log.warning("Metered TURN credentials failed: HTTP %s", r.status_code)
        except Exception as exc:
            log.warning("Metered TURN credentials failed: %s", exc)
    return {"iceServers": _STUN_SERVERS + _static_turn_servers()}


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
    if peer_id not in room_peers and len(room_peers) >= MAX_PEERS_PER_ROOM:
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

            # -- Raise hand / Reaction / Whiteboard broadcast --
            elif msg_type in ("raise_hand", "reaction", "whiteboard"):
                await broadcast_to_room(room_code, {
                    **msg,
                    "from_id":   peer_id,
                    "from_name": display_name,
                })

            else:
                log.debug("Unknown message type '%s' from %s", msg_type, peer_id)

    except (WebSocketDisconnect, Exception) as exc:
        if not isinstance(exc, WebSocketDisconnect):
            log.warning("[%s] %s error: %s", room_code, peer_id, exc)

    finally:
        # -- Clean up --
        # A reconnect under the same peer_id replaces our entry; leave it alone in that case.
        current = rooms.get(room_code, {}).get(peer_id)
        if current is not None and current["ws"] is ws:
            del rooms[room_code][peer_id]
            log.info("[%s] %s left  (total: %d)", room_code, peer_id, len(rooms.get(room_code, {})))
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
def _poll_dict(p: Poll, session: Session) -> dict:
    opts    = json.loads(p.options_json)
    votes   = session.exec(select(PollVote).where(PollVote.poll_id == p.id)).all()
    counts  = [0] * len(opts)
    voters  = [[] for _ in range(len(opts))]
    for v in votes:
        if 0 <= v.option_index < len(opts):
            counts[v.option_index] += 1
            voters[v.option_index].append(v.user_id)
    return {
        "id":            p.id,
        "creator_id":    p.creator_id,
        "creator_name":  p.creator_name,
        "question":      p.question,
        "options":       opts,
        "counts":        counts,
        "voters":        voters,
        "channel_id":    p.channel_id,
        "dm_to_user_id": p.dm_to_user_id,
        "ts":            p.created_at.isoformat(),
    }


def _msg_dict(m: ChatMessage) -> dict:
    return {
        "id":             m.id,
        "channel_id":     m.channel_id,
        "dm_to_user_id":  m.dm_to_user_id,
        "sender_id":      m.sender_id,
        "sender_name":    m.sender_name,
        "content":        m.content,
        "file_url":       m.file_url,
        "file_name":      m.file_name,
        "reactions":      json.loads(m.reactions or "{}"),
        "pinned":         bool(m.pinned),
        "parent_id":      m.parent_id,
        "bot_name":       m.bot_name,
        "edited":         bool(m.edited),
        "edited_at":      m.edited_at.isoformat() if m.edited_at else None,
        "forwarded_from": m.forwarded_from,
        "ts":             m.created_at.isoformat(),
    }


def _task_dict(t: RecurringTask) -> dict:
    return {
        "id":               t.id,
        "channel_id":       t.channel_id,
        "message":          t.message,
        "interval_minutes": t.interval_minutes,
        "last_run":         t.last_run.isoformat() if t.last_run else None,
        "active":           t.active,
        "open_url":         t.open_url,
        "url_target":       t.url_target or "self",
        "created_at":       t.created_at.isoformat(),
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


async def _send_for_message(cm: ChatMessage, payload: dict):
    """Broadcast an event about a message: to everyone for channel messages, only to the two participants for DMs."""
    if cm.channel_id is not None:
        await _chat_broadcast(payload)
    else:
        for uid in {cm.sender_id, cm.dm_to_user_id}:
            if uid:
                await _chat_send(uid, payload)


_ALLOWED_GIF_HOSTS = ("giphy.com", "tenor.com", "googleusercontent.com")


def _safe_file_url(url) -> Optional[str]:
    """Only allow our own uploads or https GIFs from known providers in message attachments."""
    if not url:
        return None
    url = str(url)
    if url.startswith("/uploads/") and ".." not in url and all(c not in url for c in "\"'<> \\"):
        return url
    try:
        from urllib.parse import urlparse
        p = urlparse(url)
    except ValueError:
        return None
    host = (p.hostname or "").lower()
    if p.scheme == "https" and any(host == h or host.endswith("." + h) for h in _ALLOWED_GIF_HOSTS) \
            and all(c not in url for c in "\"'<> \\"):
        return url
    return None


def _clean_emoji(emoji) -> Optional[str]:
    emoji = str(emoji or "")
    if not emoji or len(emoji) > 16 or any(c in emoji for c in "<>\"'&`=/\\"):
        return None
    return emoji


# -------------------------------------------------------------
# Chat Pydantic schemas
# -------------------------------------------------------------
class ChannelCreate(BaseModel):
    name:         str
    description:  Optional[str] = None
    channel_type: Optional[str] = 'text'  # text | moodboard
    server_id:    Optional[int] = None


class ScheduledCreate(BaseModel):
    content:       str
    channel_id:    Optional[int] = None
    dm_to_user_id: Optional[int] = None
    send_at:       str   # ISO-8601 datetime string


# -------------------------------------------------------------
# Chat REST endpoints
# -------------------------------------------------------------
def _channel_dict(c: Channel) -> dict:
    return {"id": c.id, "name": c.name, "description": c.description,
            "created_by": c.created_by, "slowmode_seconds": c.slowmode_seconds or 0,
            "category_id": c.category_id, "server_id": c.server_id,
            "readonly": bool(c.readonly), "archived": bool(c.archived),
            "channel_type": c.channel_type or 'text'}


@app.get("/chat/channels")
def list_channels(
    server_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    mine = _my_server_ids(session, current_user.id)
    if server_id is not None and server_id not in mine:
        raise HTTPException(status_code=403, detail="You're not in that server")
    channels = session.exec(select(Channel).order_by(Channel.created_at)).all()
    return [_channel_dict(c) for c in channels
            if c.server_id in mine and (server_id is None or c.server_id == server_id)]


@app.post("/chat/channels", status_code=201)
def create_channel(
    req: ChannelCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    name = req.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Channel name required")
    if not req.server_id:
        home = session.exec(select(ChatServer).where(ChatServer.is_home == True)).first()  # noqa: E712
        req.server_id = home.id if home else None
    if not req.server_id or req.server_id not in _my_server_ids(session, current_user.id):
        raise HTTPException(status_code=403, detail="Pick a server you belong to")
    ch = Channel(name=name, description=req.description, created_by=current_user.id,
                 channel_type=req.channel_type or 'text', server_id=req.server_id)
    session.add(ch)
    session.commit()
    session.refresh(ch)
    return _channel_dict(ch)


@app.get("/chat/channels/{channel_id}/messages")
def channel_messages(
    channel_id: int,
    before: Optional[int] = None,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ch = session.get(Channel, channel_id)
    if not ch:
        raise HTTPException(status_code=404, detail="Channel not found")
    if not _is_server_member(session, current_user.id, ch.server_id):
        raise HTTPException(status_code=403, detail="You're not in that server")
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
    return [{"id": u.id, "name": u.name, "avatar_url": u.avatar_url, "status": u.status, "title": u.title,
             "is_bot": u.role == "bot"} for u in users]


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
    written  = 0
    with open(dest, "wb") as fh:
        while chunk := await file.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                fh.close(); os.remove(dest)
                raise HTTPException(413, f"File must be under {MAX_UPLOAD_BYTES // (1024 * 1024)} MB")
            fh.write(chunk)
    return {"url": f"/uploads/{fname}", "name": original[:200]}


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


# -- Delete a message (sender only) --
@app.delete("/chat/messages/{msg_id}")
async def delete_message(
    msg_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    cm = session.get(ChatMessage, msg_id)
    if not cm:
        raise HTTPException(status_code=404, detail="Message not found")
    is_own = cm.sender_id == current_user.id and cm.sender_id != 0
    if cm.channel_id is not None:
        allowed = is_own or _can_manage_channel(current_user, session.get(Channel, cm.channel_id))
    else:
        allowed = is_own or (cm.sender_id == 0 and _can_view_message(current_user, cm))
    if not allowed:
        raise HTTPException(status_code=403, detail="You can only delete your own messages")
    _log_audit(session, "delete_message", current_user.id, current_user.name,
               channel_id=cm.channel_id, detail=cm.content[:200] if cm.content else None)
    session.delete(cm)
    session.commit()
    await _chat_broadcast({"type": "message_deleted", "message_id": msg_id})
    return {"ok": True}
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
        if ch and ch.created_by != 0 and ch.created_by != current_user.id and not _is_staff(current_user):
            raise HTTPException(status_code=403, detail="Only the channel owner can pin messages")
    elif not _can_view_message(current_user, cm):
        raise HTTPException(status_code=404, detail="Message not found")
    cm.pinned = not bool(cm.pinned)
    session.add(cm)
    session.commit()
    payload = {"type": "pin_update", "message_id": msg_id, "pinned": cm.pinned}
    await _send_for_message(cm, payload)
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
    from_user: Optional[str] = Query(None),
    channel_id: Optional[int] = Query(None),
    after: Optional[str] = Query(None),   # ISO date string YYYY-MM-DD
    before: Optional[str] = Query(None),  # ISO date string YYYY-MM-DD
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    from sqlalchemy import or_
    stmt = select(ChatMessage).where(
        ChatMessage.content.contains(q),
        ChatMessage.parent_id == None,  # noqa: E711  top-level only
        or_(
            ChatMessage.channel_id != None,  # noqa: E711
            ChatMessage.sender_id == current_user.id,
            ChatMessage.dm_to_user_id == current_user.id,
        ),
    )
    if from_user:
        stmt = stmt.where(ChatMessage.sender_name.ilike(f"%{from_user}%"))
    if channel_id:
        stmt = stmt.where(ChatMessage.channel_id == channel_id)
    if after:
        try:
            after_dt = datetime.fromisoformat(after)
            stmt = stmt.where(ChatMessage.created_at >= after_dt)
        except ValueError:
            pass
    if before:
        try:
            before_dt = datetime.fromisoformat(before) + timedelta(days=1)
            stmt = stmt.where(ChatMessage.created_at <= before_dt)
        except ValueError:
            pass
    stmt = stmt.order_by(ChatMessage.created_at.desc()).limit(60)
    msgs = session.exec(stmt).all()
    return [_msg_dict(m) for m in msgs]


# -- Get thread replies for a message --
@app.get("/chat/messages/{msg_id}/thread")
def get_thread(
    msg_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    parent = session.get(ChatMessage, msg_id)
    if not parent or not _can_view_message(current_user, parent):
        raise HTTPException(404, "Message not found")
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
# Polls
# -------------------------------------------------------------
class CreatePollRequest(BaseModel):
    question:      str
    options:       List[str]
    channel_id:    Optional[int] = None
    dm_to_user_id: Optional[int] = None


@app.post("/chat/polls", status_code=201)
async def create_poll(
    body: CreatePollRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if len(body.options) < 2:
        raise HTTPException(400, "Need at least 2 options")
    poll = Poll(
        creator_id=current_user.id, creator_name=current_user.name,
        question=body.question, options_json=json.dumps(body.options),
        channel_id=body.channel_id, dm_to_user_id=body.dm_to_user_id,
    )
    session.add(poll); session.commit(); session.refresh(poll)
    pd = _poll_dict(poll, session)
    if body.channel_id:
        await _chat_broadcast({"type": "poll_created", "poll": pd})
    elif body.dm_to_user_id:
        await _chat_send(body.dm_to_user_id, {"type": "poll_created", "poll": pd})
        await _chat_send(current_user.id,     {"type": "poll_created", "poll": pd})
    return pd


@app.post("/chat/polls/{poll_id}/vote")
async def vote_poll(
    poll_id: int,
    body: dict,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    poll = session.get(Poll, poll_id)
    if not poll or not _can_view_poll(current_user, poll):
        raise HTTPException(404, "Poll not found")
    try:
        opt_idx = int(body.get("option_index", 0))
    except (TypeError, ValueError):
        raise HTTPException(400, "Invalid option")
    if not 0 <= opt_idx < len(json.loads(poll.options_json)):
        raise HTTPException(400, "Invalid option")
    existing = session.exec(
        select(PollVote).where(PollVote.poll_id == poll_id, PollVote.user_id == current_user.id)
    ).first()
    if existing:
        session.delete(existing); session.commit()
    session.add(PollVote(poll_id=poll_id, user_id=current_user.id, option_index=opt_idx))
    session.commit()
    pd = _poll_dict(poll, session)
    if poll.channel_id:
        await _chat_broadcast({"type": "poll_update", "poll": pd})
    elif poll.dm_to_user_id:
        await _chat_send(poll.dm_to_user_id, {"type": "poll_update", "poll": pd})
        await _chat_send(poll.creator_id,    {"type": "poll_update", "poll": pd})
    return pd


def _can_view_poll(user: User, poll: Poll) -> bool:
    return poll.channel_id is not None or user.id in (poll.creator_id, poll.dm_to_user_id)


@app.get("/chat/polls/{poll_id}")
def get_poll(
    poll_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    poll = session.get(Poll, poll_id)
    if not poll or not _can_view_poll(current_user, poll):
        raise HTTPException(404)
    return _poll_dict(poll, session)


@app.get("/chat/channels/{channel_id}/polls")
def get_channel_polls(
    channel_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    polls = session.exec(
        select(Poll).where(Poll.channel_id == channel_id)
        .order_by(Poll.created_at.desc()).limit(20)
    ).all()
    return [_poll_dict(p, session) for p in polls]


# -------------------------------------------------------------
# Moderation
# -------------------------------------------------------------
import time as _time_mod

class MuteRequest(BaseModel):
    user_id:    int
    channel_id: Optional[int] = None  # None = all channels
    minutes:    Optional[int] = None  # None = permanent

class BadWordRequest(BaseModel):
    word: str

class SlowmodeRequest(BaseModel):
    seconds: int  # 0 = disabled

@app.post("/mod/mute")
async def mute_user(
    body: MuteRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    target = session.get(User, body.user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if body.channel_id:
        if not _can_manage_channel(current_user, session.get(Channel, body.channel_id)):
            raise HTTPException(403, "Only the channel owner or a moderator can mute in this channel")
    elif not _is_staff(current_user):
        raise HTTPException(403, "Only moderators can mute server-wide")
    if _is_staff(target) and current_user.role != "admin":
        raise HTTPException(403, "Cannot mute a moderator or admin")
    muted_until = None
    if body.minutes:
        muted_until = datetime.now(timezone.utc) + timedelta(minutes=body.minutes)
    # Remove existing mute for same scope first
    existing = session.exec(
        select(MutedUser).where(MutedUser.user_id == body.user_id, MutedUser.channel_id == body.channel_id)
    ).first()
    if existing:
        session.delete(existing)
    mu = MutedUser(user_id=body.user_id, channel_id=body.channel_id,
                   muted_until=muted_until, muted_by=current_user.id)
    session.add(mu); session.commit()
    _log_audit(session, "mute_user", current_user.id, current_user.name,
               target.id, target.name, body.channel_id,
               f"duration={'permanent' if not body.minutes else str(body.minutes)+'m'}")
    await _chat_send(body.user_id, {"type": "moderation", "action": "muted",
                                    "channel_id": body.channel_id,
                                    "until": muted_until.isoformat() if muted_until else None,
                                    "by": current_user.name})
    return {"ok": True}


@app.delete("/mod/mute/{user_id}")
def unmute_user(
    user_id: int,
    channel_id: Optional[int] = None,
    actor: User = Depends(require_staff_or_channel_owner),
    session: Session = Depends(get_session),
):
    stmt = select(MutedUser).where(MutedUser.user_id == user_id)
    if channel_id is not None:
        stmt = stmt.where(MutedUser.channel_id == channel_id)
    existing = session.exec(stmt).all()
    for m in existing:
        session.delete(m)
    session.commit()
    _log_audit(session, "unmute_user", actor.id, actor.name, user_id, None, channel_id)
    return {"ok": True}


@app.post("/mod/kick/{user_id}/{channel_id}")
async def kick_user(
    user_id: int,
    channel_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if not _can_manage_channel(current_user, session.get(Channel, channel_id)):
        raise HTTPException(403, "Only the channel owner or a moderator can kick users")
    if _is_staff(target) and current_user.role != "admin":
        raise HTTPException(403, "Cannot kick a moderator or admin")
    existing = session.exec(
        select(KickedUser).where(KickedUser.user_id == user_id, KickedUser.channel_id == channel_id)
    ).first()
    if not existing:
        ku = KickedUser(user_id=user_id, channel_id=channel_id, kicked_by=current_user.id)
        session.add(ku); session.commit()
    _log_audit(session, "kick_user", current_user.id, current_user.name,
               target.id, target.name, channel_id)
    await _chat_send(user_id, {"type": "moderation", "action": "kicked",
                                "channel_id": channel_id, "by": current_user.name})
    return {"ok": True}


@app.delete("/mod/kick/{user_id}/{channel_id}")
def unkick_user(
    user_id: int,
    channel_id: int,
    actor: User = Depends(require_staff_or_channel_owner),
    session: Session = Depends(get_session),
):
    existing = session.exec(
        select(KickedUser).where(KickedUser.user_id == user_id, KickedUser.channel_id == channel_id)
    ).first()
    if existing:
        session.delete(existing); session.commit()
    _log_audit(session, "unkick_user", actor.id, actor.name, user_id, None, channel_id)
    return {"ok": True}


@app.post("/mod/ban/{user_id}")
async def ban_user(
    user_id: int,
    actor: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if target.id == actor.id:
        raise HTTPException(400, "Cannot ban yourself")
    if _is_staff(target) and actor.role != "admin":
        raise HTTPException(403, "Only admins can ban moderators or admins")
    target.banned = True
    session.add(target)
    for s in session.exec(select(UserSession).where(UserSession.user_id == user_id)).all():
        s.active = False
        session.add(s)
    session.commit()
    _log_audit(session, "ban_user", actor.id, actor.name, target.id, target.name)
    # Force disconnect banned user
    await _chat_send(user_id, {"type": "moderation", "action": "banned", "by": actor.name})
    ws = chat_connections.get(user_id)
    if ws:
        try: await ws.close(code=4003)
        except Exception: pass
    return {"ok": True}


@app.delete("/mod/ban/{user_id}")
def unban_user(
    user_id: int,
    actor: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    target = session.get(User, user_id)
    if not target:
        raise HTTPException(404, "User not found")
    target.banned = False
    session.add(target); session.commit()
    _log_audit(session, "unban_user", actor.id, actor.name, target.id, target.name)
    return {"ok": True}


@app.patch("/chat/channels/{channel_id}/slowmode")
async def set_slowmode(
    channel_id: int,
    body: SlowmodeRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ch = session.get(Channel, channel_id)
    if not ch:
        raise HTTPException(404, "Channel not found")
    if not _can_manage_channel(current_user, ch):
        raise HTTPException(403, "Only the channel owner or a moderator can set slowmode")
    ch.slowmode_seconds = max(0, min(body.seconds, 3600))
    session.add(ch); session.commit()
    await _chat_broadcast({"type": "slowmode_update", "channel_id": channel_id,
                           "seconds": ch.slowmode_seconds})
    return {"ok": True, "seconds": ch.slowmode_seconds}


@app.get("/mod/badwords")
def list_bad_words(
    _: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    return [{"id": bw.id, "word": bw.word} for bw in session.exec(select(BadWord)).all()]


@app.post("/mod/badwords", status_code=201)
def add_bad_word(
    body: BadWordRequest,
    actor: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    w = body.word.strip().lower()[:64]
    if not w:
        raise HTTPException(400, "Word required")
    existing = session.exec(select(BadWord).where(BadWord.word == w)).first()
    if existing:
        return {"id": existing.id, "word": existing.word}
    bw = BadWord(word=w, added_by=actor.id)
    session.add(bw); session.commit(); session.refresh(bw)
    _reload_bad_words()
    return {"id": bw.id, "word": bw.word}


@app.delete("/mod/badwords/{word_id}")
def remove_bad_word(
    word_id: int,
    _: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    bw = session.get(BadWord, word_id)
    if not bw:
        raise HTTPException(404, "Not found")
    session.delete(bw); session.commit()
    _reload_bad_words()
    return {"ok": True}


@app.get("/mod/audit")
def get_mod_audit_log(
    limit: int = 100,
    _: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    logs = session.exec(
        select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit)
    ).all()
    return [{"id": l.id, "action": l.action, "actor": l.actor_name,
             "target": l.target_user_name, "channel_id": l.channel_id,
             "detail": l.detail, "ts": l.created_at.isoformat()} for l in logs]


@app.get("/mod/muted")
def list_muted(
    _: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    muted = session.exec(select(MutedUser)).all()
    result = []
    for m in muted:
        u = session.get(User, m.user_id)
        result.append({"id": m.id, "user_id": m.user_id, "user_name": u.name if u else "?",
                       "channel_id": m.channel_id,
                       "muted_until": m.muted_until.isoformat() if m.muted_until else None})
    return result


@app.get("/mod/kicked")
def list_kicked(
    _: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    kicked = session.exec(select(KickedUser)).all()
    result = []
    for k in kicked:
        u = session.get(User, k.user_id)
        result.append({"id": k.id, "user_id": k.user_id, "user_name": u.name if u else "?",
                       "channel_id": k.channel_id})
    return result


@app.get("/mod/banned")
def list_banned(
    _: User = Depends(require_staff),
    session: Session = Depends(get_session),
):
    users = session.exec(select(User).where(User.banned == True)).all()  # noqa: E712
    return [{"id": u.id, "name": u.name, "email": u.email} for u in users]


# -------------------------------------------------------------
# Message editing & forwarding
# -------------------------------------------------------------
class EditMessageRequest(BaseModel):
    content: str

@app.patch("/chat/messages/{msg_id}")
async def edit_message(
    msg_id: int,
    body: EditMessageRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    cm = session.get(ChatMessage, msg_id)
    if not cm:
        raise HTTPException(404, "Message not found")
    if cm.sender_id != current_user.id:
        raise HTTPException(403, "Not your message")
    cm.content   = _filter_bad_words(body.content.strip())
    cm.edited    = True
    cm.edited_at = datetime.now(timezone.utc)
    session.add(cm); session.commit(); session.refresh(cm)
    d = _msg_dict(cm)
    await _chat_broadcast({"type": "message_edit", "message": d})
    return d


@app.post("/chat/messages/{msg_id}/forward")
async def forward_message(
    msg_id: int,
    body: dict,  # {channel_id?, dm_to_user_id?}
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    orig = session.get(ChatMessage, msg_id)
    if not orig or not _can_view_message(current_user, orig):
        raise HTTPException(404, "Message not found")
    channel_id    = body.get("channel_id")
    dm_to_user_id = body.get("dm_to_user_id")
    if not channel_id and not dm_to_user_id:
        raise HTTPException(400, "channel_id or dm_to_user_id required")
    cm = ChatMessage(
        channel_id=channel_id,
        dm_to_user_id=dm_to_user_id,
        sender_id=current_user.id,
        sender_name=current_user.name,
        content=orig.content,
        file_url=orig.file_url,
        file_name=orig.file_name,
        forwarded_from=msg_id,
    )
    session.add(cm); session.commit(); session.refresh(cm)
    d = _msg_dict(cm)
    if channel_id:
        await _chat_broadcast({"type": "channel_message", "message": d})
    elif dm_to_user_id:
        await _chat_send(dm_to_user_id, {"type": "dm", "message": d})
        await _chat_send(current_user.id, {"type": "dm", "message": d})
    return d


# -------------------------------------------------------------
# Bookmarks
# -------------------------------------------------------------
@app.get("/bookmarks")
async def list_bookmarks(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    bms = session.exec(select(Bookmark).where(Bookmark.user_id == current_user.id)
                       .order_by(Bookmark.created_at.desc())).all()
    result = []
    for b in bms:
        cm = session.get(ChatMessage, b.message_id)
        if cm and _can_view_message(current_user, cm):
            d = _msg_dict(cm); d["bookmark_id"] = b.id
            result.append(d)
    return result


@app.post("/bookmarks/{msg_id}", status_code=201)
async def add_bookmark(
    msg_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    existing = session.exec(select(Bookmark).where(
        Bookmark.user_id == current_user.id, Bookmark.message_id == msg_id)).first()
    if existing:
        return {"detail": "Already bookmarked", "id": existing.id}
    cm = session.get(ChatMessage, msg_id)
    if not cm or not _can_view_message(current_user, cm):
        raise HTTPException(404, "Message not found")
    bm = Bookmark(user_id=current_user.id, message_id=msg_id)
    session.add(bm); session.commit(); session.refresh(bm)
    return {"detail": "Bookmarked", "id": bm.id}


@app.delete("/bookmarks/{msg_id}")
async def remove_bookmark(
    msg_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    bm = session.exec(select(Bookmark).where(
        Bookmark.user_id == current_user.id, Bookmark.message_id == msg_id)).first()
    if bm:
        session.delete(bm); session.commit()
    return {"detail": "Removed"}


# -------------------------------------------------------------
# User profiles & avatars
# -------------------------------------------------------------
def _user_profile_dict(u: User, include_email: bool = True) -> dict:
    d = {
        "id":         u.id,
        "name":       u.name,
        "avatar_url": u.avatar_url,
        "status":     u.status,
        "bio":        u.bio,
        "title":      u.title,
        "role":       u.role,
        "joined":     u.created_at.isoformat(),
    }
    if include_email:
        d["email"] = u.email
    return d


@app.get("/users/me/profile")
async def get_my_profile(current_user: User = Depends(get_current_user)):
    return _user_profile_dict(current_user)


class ProfileUpdateRequest(BaseModel):
    name:   Optional[str] = None
    status: Optional[str] = None
    bio:    Optional[str] = None
    title:  Optional[str] = None


@app.patch("/users/me/profile")
async def update_my_profile(
    body: ProfileUpdateRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    u = session.get(User, current_user.id)
    if body.name   is not None and body.name.strip(): u.name = body.name.strip()[:64]
    if body.status is not None: u.status = body.status.strip()[:120]
    if body.bio    is not None: u.bio    = body.bio.strip()[:300]
    if body.title  is not None: u.title  = body.title.strip()[:60] if body.title.strip() else None
    session.add(u); session.commit(); session.refresh(u)
    # Broadcast status change to all online users
    await _chat_broadcast({"type": "user_status", "user_id": u.id, "status": u.status, "name": u.name})
    return _user_profile_dict(u)


AVATAR_DIR = os.path.join(UPLOADS_DIR, "avatars")
os.makedirs(AVATAR_DIR, exist_ok=True)

@app.post("/users/me/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ext   = os.path.splitext(file.filename or "")[1].lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        raise HTTPException(400, "Avatar must be a PNG, JPEG, GIF or WebP image")
    fname = f"av_{current_user.id}{ext}"
    dest  = os.path.join(AVATAR_DIR, fname)
    content = await file.read()
    if len(content) > 4 * 1024 * 1024:
        raise HTTPException(400, "Avatar must be under 4 MB")
    with open(dest, "wb") as f:
        f.write(content)
    u = session.get(User, current_user.id)
    u.avatar_url = f"/uploads/avatars/{fname}"
    session.add(u); session.commit()
    await _chat_broadcast({"type": "user_status", "user_id": u.id, "avatar_url": u.avatar_url})
    return {"avatar_url": u.avatar_url}


@app.get("/users/{user_id}/profile")
async def get_user_profile(
    user_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    u = session.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    return _user_profile_dict(u, include_email=(u.id == current_user.id or _is_staff(current_user)))


# -------------------------------------------------------------
# Channel categories
# -------------------------------------------------------------
class CategoryCreate(BaseModel):
    name:     str
    position: int = 0


@app.get("/channels/categories")
async def list_categories(
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    cats = session.exec(select(ChannelCategory).order_by(ChannelCategory.position)).all()
    return [{"id": c.id, "name": c.name, "position": c.position} for c in cats]


@app.post("/channels/categories", status_code=201)
async def create_category(
    body: CategoryCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    cat = ChannelCategory(name=body.name.strip(), created_by=current_user.id, position=body.position)
    session.add(cat); session.commit(); session.refresh(cat)
    return {"id": cat.id, "name": cat.name, "position": cat.position}


@app.delete("/channels/categories/{cat_id}")
async def delete_category(
    cat_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    cat = session.get(ChannelCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Category not found")
    if cat.created_by != current_user.id:
        raise HTTPException(403, "Not your category")
    session.delete(cat); session.commit()
    return {"detail": "Deleted"}


@app.patch("/chat/channels/{channel_id}/category")
async def set_channel_category(
    channel_id: int,
    body: dict,   # {category_id: int | null}
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ch = session.get(Channel, channel_id)
    if not ch:
        raise HTTPException(404, "Channel not found")
    if not _can_manage_channel(current_user, ch):
        raise HTTPException(403, "Not your channel")
    ch.category_id = body.get("category_id")
    session.add(ch); session.commit()
    return {"detail": "Updated"}


# -------------------------------------------------------------
# Servers (Discord-style) and invite links
# -------------------------------------------------------------
class ServerCreate(BaseModel):
    name: str


@app.get("/servers")
def list_servers(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    ids = _my_server_ids(session, current_user.id)
    if not ids:
        return []
    rows = session.exec(select(ChatServer).where(ChatServer.id.in_(list(ids))).order_by(ChatServer.id)).all()
    roles = {m.server_id: m.role for m in session.exec(
        select(ServerMember).where(ServerMember.user_id == current_user.id)).all()}
    return [_server_dict(s, roles.get(s.id, "member")) for s in rows]


@app.post("/servers", status_code=201)
def create_server(
    body: ServerCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    name = body.name.strip()[:64]
    if not name:
        raise HTTPException(400, "Server name required")
    srv = ChatServer(name=name, owner_id=current_user.id, is_home=False)
    session.add(srv)
    session.commit()
    session.refresh(srv)
    _join_server(session, srv.id, current_user.id, "owner")
    general = Channel(name="\U0001f4e3 general", description="General chat",
                      created_by=current_user.id, server_id=srv.id)
    session.add(general)
    session.commit()
    session.refresh(general)
    log.info("Server '%s' created by %s", name, current_user.name)
    return {**_server_dict(srv, "owner"), "channels": [_channel_dict(general)]}


def _owned_server(session: Session, user: User, server_id: int) -> ChatServer:
    srv = session.get(ChatServer, server_id)
    if not srv:
        raise HTTPException(404, "Server not found")
    mem = session.exec(select(ServerMember).where(
        ServerMember.server_id == server_id, ServerMember.user_id == user.id)).first()
    if not mem or mem.role != "owner":
        raise HTTPException(403, "Only the server owner can change its picture")
    return srv


SERVER_ICON_DIR = os.path.join(UPLOADS_DIR, "servers")
os.makedirs(SERVER_ICON_DIR, exist_ok=True)


@app.post("/servers/{server_id}/icon")
async def upload_server_icon(
    server_id: int,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    srv = _owned_server(session, current_user, server_id)
    ext = os.path.splitext(file.filename or "")[1].lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        raise HTTPException(400, "Server picture must be a PNG, JPEG, GIF or WebP image")
    content = await file.read()
    if len(content) > 4 * 1024 * 1024:
        raise HTTPException(400, "Server picture must be under 4 MB")
    for old_ext in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        old = os.path.join(SERVER_ICON_DIR, f"srv_{server_id}{old_ext}")
        if os.path.exists(old):
            os.remove(old)
    fname = f"srv_{server_id}{ext}"
    with open(os.path.join(SERVER_ICON_DIR, fname), "wb") as f:
        f.write(content)
    srv.icon_url = f"/uploads/servers/{fname}?v={int(time.time())}"
    session.add(srv)
    session.commit()
    await _chat_broadcast({"type": "server_icon", "server_id": srv.id, "icon_url": srv.icon_url})
    return _server_dict(srv, "owner")


@app.delete("/servers/{server_id}/icon")
async def remove_server_icon(
    server_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    srv = _owned_server(session, current_user, server_id)
    for old_ext in (".png", ".jpg", ".jpeg", ".gif", ".webp"):
        old = os.path.join(SERVER_ICON_DIR, f"srv_{server_id}{old_ext}")
        if os.path.exists(old):
            os.remove(old)
    srv.icon_url = None
    session.add(srv)
    session.commit()
    await _chat_broadcast({"type": "server_icon", "server_id": srv.id, "icon_url": None})
    return _server_dict(srv, "owner")


@app.post("/servers/{server_id}/leave")
def leave_server(
    server_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    srv = session.get(ChatServer, server_id)
    if not srv:
        raise HTTPException(404, "Server not found")
    if srv.is_home:
        raise HTTPException(400, "The home server is shared by everyone")
    mem = session.exec(select(ServerMember).where(
        ServerMember.server_id == server_id, ServerMember.user_id == current_user.id)).first()
    if not mem:
        raise HTTPException(404, "You're not in that server")
    session.delete(mem)
    others = session.exec(select(ServerMember).where(
        ServerMember.server_id == server_id, ServerMember.user_id != current_user.id)).all()
    deleted = False
    if not others:
        for ch in session.exec(select(Channel).where(Channel.server_id == server_id)).all():
            session.delete(ch)
        session.delete(srv)
        deleted = True
    elif mem.role == "owner":
        nxt = others[0]
        nxt.role = "owner"
        srv.owner_id = nxt.user_id
        session.add(nxt)
        session.add(srv)
    session.commit()
    return {"ok": True, "deleted": deleted}


@app.post("/invite")
async def create_invite(
    body: dict,   # {server_id?, channel_id?, max_uses?, expires_hours?}
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    code       = secrets.token_urlsafe(8)
    channel_id = body.get("channel_id")
    server_id  = body.get("server_id")
    max_uses   = body.get("max_uses")
    exp_hours  = body.get("expires_hours")
    ch = session.get(Channel, channel_id) if channel_id is not None else None
    if channel_id is not None and not ch:
        raise HTTPException(404, "Channel not found")
    if server_id is None and ch:
        server_id = ch.server_id
    if not server_id or not _is_server_member(session, current_user.id, server_id):
        raise HTTPException(403, "You can only invite people to a server you're in")
    expires_at = None
    if exp_hours:
        expires_at = datetime.now(timezone.utc) + timedelta(hours=int(exp_hours))
    inv = InviteLink(code=code, channel_id=channel_id, server_id=server_id,
                     created_by=current_user.id, max_uses=max_uses, expires_at=expires_at)
    session.add(inv); session.commit(); session.refresh(inv)
    return {"code": code, "url": f"/invite/{code}", "channel_id": channel_id,
            "server_id": server_id, "expires_at": expires_at.isoformat() if expires_at else None}


@app.get("/invite/{code}")
async def use_invite(
    code: str,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    inv = session.exec(select(InviteLink).where(InviteLink.code == code)).first()
    if not inv:
        raise HTTPException(404, "Invite not found or expired")
    now_utc = datetime.now(timezone.utc)
    if inv.expires_at and inv.expires_at.replace(tzinfo=timezone.utc) < now_utc:
        raise HTTPException(410, "Invite has expired")
    ch = session.get(Channel, inv.channel_id) if inv.channel_id else None
    server_id = inv.server_id or (ch.server_id if ch else None)
    already = bool(server_id and session.exec(select(ServerMember).where(
        ServerMember.server_id == server_id, ServerMember.user_id == current_user.id)).first())
    if not already:
        if inv.max_uses and inv.uses >= inv.max_uses:
            raise HTTPException(410, "Invite has reached maximum uses")
        inv.uses += 1
        session.add(inv)
        if server_id:
            _join_server(session, server_id, current_user.id)
        session.commit()
    srv = session.get(ChatServer, server_id) if server_id else None
    return {
        "code":       code,
        "channel_id": inv.channel_id,
        "channel":    {"id": ch.id, "name": ch.name} if ch else None,
        "server_id":  server_id,
        "server":     {"id": srv.id, "name": srv.name} if srv else None,
        "joined":     not already,
        "uses":       inv.uses,
    }


# -------------------------------------------------------------
# Link preview
# -------------------------------------------------------------
async def _is_public_http_url(url: str) -> bool:
    """Reject non-http(s) URLs and hosts that resolve to private, loopback or link-local addresses."""
    import ipaddress
    import socket
    from urllib.parse import urlparse
    try:
        p = urlparse(url)
    except ValueError:
        return False
    if p.scheme not in ("http", "https") or not p.hostname:
        return False
    try:
        infos = await _asyncio.get_running_loop().getaddrinfo(p.hostname, p.port or (443 if p.scheme == "https" else 80),
                                                              type=socket.SOCK_STREAM)
    except OSError:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            return False
    return bool(infos)


@app.get("/link-preview")
async def link_preview(url: str, current_user: User = Depends(get_current_user)):
    """Fetch OG metadata from an external URL and return title/desc/image."""
    empty = {"title": url, "description": "", "image": "", "site": "", "url": url}
    try:
        target = url
        async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
            for _ in range(4):
                if not await _is_public_http_url(target):
                    return empty
                r = await client.get(target, headers={"User-Agent": "SyncTact/1.0 (link preview bot)"})
                if r.is_redirect and r.headers.get("location"):
                    target = str(r.url.join(r.headers["location"]))
                    continue
                break
            else:
                return empty
        if "html" not in r.headers.get("content-type", ""):
            return empty
        soup = BeautifulSoup(r.text[:500_000], "html.parser")

        def meta(prop: str) -> str:
            tag = soup.find("meta", property=prop) or soup.find("meta", attrs={"name": prop})
            return (tag.get("content") or "").strip() if tag else ""

        title   = meta("og:title") or meta("twitter:title") or (soup.title.string.strip() if soup.title else "")
        desc    = meta("og:description") or meta("description") or meta("twitter:description")
        image   = meta("og:image") or meta("twitter:image")
        site    = meta("og:site_name")
        if not image.startswith(("https://", "http://")):
            image = ""
        return {
            "title":       title[:200] if title else url,
            "description": desc[:300],
            "image":       image[:500],
            "site":        site[:100],
            "url":         url,
        }
    except Exception:
        return {"title": url, "description": "", "image": "", "site": "", "url": url}


# -------------------------------------------------------------
# Per-channel notification preferences
# -------------------------------------------------------------
class ChannelNotifPref(SQLModel, table=True):
    id:         Optional[int] = Field(default=None, primary_key=True)
    user_id:    int           = Field(foreign_key="user.id", index=True)
    channel_id: int           = Field(foreign_key="channel.id", index=True)
    muted:      bool          = Field(default=False)


@app.get("/notifications/prefs")
def get_notif_prefs(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(ChannelNotifPref).where(ChannelNotifPref.user_id == current_user.id)
    ).all()
    return {r.channel_id: {"muted": r.muted} for r in rows}


@app.put("/notifications/prefs/{channel_id}")
def set_notif_pref(
    channel_id: int,
    muted: bool,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    row = session.exec(
        select(ChannelNotifPref)
        .where(ChannelNotifPref.user_id == current_user.id)
        .where(ChannelNotifPref.channel_id == channel_id)
    ).first()
    if row:
        row.muted = muted
    else:
        row = ChannelNotifPref(user_id=current_user.id, channel_id=channel_id, muted=muted)
        session.add(row)
    session.commit()
    return {"channel_id": channel_id, "muted": muted}


# -------------------------------------------------------------
# Image / media gallery for a channel
# -------------------------------------------------------------
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".mp4", ".webm", ".mov"}

@app.get("/chat/channels/{channel_id}/gallery")
def channel_gallery(
    channel_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    msgs = session.exec(
        select(ChatMessage)
        .where(ChatMessage.channel_id == channel_id)
        .where(ChatMessage.file_url != None)  # noqa: E711
        .order_by(ChatMessage.created_at.desc())
        .limit(200)
    ).all()
    items = []
    for m in msgs:
        ext = os.path.splitext((m.file_name or "").lower())[1]
        if ext in IMAGE_EXTS:
            items.append({
                "msg_id":    m.id,
                "file_url":  m.file_url,
                "file_name": m.file_name,
                "sender":    m.sender_name,
                "ts":        m.created_at.isoformat() if m.created_at else None,
            })
    return items


# -------------------------------------------------------------
# Volt message endpoint (slash commands post result here)
# -------------------------------------------------------------
class SyncBotRequest(BaseModel):
    channel_id:    Optional[int] = None
    dm_to_user_id: Optional[int] = None
    content:       str
    bot_name:      str = "Volt"
    volt_target:   str = "self"   # "self" = ephemeral (only requester) | "channel" = broadcast (owner only)


@app.post("/chat/syncbot", status_code=201)
async def syncbot_message(
    body: SyncBotRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # Determine actual delivery mode
    target = body.volt_target if body.volt_target in ("self", "channel") else "self"

    # Only channel owners / moderators may broadcast Volt; DMs are always ephemeral
    if target == "channel":
        if not body.channel_id or not _can_manage_channel(current_user, session.get(Channel, body.channel_id)):
            target = "self"  # silently downgrade

    if target == "channel":
        # Save to DB so it appears in history for everyone
        cm = ChatMessage(
            channel_id=body.channel_id,
            dm_to_user_id=body.dm_to_user_id,
            sender_id=0,
            sender_name=body.bot_name,
            content=body.content.strip(),
            bot_name=body.bot_name,
        )
        session.add(cm)
        session.commit()
        session.refresh(cm)
        d = _msg_dict(cm)
        if cm.channel_id:
            await _chat_broadcast({"type": "channel_message", "message": d})
        elif cm.dm_to_user_id:
            await _chat_send(cm.dm_to_user_id, {"type": "dm", "message": d})
            await _chat_send(current_user.id, {"type": "dm", "message": d})
        return d
    else:
        # Ephemeral: only deliver to the requesting user, do NOT persist in DB
        from datetime import datetime, timezone
        d = {
            "id":            None,
            "channel_id":    body.channel_id,
            "dm_to_user_id": body.dm_to_user_id,
            "sender_id":     0,
            "sender_name":   body.bot_name,
            "content":       body.content.strip(),
            "file_url":      None,
            "file_name":     None,
            "reactions":     {},
            "pinned":        False,
            "parent_id":     None,
            "bot_name":      body.bot_name,
            "ts":            datetime.now(timezone.utc).isoformat(),
            "ephemeral":     True,
        }
        if body.channel_id:
            await _chat_send(current_user.id, {"type": "channel_message", "message": d})
        else:
            await _chat_send(current_user.id, {"type": "dm", "message": d})
        return d


# -------------------------------------------------------------
# Bot (custom webhook bots) endpoints
# -------------------------------------------------------------
class CreateBotRequest(BaseModel):
    name:   str
    avatar: str = "🤖"


class WebhookPayload(BaseModel):
    content:    str
    channel_id: Optional[int] = None
    open_url:   Optional[str] = None   # https link offered to clients
    url_target: str           = "self" # "self" = only bot owner | "channel" = everyone (bot owner must own channel)


@app.get("/bots")
def list_bots(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    bots = session.exec(select(Bot).where(Bot.owner_id == current_user.id)).all()
    return [
        {
            "id":            b.id,
            "name":          b.name,
            "avatar":        b.avatar,
            "webhook_token": b.webhook_token,
            "created_at":    b.created_at.isoformat(),
        }
        for b in bots
    ]


@app.post("/bots", status_code=201)
def create_bot(
    body: CreateBotRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    token = secrets.token_urlsafe(32)
    bot = Bot(
        owner_id=current_user.id,
        name=body.name.strip()[:40],
        avatar=(body.avatar or "🤖")[:8],
        webhook_token=token,
    )
    session.add(bot)
    session.commit()
    session.refresh(bot)
    return {
        "id":            bot.id,
        "name":          bot.name,
        "avatar":        bot.avatar,
        "webhook_token": bot.webhook_token,
        "created_at":    bot.created_at.isoformat(),
    }


@app.delete("/bots/{bot_id}")
def delete_bot(
    bot_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    bot = session.get(Bot, bot_id)
    if not bot or bot.owner_id != current_user.id:
        raise HTTPException(404, "Bot not found")
    session.delete(bot)
    session.commit()
    return {"ok": True}


@app.post("/bots/webhook/{token}", status_code=201)
async def bot_webhook(
    token: str,
    body: WebhookPayload,
    session: Session = Depends(get_session),
):
    bot = session.exec(select(Bot).where(Bot.webhook_token == token)).first()
    if not bot:
        raise HTTPException(404, "Bot not found")
    if not body.content.strip():
        raise HTTPException(400, "content required")
    if not body.channel_id or not session.get(Channel, body.channel_id):
        raise HTTPException(400, "A valid channel_id is required")
    cm = ChatMessage(
        channel_id=body.channel_id,
        sender_id=0,
        sender_name=bot.name,
        content=body.content.strip()[:4000],
        bot_name=f"{bot.avatar} {bot.name}",
    )
    session.add(cm)
    session.commit()
    session.refresh(cm)
    d = _msg_dict(cm)
    bcast = {"type": "channel_message", "message": d}
    bcast.update(_open_url_fields(session, body.open_url, body.url_target, bot.owner_id, cm.channel_id))
    await _chat_broadcast(bcast)
    return d


def _open_url_fields(session: Session, url: Optional[str], target: str, owner_id: int, channel_id: int) -> dict:
    """Extra broadcast fields offering a link. Only https links; "channel" target needs channel-manager rights."""
    if not url or not url.startswith("https://") or len(url) > 2000:
        return {}
    owner = session.get(User, owner_id)
    if target == "channel" and owner and _can_manage_channel(owner, session.get(Channel, channel_id)):
        return {"open_url": url}
    return {"open_url": url, "open_url_for_uid": owner_id}


# -------------------------------------------------------------
# Recurring Tasks
# -------------------------------------------------------------
class CreateTaskRequest(BaseModel):
    channel_id:       Optional[int] = None
    message:          str
    interval_minutes: int           = 60          # minimum 1 minute
    open_url:         Optional[str] = None        # https link offered when the task fires
    url_target:       str           = "self"      # "self" = only owner | "channel" = everyone (must own channel)


@app.get("/tasks")
def list_tasks(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    tasks = session.exec(
        select(RecurringTask).where(RecurringTask.owner_id == current_user.id)
        .order_by(RecurringTask.created_at)
    ).all()
    return [_task_dict(t) for t in tasks]


@app.post("/tasks", status_code=201)
def create_task(
    body: CreateTaskRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not body.message.strip():
        raise HTTPException(400, "message required")
    ch = session.get(Channel, body.channel_id) if body.channel_id else None
    if not ch:
        raise HTTPException(400, "A valid channel_id is required")
    if body.open_url and not body.open_url.startswith("https://"):
        raise HTTPException(400, "open_url must start with https://")
    target = body.url_target if body.url_target in ("self", "channel") else "self"
    if target == "channel" and not _can_manage_channel(current_user, ch):
        target = "self"  # silently downgrade — not the channel owner
    t = RecurringTask(
        owner_id=current_user.id,
        channel_id=body.channel_id,
        message=body.message.strip(),
        interval_minutes=max(1, body.interval_minutes),
        open_url=body.open_url or None,
        url_target=target,
    )
    session.add(t); session.commit(); session.refresh(t)
    return _task_dict(t)


@app.delete("/tasks/{task_id}")
def delete_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = session.get(RecurringTask, task_id)
    if not t or t.owner_id != current_user.id:
        raise HTTPException(404, "Task not found")
    session.delete(t); session.commit()
    return {"ok": True}


@app.patch("/tasks/{task_id}/toggle")
def toggle_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = session.get(RecurringTask, task_id)
    if not t or t.owner_id != current_user.id:
        raise HTTPException(404, "Task not found")
    t.active = not t.active
    session.add(t); session.commit()
    return _task_dict(t)


# -------------------------------------------------------------
# Chat WebSocket
# -------------------------------------------------------------
@app.websocket("/ws/chat/{user_id}")
async def chat_ws(ws: WebSocket, user_id: int, token: str = Query(...)):
    # Authenticate via token query param
    with Session(engine) as session:
        db_user = _user_for_token(token, session)
    if not db_user or db_user.id != user_id:
        await ws.close(code=4001)
        return

    await ws.accept()

    with Session(engine) as session:
        db_user = session.get(User, user_id)
        uname   = db_user.name if db_user else f"User{user_id}"
        # Reject banned users
        if db_user and db_user.banned:
            await ws.send_text(json.dumps({"type": "moderation", "action": "banned", "by": "system"}))
            await ws.close(code=4003)
            return

    chat_connections[user_id] = ws
    log.info("[chat] user %d connected  (total online: %d)", user_id, len(chat_connections))

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
                file_url   = _safe_file_url(msg.get("file_url"))
                file_name  = str(msg.get("file_name") or "")[:200] or None if file_url else None
                content    = content[:4000]
                if not content and not file_url:
                    continue
                with Session(engine) as session:
                    ch = session.get(Channel, channel_id) if isinstance(channel_id, int) else None
                    if not ch:
                        continue
                    if not _is_server_member(session, user_id, ch.server_id):
                        await ws.send_text(json.dumps({"type": "error", "message": "Join this server before posting."}))
                        continue
                    # Kick check
                    kicked = session.exec(
                        select(KickedUser).where(KickedUser.user_id == user_id,
                                                  KickedUser.channel_id == channel_id)
                    ).first()
                    if kicked:
                        await ws.send_text(json.dumps({"type": "error", "message": "You have been removed from this channel."}))
                        continue
                    # Mute check
                    now_utc = datetime.now(timezone.utc)
                    mute = session.exec(
                        select(MutedUser).where(
                            MutedUser.user_id == user_id,
                            (MutedUser.channel_id == channel_id) | (MutedUser.channel_id == None)  # noqa: E711
                        )
                    ).first()
                    if mute:
                        if mute.muted_until is None or mute.muted_until.replace(tzinfo=timezone.utc) > now_utc:
                            await ws.send_text(json.dumps({"type": "error", "message": "You are muted in this channel."}))
                            continue
                        else:
                            # Mute expired — clean up
                            session.delete(mute); session.commit()
                    # Slowmode check
                    ch = session.get(Channel, channel_id)
                    if ch and ch.slowmode_seconds > 0:
                        key = (user_id, channel_id)
                        last = _slowmode_last.get(key, 0)
                        elapsed = _time_mod.time() - last
                        if elapsed < ch.slowmode_seconds:
                            wait = int(ch.slowmode_seconds - elapsed) + 1
                            await ws.send_text(json.dumps({"type": "error",
                                "message": f"Slowmode: please wait {wait}s before sending again."}))
                            continue
                        _slowmode_last[key] = _time_mod.time()
                    # Readonly check
                    if ch and ch.readonly:
                        with Session(engine) as s2:
                            u2 = s2.get(User, user_id)
                        if not u2 or u2.role not in ('admin', 'moderator'):
                            await ws.send_text(json.dumps({"type": "error", "message": "This channel is read-only."}))
                            continue
                    # /remind slash command
                    if content and content.lower().startswith("/remind "):
                        # /remind me in 30m to do something  OR  /remind me at 2026-03-05T10:00 to ...
                        import re as _re
                        m_rel = _re.search(r'in\s+(\d+)\s*m(?:in)?', content, _re.I)
                        m_abs = _re.search(r'at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})', content, _re.I)
                        note  = _re.sub(r'^/remind\s+me\s+(in\s+\d+\s*m(?:in)?\s+to?|at\s+\S+\s+to?)\s*', '', content, flags=_re.I).strip() or content
                        if m_rel:
                            at = datetime.now(timezone.utc) + timedelta(minutes=int(m_rel.group(1)))
                        elif m_abs:
                            at = datetime.fromisoformat(m_abs.group(1))
                        else:
                            at = datetime.now(timezone.utc) + timedelta(minutes=30)
                        with Session(engine) as rs:
                            rs.add(Reminder(user_id=user_id, channel_id=channel_id, content=note, remind_at=at))
                            rs.commit()
                        await ws.send_text(json.dumps({"type": "system_msg",
                            "message": f"⏰ Reminder set for {at.strftime('%Y-%m-%d %H:%M')} UTC: {note}"}))
                        continue
                    # Bad words filter
                    if content:
                        content = _filter_bad_words(content)
                    cm = ChatMessage(
                        channel_id=channel_id, sender_id=user_id, sender_name=uname,
                        content=content, file_url=file_url, file_name=file_name,
                    )
                    session.add(cm); session.commit(); session.refresh(cm)
                    cm_dict = _msg_dict(cm)
                    # XP reward: 5 XP per message, level up every 100 XP
                    xp_rec = session.exec(select(UserXP).where(UserXP.user_id == user_id)).first()
                    if not xp_rec:
                        xp_rec = UserXP(user_id=user_id, xp=0, level=1)
                        session.add(xp_rec)
                    xp_rec.xp += 5
                    new_level = max(1, xp_rec.xp // 100 + 1)
                    leveled_up = new_level > xp_rec.level
                    xp_rec.level = new_level
                    xp_rec.updated_at = datetime.now(timezone.utc)
                    session.add(xp_rec); session.commit()
                await _chat_broadcast({"type": "channel_message", "message": cm_dict})
                if leveled_up:
                    await _chat_broadcast({"type": "level_up", "user_id": user_id,
                                           "user_name": uname, "level": new_level,
                                           "channel_id": channel_id})
                # @Volt mention: reply with Gemini AI
                if content and '@volt' in content.lower():
                    prompt_text = content  # the user's message
                    hist_msgs = []
                    with Session(engine) as hs:
                        hist_msgs = hs.exec(
                            select(ChatMessage)
                            .where(ChatMessage.channel_id == channel_id, ChatMessage.bot_name == None)
                            .order_by(ChatMessage.created_at.desc()).limit(10)
                        ).all()
                    context_txt = '\n'.join(f"{m.sender_name}: {m.content}" for m in reversed(hist_msgs) if m.content)
                    ai_prompt = (
                        f"You are Volt, a helpful smart assistant in a team chat app.\n"
                        f"Recent chat context:\n{context_txt}\n\n"
                        f"User ({uname}) says: {prompt_text}\n\n"
                        f"Reply helpfully and concisely (2-3 sentences max)."
                    )
                    _volt_reply = await _volt_generate([{"role": "user", "parts": [{"text": ai_prompt}]}])
                    if _volt_reply:
                        with Session(engine) as vs:
                            volt_cm = ChatMessage(
                                channel_id=channel_id, sender_id=0, sender_name="Volt",
                                content=_volt_reply, bot_name="Volt",
                            )
                            vs.add(volt_cm); vs.commit(); vs.refresh(volt_cm)
                        await _chat_broadcast({"type": "channel_message", "message": _msg_dict(volt_cm)})

            # -- Direct message --
            elif mtype == "dm":
                to_uid    = msg.get("to_user_id")
                content   = (msg.get("content") or "").strip()[:4000]
                file_url  = _safe_file_url(msg.get("file_url"))
                file_name = str(msg.get("file_name") or "")[:200] or None if file_url else None
                if (not content and not file_url) or not isinstance(to_uid, int) or to_uid == user_id:
                    continue
                with Session(engine) as session:
                    if not session.get(User, to_uid):
                        continue
                    if to_uid == VOLT_USER_ID:
                        cm = ChatMessage(channel_id=None, dm_to_user_id=to_uid, sender_id=user_id,
                                         sender_name=uname, content=content, file_url=file_url, file_name=file_name)
                        session.add(cm); session.commit(); session.refresh(cm)
                        await _chat_send(user_id, {"type": "dm", "message": _msg_dict(cm)})
                        if content:
                            asyncio.create_task(_volt_dm_reply(user_id))
                        continue
                    blocked = session.exec(select(UserBlock).where(
                        UserBlock.blocker_id == to_uid, UserBlock.blocked_id == user_id)).first()
                    if blocked:
                        await ws.send_text(json.dumps({"type": "error", "message": "You can't message this user."}))
                        continue
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
                emoji  = _clean_emoji(msg.get("emoji"))
                if not emoji or not msg_id:
                    continue
                with Session(engine) as session:
                    cm = session.get(ChatMessage, msg_id)
                    if not cm or not _can_view_message(db_user, cm):
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
                    session.add(cm); session.commit(); session.refresh(cm)
                    await _send_for_message(cm, {"type": "reaction_update", "message_id": msg_id, "reactions": reacts})

            # -- Read receipt (DM seen) --
            elif mtype == "mark_dm_read":
                to_uid = msg.get("to_user_id")
                if to_uid:
                    await _chat_send(to_uid, {
                        "type":       "dm_read",
                        "by_user_id": user_id,
                        "by_name":    uname,
                    })

            # -- Thread reply --
            elif mtype == "thread_reply":
                parent_id  = msg.get("parent_id")
                content    = (msg.get("content") or "").strip()[:4000]
                if not content or not parent_id:
                    continue
                with Session(engine) as session:
                    parent = session.get(ChatMessage, parent_id)
                    if not parent or not _can_view_message(db_user, parent):
                        continue
                    # Replies always live where the parent lives.
                    if parent.channel_id is not None:
                        dm_uid = None
                    else:
                        dm_uid = parent.dm_to_user_id if parent.sender_id == user_id else parent.sender_id
                    cm = ChatMessage(
                        channel_id=parent.channel_id, dm_to_user_id=dm_uid,
                        sender_id=user_id, sender_name=uname,
                        content=_filter_bad_words(content), parent_id=parent_id,
                    )
                    session.add(cm); session.commit(); session.refresh(cm)
                    await _send_for_message(cm, {"type": "thread_reply", "message": _msg_dict(cm)})

    except (WebSocketDisconnect, Exception) as exc:
        if not isinstance(exc, WebSocketDisconnect):
            log.warning("[chat] user %d error: %s", user_id, exc)
    finally:
        # A newer tab may have replaced this socket; only that tab's disconnect should remove it.
        if chat_connections.get(user_id) is ws:
            chat_connections.pop(user_id, None)
            log.info("[chat] user %d disconnected", user_id)
            await _chat_broadcast({"type": "presence", "user_id": user_id, "online": False})


# =============================================================
# ── Purge messages (bulk delete) ──────────────────────────────
# =============================================================
@app.delete("/chat/channels/{channel_id}/purge")
async def purge_messages(
    channel_id: int,
    count: int = 10,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if current_user.role not in ('admin', 'moderator'):
        raise HTTPException(403, "Moderators only")
    count = max(1, min(count, 100))
    msgs = session.exec(
        select(ChatMessage)
        .where(ChatMessage.channel_id == channel_id, ChatMessage.bot_name == None)
        .order_by(ChatMessage.created_at.desc())
        .limit(count)
    ).all()
    ids = [m.id for m in msgs]
    for m in msgs:
        session.delete(m)
    session.commit()
    _log_audit(session, "purge", current_user.id, current_user.name,
               channel_id=channel_id, detail=f"Purged {len(ids)} messages")
    for mid in ids:
        await _chat_broadcast({"type": "message_deleted", "message_id": mid})
    return {"ok": True, "deleted": len(ids)}


# =============================================================
# ── Warnings ──────────────────────────────────────────────────
# =============================================================
class WarnRequest(BaseModel):
    user_id:    int
    reason:     str
    channel_id: Optional[int] = None

@app.post("/mod/warn", status_code=201)
async def warn_user(
    body: WarnRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if current_user.role not in ('admin', 'moderator'):
        raise HTTPException(403, "Moderators only")
    target = session.get(User, body.user_id)
    if not target:
        raise HTTPException(404, "User not found")
    w = UserWarning(
        user_id=target.id, user_name=target.name,
        reason=body.reason, warned_by=current_user.id,
        warned_by_name=current_user.name, channel_id=body.channel_id,
    )
    session.add(w); session.commit(); session.refresh(w)
    _log_audit(session, "warn_user", current_user.id, current_user.name,
               target.id, target.name, body.channel_id, body.reason)
    await _chat_send(target.id, {
        "type": "system_msg",
        "message": f"⚠️ You received a warning from {current_user.name}: {body.reason}"
    })
    return {"ok": True, "warning_id": w.id}

@app.get("/mod/warnings/{user_id}")
def get_warnings(
    user_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if current_user.role not in ('admin', 'moderator') and current_user.id != user_id:
        raise HTTPException(403)
    ws = session.exec(select(UserWarning).where(UserWarning.user_id == user_id).order_by(UserWarning.created_at.desc())).all()
    return [{"id": w.id, "reason": w.reason, "warned_by": w.warned_by_name,
             "created_at": w.created_at.isoformat()} for w in ws]


# =============================================================
# ── XP / Leaderboard ──────────────────────────────────────────
# =============================================================
@app.get("/users/xp")
def get_xp_leaderboard(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    rows = session.exec(select(UserXP).order_by(UserXP.xp.desc()).limit(20)).all()
    result = []
    for r in rows:
        u = session.get(User, r.user_id)
        result.append({"user_id": r.user_id, "name": u.name if u else f"User{r.user_id}",
                       "xp": r.xp, "level": r.level})
    return result

@app.get("/users/me/xp")
def get_my_xp(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    xp_rec = session.exec(select(UserXP).where(UserXP.user_id == current_user.id)).first()
    if not xp_rec:
        return {"xp": 0, "level": 1, "next_level_xp": 100}
    next_xp = xp_rec.level * 100
    return {"xp": xp_rec.xp, "level": xp_rec.level, "next_level_xp": next_xp}


@app.get("/users/{user_id}/xp")
def get_user_xp(
    user_id: int,
    _: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    xp_rec = session.exec(select(UserXP).where(UserXP.user_id == user_id)).first()
    if not xp_rec:
        return {"xp": 0, "level": 1}
    return {"xp": xp_rec.xp, "level": xp_rec.level}


async def _gemini_or_http_error(prompt: str) -> str:
    try:
        text = await gemini_generate([{"role": "user", "parts": [{"text": prompt}]}])
    except GeminiError as e:
        if e.busy:
            raise HTTPException(503, "The AI service is busy right now. Please try again in a minute.")
        raise HTTPException(502, str(e))
    if not text:
        raise HTTPException(502, "The AI service returned an empty response")
    return text


# =============================================================
# ── AI Channel Summarizer ─────────────────────────────────────
# =============================================================
@app.get("/chat/channels/{channel_id}/summarize")
async def summarize_channel(
    channel_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    if not GEMINI_API_KEY:
        raise HTTPException(400, "GEMINI_API_KEY not configured")
    msgs = session.exec(
        select(ChatMessage)
        .where(ChatMessage.channel_id == channel_id, ChatMessage.bot_name == None)
        .order_by(ChatMessage.created_at.desc())
        .limit(50)
    ).all()
    if not msgs:
        return {"summary": "No messages to summarize yet."}
    msgs = list(reversed(msgs))
    transcript = "\n".join(f"{m.sender_name}: {m.content}" for m in msgs if m.content)
    prompt = (
        "You are a helpful assistant summarizing a chat channel.\n"
        "Summarize the following conversation in 3-5 bullet points. Be concise and factual.\n\n"
        + transcript
    )
    summary = await _gemini_or_http_error(prompt)
    return {"summary": summary}


# =============================================================
# ── Channel Analytics ─────────────────────────────────────────
# =============================================================
@app.get("/chat/channels/{channel_id}/analytics")
def channel_analytics(
    channel_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    import collections
    msgs = session.exec(
        select(ChatMessage)
        .where(ChatMessage.channel_id == channel_id, ChatMessage.bot_name == None)
        .order_by(ChatMessage.created_at)
    ).all()
    now = datetime.now(timezone.utc)
    week_ago = now - timedelta(days=7)
    # per-day counts last 7 days
    day_counts: dict = collections.defaultdict(int)
    hour_counts: dict = collections.defaultdict(int)
    user_counts: dict = collections.defaultdict(int)
    user_names: dict = {}
    week_msgs = []
    for m in msgs:
        ts = m.created_at if m.created_at.tzinfo else m.created_at.replace(tzinfo=timezone.utc)
        if ts >= week_ago:
            week_msgs.append(m)
            day_counts[ts.strftime("%a")] += 1
            hour_counts[ts.hour] += 1
        user_counts[m.sender_id] += 1
        user_names[m.sender_id] = m.sender_name
    top_users = sorted(user_counts.items(), key=lambda x: -x[1])[:5]
    days_order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    return {
        "total_messages": len(msgs),
        "messages_this_week": len(week_msgs),
        "messages_per_day": {d: day_counts.get(d, 0) for d in days_order},
        "messages_per_hour": {str(h): hour_counts.get(h, 0) for h in range(24)},
        "top_users": [{"id": uid, "name": user_names[uid], "count": cnt} for uid, cnt in top_users],
    }


# =============================================================
# ── Task Board ───────────────────────────────────────────────
# =============================================================
class TaskCreate(BaseModel):
    channel_id:    Optional[int]  = None
    title:         str
    description:   Optional[str]  = None
    assignee_id:   Optional[int]  = None
    assignee_name: Optional[str]  = None

class TaskUpdate(BaseModel):
    title:         Optional[str]  = None
    description:   Optional[str]  = None
    assignee_id:   Optional[int]  = None
    assignee_name: Optional[str]  = None
    status:        Optional[str]  = None  # todo | doing | done

def _board_task_dict(t: Task) -> dict:
    return {
        "id": t.id, "channel_id": t.channel_id,
        "creator_id": t.creator_id, "creator_name": t.creator_name,
        "title": t.title, "description": t.description,
        "assignee_id": t.assignee_id, "assignee_name": t.assignee_name,
        "status": t.status,
        "created_at": t.created_at.isoformat(),
    }

@app.get("/board-tasks")
def list_board_tasks(
    channel_id: Optional[int] = None,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    stmt = select(Task)
    if channel_id is not None:
        stmt = stmt.where(Task.channel_id == channel_id)
    tasks = session.exec(stmt.order_by(Task.created_at)).all()
    return [_board_task_dict(t) for t in tasks]

@app.post("/board-tasks", status_code=201)
async def create_board_task(
    body: TaskCreate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = Task(
        channel_id=body.channel_id, creator_id=current_user.id,
        creator_name=current_user.name, title=body.title.strip(),
        description=body.description, assignee_id=body.assignee_id,
        assignee_name=body.assignee_name,
    )
    session.add(t); session.commit(); session.refresh(t)
    td = _board_task_dict(t)
    await _chat_broadcast({"type": "task_created", "task": td})
    return td

@app.patch("/board-tasks/{task_id}")
async def update_board_task(
    task_id: int,
    body: TaskUpdate,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = session.get(Task, task_id)
    if not t:
        raise HTTPException(404, "Task not found")
    if current_user.id not in (t.creator_id, t.assignee_id) and not _is_staff(current_user):
        raise HTTPException(403, "Only the creator, the assignee or a moderator can edit this task")
    if body.status is not None and body.status not in ("todo", "doing", "done"):
        raise HTTPException(400, "status must be todo, doing or done")
    if body.title         is not None: t.title         = body.title.strip()
    if body.description   is not None: t.description   = body.description
    if body.assignee_id   is not None: t.assignee_id   = body.assignee_id
    if body.assignee_name is not None: t.assignee_name = body.assignee_name
    if body.status        is not None: t.status        = body.status
    session.add(t); session.commit(); session.refresh(t)
    td = _board_task_dict(t)
    await _chat_broadcast({"type": "task_updated", "task": td})
    return td

@app.delete("/board-tasks/{task_id}")
async def delete_board_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    t = session.get(Task, task_id)
    if not t:
        raise HTTPException(404)
    if t.creator_id != current_user.id and not _is_staff(current_user):
        raise HTTPException(403, "Only the creator or a moderator can delete this task")
    session.delete(t); session.commit()
    await _chat_broadcast({"type": "task_deleted", "task_id": task_id})
    return {"ok": True}


# =============================================================
# ── Meeting Notes Auto-Summary ────────────────────────────────
# =============================================================
@app.post("/chat/channels/{channel_id}/meeting-summary")
async def meeting_summary(
    channel_id: int,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """Summarize messages from the last 2 hours as meeting notes."""
    if not GEMINI_API_KEY:
        raise HTTPException(400, "GEMINI_API_KEY not configured")
    since = datetime.now(timezone.utc) - timedelta(hours=2)
    msgs = session.exec(
        select(ChatMessage)
        .where(ChatMessage.channel_id == channel_id,
               ChatMessage.bot_name == None,
               ChatMessage.created_at >= since)
        .order_by(ChatMessage.created_at)
    ).all()
    if not msgs:
        return {"notes": "No messages in the last 2 hours to summarize."}
    transcript = "\n".join(f"{m.sender_name}: {m.content}" for m in msgs if m.content)
    prompt = (
        "You are a professional meeting note taker.\n"
        "Convert this chat transcript into structured meeting notes with:\n"
        "- Key discussion points\n- Decisions made\n- Action items (who does what)\n\n"
        + transcript
    )
    notes = await _gemini_or_http_error(prompt)
    # Post as a bot message in the channel
    cm = ChatMessage(
        channel_id=channel_id, sender_id=0, sender_name="Volt",
        content=f"📋 **Meeting Notes**\n\n{notes}", bot_name="Volt",
    )
    session.add(cm); session.commit(); session.refresh(cm)
    await _chat_broadcast({"type": "channel_message", "message": _msg_dict(cm)})
    return {"notes": notes}
