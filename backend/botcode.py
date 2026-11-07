"""Run a bot script written in the website.

The script is ordinary Python plus most of the standard library: math, json,
dates, text, random, and so on. Modules that can read the server, run programs,
or open network connections are refused.
"""
import ast
import asyncio
import concurrent.futures
import inspect
import re
import sys
import threading
import types

# Standard-library modules a bot may import. Nothing here can run a program,
# read server files, or open a connection.
ALLOWED_MODULES = {
    "math", "cmath", "random", "statistics", "decimal", "fractions", "numbers",
    "re", "json", "csv", "datetime", "calendar", "time",
    "collections", "itertools", "functools", "operator", "heapq", "bisect",
    "string", "textwrap", "unicodedata", "html", "difflib",
    "hashlib", "hmac", "base64", "binascii", "uuid",
    "copy", "enum", "pprint", "dataclasses",
    "urllib.parse", "asyncio", "typing", "sqlite3",
}

# Names on asyncio that open a socket or start a program. A bot never gets these.
_ASYNCIO_BLOCKED = {
    "open_connection", "start_server", "open_unix_connection", "start_unix_server",
    "create_subprocess_exec", "create_subprocess_shell",
    "get_event_loop", "new_event_loop", "set_event_loop", "get_event_loop_policy",
    "set_event_loop_policy", "BaseEventLoop", "SelectorEventLoop", "ProactorEventLoop",
    "StreamReader", "StreamWriter", "StreamReaderProtocol",
}

_ASYNCIO_OK = (
    "sleep", "wait", "wait_for", "gather", "shield", "as_completed", "timeout", "timeout_at",
    "Queue", "PriorityQueue", "LifoQueue", "Event", "Lock", "Condition",
    "Semaphore", "BoundedSemaphore", "Barrier",
    "TimeoutError", "CancelledError", "InvalidStateError",
    "IncompleteReadError", "LimitOverrunError",
    "create_task", "current_task", "all_tasks",
    "iscoroutine", "iscoroutinefunction", "isfuture", "run",
)

_sleep_left = threading.local()

SAFE_NODES = {
    ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.Await, ast.AsyncFor, ast.AsyncWith,
    ast.arguments, ast.arg, ast.Expr, ast.If, ast.IfExp, ast.For,
    ast.While, ast.Break, ast.Continue, ast.Compare, ast.BoolOp, ast.BinOp, ast.UnaryOp,
    ast.Constant, ast.Name, ast.Attribute, ast.Call, ast.Load, ast.Store, ast.Assign,
    ast.AugAssign, ast.Return, ast.Pass, ast.And, ast.Or, ast.Not, ast.Eq, ast.NotEq,
    ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Add, ast.Sub, ast.Mult,
    ast.Div, ast.Mod, ast.USub, ast.JoinedStr, ast.FormattedValue, ast.List, ast.Tuple,
    ast.Dict, ast.Subscript, ast.Slice, ast.keyword, ast.Import, ast.ImportFrom, ast.alias,
    ast.AnnAssign,
}


class ScriptError(Exception):
    pass


class Msg:
    def __init__(self, text, user, channel, role="member"):
        self.text = str(text or "")
        self.user = str(user or "")
        self.channel = str(channel or "")
        self.role = str(role or "member")


def _allowed_module(name: str) -> bool:
    return name in ALLOWED_MODULES


def _check(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if type(node) not in SAFE_NODES:
            raise ScriptError(f"That code can't use {type(node).__name__}")
        if isinstance(node, ast.Attribute) and node.attr.startswith("_"):
            raise ScriptError(f"Can't use .{node.attr}")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ScriptError("Names starting with _ are not allowed")
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("_"):
            raise ScriptError("Function names starting with _ are not allowed")
        if isinstance(node, ast.Import):
            for alias in node.names:
                if not _allowed_module(alias.name):
                    raise ScriptError(f"Can't import {alias.name}")
        if isinstance(node, ast.ImportFrom):
            if node.level or not node.module or not _allowed_module(node.module):
                raise ScriptError(f"Can't import {node.module or ''}")
            for alias in node.names:
                if alias.name.startswith("_"):
                    raise ScriptError(f"Can't import {alias.name}")


def function_names(source: str) -> list:
    try:
        tree = ast.parse(source or "")
    except SyntaxError as exc:
        raise ScriptError(f"Syntax error on line {exc.lineno}") from exc
    _check(tree)
    return [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]


async def _refuse_io(self, *_args, **_kwargs):
    raise ScriptError("A bot can't open a connection or run a program")


class _BotLoop(asyncio.SelectorEventLoop):
    """The real asyncio loop, with sockets and programs removed."""


for _io_name in (
    "create_connection", "create_datagram_endpoint", "create_server",
    "create_unix_connection", "create_unix_server", "connect_accepted_socket",
    "start_tls", "sendfile", "subprocess_shell", "subprocess_exec",
    "add_reader", "add_writer", "remove_reader", "remove_writer",
    "sock_recv", "sock_recv_into", "sock_recvfrom", "sock_recvfrom_into",
    "sock_sendall", "sock_sendto", "sock_connect", "sock_accept", "sock_sendfile",
    "getaddrinfo", "getnameinfo",
):
    setattr(_BotLoop, _io_name, _refuse_io)


def _capped_sleep(real_sleep):
    def sleep(delay=0, result=None):
        try:
            delay = float(delay)
        except (TypeError, ValueError):
            delay = 0.0
        if delay < 0:
            delay = 0.0
        left = getattr(_sleep_left, "left", 1.0)
        delay = min(delay, 1.0, left)
        _sleep_left.left = left - delay
        return real_sleep(delay, result)
    return sleep


def _run_on_bot_loop(coro):
    """Run one coroutine where a bot cannot open a socket."""
    def work():
        loop = _BotLoop()
        asyncio.set_event_loop(loop)
        try:
            return loop.run_until_complete(coro)
        finally:
            loop.close()
            asyncio.set_event_loop(None)

    try:
        asyncio.get_running_loop()
        inside = True
    except RuntimeError:
        inside = False
    if not inside:
        return work()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        try:
            return pool.submit(work).result(timeout=3)
        except concurrent.futures.TimeoutError as exc:
            raise ScriptError("Script ran too long") from exc


def _safe_asyncio():
    real = asyncio
    safe = types.ModuleType("asyncio")
    for attr in _ASYNCIO_OK:
        if hasattr(real, attr):
            setattr(safe, attr, getattr(real, attr))
    safe.sleep = _capped_sleep(real.sleep)
    safe.run = _run_on_bot_loop

    def _missing(name):
        if name in _ASYNCIO_BLOCKED or "subprocess" in name or name.startswith("open_") or name.startswith("start_"):
            raise ScriptError(f"Can't use asyncio.{name}")
        raise AttributeError(f"module 'asyncio' has no attribute {name}")

    safe.__getattr__ = _missing
    return safe


_BAD_SQL = re.compile(r"(?is)\b(attach|detach|load_extension|vacuum\s+into)\b")


def _check_sql(sql: str) -> None:
    if _BAD_SQL.search(str(sql or "")):
        raise ScriptError("A bot database can't attach files or load extensions")


class _MemoryCursor:
    def __init__(self, cursor):
        self._cursor = cursor

    def execute(self, sql, params=()):
        _check_sql(sql)
        self._cursor.execute(sql, params)
        return self

    def executemany(self, sql, seq):
        _check_sql(sql)
        self._cursor.executemany(sql, seq)
        return self

    def executescript(self, sql):
        _check_sql(sql)
        self._cursor.executescript(sql)
        return self

    def __iter__(self):
        return iter(self._cursor)

    def __getattr__(self, name):
        if name.startswith("_") or name == "connection":
            raise ScriptError(f"Can't use .{name}")
        return getattr(self._cursor, name)


class _MemoryConnection:
    """sqlite3 connection that can never see a file on the server."""

    def __init__(self, conn):
        self._conn = conn

    def cursor(self):
        return _MemoryCursor(self._conn.cursor())

    def execute(self, sql, params=()):
        _check_sql(sql)
        return _MemoryCursor(self._conn.execute(sql, params))

    def executemany(self, sql, seq):
        _check_sql(sql)
        return _MemoryCursor(self._conn.executemany(sql, seq))

    def executescript(self, sql):
        _check_sql(sql)
        self._conn.executescript(sql)
        return self

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def __getattr__(self, name):
        if name.startswith("_") or name in (
            "backup", "load_extension", "enable_load_extension", "set_authorizer",
            "set_progress_handler", "set_trace_callback", "iterdump",
        ):
            raise ScriptError(f"Can't use sqlite3 connection.{name}")
        return getattr(self._conn, name)


def _memory_connect(database=":memory:", *args, **kwargs):
    if str(database) != ":memory:" or kwargs.get("uri"):
        raise ScriptError("A bot can only open an in-memory database, not a file")
    import sqlite3 as real_sqlite
    return _MemoryConnection(real_sqlite.connect(":memory:"))


def _safe_sqlite():
    import sqlite3 as real_sqlite
    safe = types.ModuleType("sqlite3")
    for name in (
        "Error", "Warning", "DatabaseError", "IntegrityError", "ProgrammingError",
        "OperationalError", "NotSupportedError", "Row", "version", "sqlite_version",
        "PARSE_DECLTYPES", "PARSE_COLNAMES",
    ):
        if hasattr(real_sqlite, name):
            setattr(safe, name, getattr(real_sqlite, name))
    safe.connect = _memory_connect

    def _missing(name):
        raise ScriptError(f"Can't use sqlite3.{name}")

    safe.__getattr__ = _missing
    return safe


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name not in ALLOWED_MODULES:
        raise ScriptError(f"Can't import {name}" if name else "Relative imports are not allowed")
    if name == "asyncio":
        return _safe_asyncio()
    if name == "sqlite3":
        return _safe_sqlite()
    module = __import__(name, globals, locals, fromlist, 0)
    if name == "time":
        safe = types.ModuleType("time")
        for attr in ("time", "monotonic", "strftime", "gmtime", "localtime", "struct_time"):
            setattr(safe, attr, getattr(module, attr))
        return safe
    return module


def _builtins():
    return {
        "__import__": _safe_import,
        "len": len, "str": str, "int": int, "float": float, "bool": bool,
        "list": list, "dict": dict, "tuple": tuple, "set": set,
        "min": min, "max": max, "abs": abs, "sum": sum, "round": round,
        "sorted": sorted, "reversed": reversed, "enumerate": enumerate,
        "zip": zip, "map": map, "filter": filter, "any": any, "all": all,
        "isinstance": isinstance, "chr": chr, "ord": ord, "hex": hex,
        "bin": bin, "oct": oct, "pow": pow, "divmod": divmod, "format": format,
        "True": True, "False": False, "None": None,
    }


def _load(source: str, helpers: dict) -> dict:
    tree = ast.parse(source or "")
    _check(tree)
    env = {"__builtins__": _builtins()}
    env.update(helpers)
    exec(compile(tree, "<bot>", "exec"), env, env)
    return env


def _traced(fn, args):
    steps = {"n": 0}

    def tracer(frame, event, arg):
        if event == "line" and frame.f_code.co_filename == "<bot>":
            steps["n"] += 1
            if steps["n"] > 1000:
                raise ScriptError("Script ran too long")
        return tracer

    old = sys.gettrace()
    sys.settrace(tracer)
    try:
        return fn(*args)
    finally:
        sys.settrace(old)


def _limited(fn, *args):
    _sleep_left.left = 1.0
    if not inspect.iscoroutinefunction(fn):
        return _traced(fn, args)

    def work():
        _sleep_left.left = 1.0
        loop = _BotLoop()
        asyncio.set_event_loop(loop)
        steps = {"n": 0}

        def tracer(frame, event, arg):
            if event == "line" and frame.f_code.co_filename == "<bot>":
                steps["n"] += 1
                if steps["n"] > 1000:
                    raise ScriptError("Script ran too long")
            return tracer

        old = sys.gettrace()
        sys.settrace(tracer)
        try:
            return loop.run_until_complete(fn(*args))
        finally:
            sys.settrace(old)
            loop.close()
            asyncio.set_event_loop(None)

    try:
        asyncio.get_running_loop()
        inside = True
    except RuntimeError:
        inside = False
    if not inside:
        return work()
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        try:
            return pool.submit(work).result(timeout=3)
        except concurrent.futures.TimeoutError as exc:
            raise ScriptError("Script ran too long") from exc


def run_message(source: str, msg: Msg, helpers: dict) -> None:
    if not (source or "").strip() or "on_message" not in function_names(source):
        return
    locs = _load(source, helpers)
    fn = locs.get("on_message")
    if callable(fn):
        _limited(fn, msg)


def scheduled_functions(source: str) -> list:
    """every_60 means run that function every 60 minutes."""
    found = []
    for name in function_names(source or ""):
        if not name.startswith("every_"):
            continue
        minutes = name[6:]
        if minutes.isdigit() and 1 <= int(minutes) <= 10080:
            found.append((name, int(minutes)))
    return found


def run_join(source: str, name: str, helpers: dict) -> None:
    if not (source or "").strip() or "on_join" not in function_names(source):
        return
    locs = _load(source, helpers)
    fn = locs.get("on_join")
    if callable(fn):
        _limited(fn, str(name or ""))


def run_named(source: str, name: str, helpers: dict) -> None:
    locs = _load(source, helpers)
    fn = locs.get(name)
    if callable(fn):
        _limited(fn)


def run_permissions(source: str) -> list:
    """Return the list from permissions(), or [] when the role doesn't define one."""
    if not (source or "").strip() or "permissions" not in function_names(source):
        return []
    locs = _load(source, {})
    fn = locs.get("permissions")
    if not callable(fn):
        return []
    value = _limited(fn)
    if isinstance(value, str) or not isinstance(value, (list, tuple, set)):
        raise ScriptError("permissions() must return a list of names")
    found = []
    for item in list(value)[:30]:
        found.append(str(item).strip().lower()[:40])
    return found
