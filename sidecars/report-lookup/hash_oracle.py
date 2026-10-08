"""Independent restricted JSON/hash oracle for OFFLINE conformance tests only. No report I/O."""
import hashlib
import json
import sys


def pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError("duplicate")
        result[key] = value
    return result


def integer(text):
    value = int(text)
    if abs(value) > 9007199254740991:
        raise ValueError("integer")
    return value


def forbidden(_):
    raise ValueError("number")


def canonical(value, depth=0):
    if depth > 64:
        raise ValueError("depth")
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        if abs(value) > 9007199254740991:
            raise ValueError("integer")
        return str(value)
    if isinstance(value, str):
        value.encode("utf-8", "strict")
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(canonical(v, depth + 1) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value, key=lambda k: k.encode("utf-16-be", "strict"))
        return "{" + ",".join(canonical(k, depth + 1) + ":" + canonical(value[k], depth + 1) for k in keys) + "}"
    raise ValueError("domain")


def answer(raw):
    try:
        if len(raw.encode("utf-8", "strict")) > 1048576:
            raise ValueError("size")
        value = json.loads(raw, object_pairs_hook=pairs, parse_int=integer, parse_float=forbidden, parse_constant=forbidden)
        text = canonical(value)
        return {"accepted": True, "canonical": text, "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}
    except (ValueError, UnicodeError, RecursionError):
        return {"accepted": False}


if __name__ == "__main__":
    request = json.loads(sys.stdin.read())
    print(json.dumps([answer(raw) for raw in request], ensure_ascii=True, separators=(",", ":")))
