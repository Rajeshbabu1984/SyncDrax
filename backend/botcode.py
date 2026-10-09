"""Run a bot script written in the website.

The script is ordinary Python plus most of the standard library: math, json,
dates, text, random, and so on. Modules that can read the server, run programs,
or open network connections are refused.
"""
import ast
import sys
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
    "urllib.parse",
}

SAFE_NODES = {
    ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Expr, ast.If, ast.IfExp, ast.For,
    ast.While, ast.Break, ast.Continue, ast.Compare, ast.BoolOp, ast.BinOp, ast.UnaryOp,
    ast.Constant, ast.Name, ast.Attribute, ast.Call, ast.Load, ast.Store, ast.Assign,
    ast.AugAssign, ast.Return, ast.Pass, ast.And, ast.Or, ast.Not, ast.Eq, ast.NotEq,
    ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Add, ast.Sub, ast.Mult,
    ast.Div, ast.Mod, ast.USub, ast.JoinedStr, ast.FormattedValue, ast.List, ast.Tuple,
    ast.Dict, ast.Subscript, ast.Slice, ast.keyword, ast.Import, ast.ImportFrom, ast.alias,
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
        if isinstance(node, ast.FunctionDef) and node.name.startswith("_"):
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
    return [n.name for n in tree.body if isinstance(n, ast.FunctionDef)]


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level or name not in ALLOWED_MODULES:
        raise ScriptError(f"Can't import {name}" if name else "Relative imports are not allowed")
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


def _limited(fn, *args):
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
