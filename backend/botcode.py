"""Run a bot script written in the website.

The script is ordinary Python. It can use the chat helpers and normal
logic (if, for, while, lists, variables). It cannot import anything, touch
files, or reach the network.
"""
import ast
import sys

SAFE_NODES = {
    ast.Module, ast.FunctionDef, ast.arguments, ast.arg, ast.Expr, ast.If, ast.For,
    ast.While, ast.Break, ast.Continue, ast.Compare, ast.BoolOp, ast.BinOp, ast.UnaryOp,
    ast.Constant, ast.Name, ast.Attribute, ast.Call, ast.Load, ast.Store, ast.Assign,
    ast.AugAssign, ast.Return, ast.Pass, ast.And, ast.Or, ast.Not, ast.Eq, ast.NotEq,
    ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Add, ast.Sub, ast.Mult,
    ast.Div, ast.Mod, ast.USub, ast.JoinedStr, ast.FormattedValue, ast.List, ast.Tuple,
    ast.Dict, ast.Subscript, ast.Slice, ast.keyword,
}
SAFE_ATTRS = {"text", "user", "channel", "lower", "upper", "strip", "startswith", "endswith", "split", "replace", "join"}
SAFE_CALLS = {
    "reply", "say", "say_in", "notify", "members", "channels", "recent",
    "remember", "recall", "forget", "len", "str", "int", "range", "min", "max", "abs",
}


class ScriptError(Exception):
    pass


class Msg:
    def __init__(self, text, user, channel):
        self.text = str(text or "")
        self.user = str(user or "")
        self.channel = str(channel or "")


def _check(tree: ast.AST) -> None:
    for node in ast.walk(tree):
        if type(node) not in SAFE_NODES:
            raise ScriptError(f"That code can't use {type(node).__name__}")
        if isinstance(node, ast.Attribute):
            if node.attr not in SAFE_ATTRS:
                raise ScriptError(f"Can't use .{node.attr}")
        if isinstance(node, ast.Name) and node.id.startswith("_"):
            raise ScriptError("Names starting with _ are not allowed")
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name) and fn.id not in SAFE_CALLS:
                raise ScriptError(f"Can't call {fn.id}")
            if isinstance(fn, ast.Attribute) and fn.attr not in SAFE_ATTRS:
                raise ScriptError(f"Can't call .{fn.attr}")
        if isinstance(node, ast.FunctionDef) and node.name.startswith("_"):
            raise ScriptError("Function names starting with _ are not allowed")


def function_names(source: str) -> list:
    try:
        tree = ast.parse(source or "")
    except SyntaxError as exc:
        raise ScriptError(f"Syntax error on line {exc.lineno}") from exc
    _check(tree)
    return [n.name for n in tree.body if isinstance(n, ast.FunctionDef)]


def _load(source: str, helpers: dict) -> dict:
    tree = ast.parse(source or "")
    _check(tree)
    globs = {"__builtins__": {}}
    globs.update(helpers)
    locs = {}
    exec(compile(tree, "<bot>", "exec"), globs, locs)
    return locs


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


def run_named(source: str, name: str, helpers: dict) -> None:
    locs = _load(source, helpers)
    fn = locs.get(name)
    if callable(fn):
        _limited(fn)
