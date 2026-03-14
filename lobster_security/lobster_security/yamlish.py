"""Minimal YAML subset parser to avoid third-party dependencies.

Supported:
- dictionaries
- nested dictionaries via indentation
- lists of scalars
- strings, ints, booleans, null
"""

from __future__ import annotations

from typing import Any, List, Sequence, Tuple


def _strip_comment(raw: str) -> str:
    if "#" not in raw:
        return raw.rstrip()
    in_single = False
    in_double = False
    for idx, char in enumerate(raw):
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == "#" and not in_single and not in_double:
            if idx == 0 or raw[idx - 1].isspace():
                return raw[:idx].rstrip()
    return raw.rstrip()


def _parse_scalar(value: str) -> Any:
    value = value.strip()
    if value == "":
        return ""
    if value.startswith(("'", '"')) and value.endswith(("'", '"')) and len(value) >= 2:
        return value[1:-1]
    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "none"}:
        return None
    if lowered.isdigit() or (lowered.startswith("-") and lowered[1:].isdigit()):
        try:
            return int(lowered)
        except ValueError:
            return value
    return value


def _normalized_lines(text: str) -> List[Tuple[int, str]]:
    prepared: List[Tuple[int, str]] = []
    for raw_line in text.splitlines():
        clean = _strip_comment(raw_line)
        if not clean.strip():
            continue
        indent = len(clean) - len(clean.lstrip(" "))
        prepared.append((indent, clean.strip()))
    return prepared


def _parse_block(lines: Sequence[Tuple[int, str]], start: int, indent: int) -> Tuple[Any, int]:
    if start >= len(lines):
        return {}, start
    current_indent, content = lines[start]
    if current_indent < indent:
        return {}, start
    if current_indent > indent:
        raise ValueError(f"Unexpected indentation at line {start + 1}")
    if content.startswith("- "):
        return _parse_list(lines, start, indent)
    return _parse_dict(lines, start, indent)


def _parse_list(lines: Sequence[Tuple[int, str]], start: int, indent: int) -> Tuple[List[Any], int]:
    items: List[Any] = []
    idx = start
    while idx < len(lines):
        current_indent, content = lines[idx]
        if current_indent < indent:
            break
        if current_indent != indent or not content.startswith("- "):
            break
        payload = content[2:].strip()
        idx += 1
        if payload == "":
            child, idx = _parse_block(lines, idx, indent + 2)
            items.append(child)
        elif ":" in payload:
            key, raw_value = payload.split(":", 1)
            item = {key.strip(): _parse_scalar(raw_value.strip()) if raw_value.strip() else ""}
            if idx < len(lines) and lines[idx][0] > indent:
                child, idx = _parse_block(lines, idx, indent + 2)
                if isinstance(child, dict):
                    item.update(child)
            items.append(item)
        else:
            items.append(_parse_scalar(payload))
    return items, idx


def _parse_dict(lines: Sequence[Tuple[int, str]], start: int, indent: int) -> Tuple[Any, int]:
    mapping = {}
    idx = start
    while idx < len(lines):
        current_indent, content = lines[idx]
        if current_indent < indent:
            break
        if current_indent != indent or content.startswith("- "):
            break
        if ":" not in content:
            raise ValueError(f"Expected key/value at line {idx + 1}")
        key, raw_value = content.split(":", 1)
        key = key.strip()
        value = raw_value.strip()
        idx += 1
        if value == "":
            child, idx = _parse_block(lines, idx, indent + 2)
            mapping[key] = child
        else:
            mapping[key] = _parse_scalar(value)
    return mapping, idx


def load_yaml_subset(text: str) -> Any:
    lines = _normalized_lines(text)
    if not lines:
        return {}
    parsed, index = _parse_block(lines, 0, lines[0][0])
    if index != len(lines):
        raise ValueError("Trailing content could not be parsed")
    return parsed
