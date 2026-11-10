"""Wire protocol between the supervisor and an engine worker: one JSON object per line on the worker's
stdin/stdout. Audio never travels through the pipe; the worker writes float32 .npy files into a scratch
directory the supervisor owns and returns the path.

Requests (supervisor -> worker)
  {"op": "load"}                                        load the model, warm up
  {"op": "voice", "voice_id", "ref", "ref_text", "desc"} prepare conditioning for a voice (cached in the worker)
  {"op": "synth", "id", "text", "voice_id", "params", "seed", "out"}
  {"op": "stats"}                                       vram, counters
  {"op": "quit"}

Replies (worker -> supervisor)
  {"id", "ok": true, ...payload}   or   {"id", "ok": false, "error", "kind"}
  kind: "oom" (free memory and retry elsewhere) | "bad_input" (do not retry) | "crash" (restart worker)
"""
from __future__ import annotations

import json
import sys
from typing import Any

READY = "__firevoice_ready__"


def send(obj: dict[str, Any], stream=None) -> None:
    s = stream or sys.stdout
    s.write(json.dumps(obj, ensure_ascii=False) + "\n")
    s.flush()


def recv(stream=None) -> dict[str, Any] | None:
    s = stream or sys.stdin
    line = s.readline()
    if not line:
        return None
    line = line.strip()
    if not line:
        return {}
    return json.loads(line)


def classify_error(e: BaseException) -> str:
    m = str(e).lower()
    if "out of memory" in m or "cuda error" in m or "cublas" in m or "cudnn" in m:
        return "oom"
    if isinstance(e, (ValueError, KeyError, TypeError, AssertionError)):
        return "bad_input"
    return "crash"
