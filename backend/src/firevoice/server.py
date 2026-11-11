"""FireVoice HTTP API (FastAPI). Everything goes through the FireVoice service, so every client of the API (the
desktop app, other programs, AI agents) gets the same behaviour. main() at the end of this module starts it. Interactive docs: http://127.0.0.1:8787/docs

App API (/api/v1)
  GET    /health                          liveness (no auth)
  GET    /api/v1/system                   version, GPU/VRAM, loaded engines, job counts
  GET    /api/v1/options                  everything a UI needs in one call: engines + params, styles, formats, defaults
  GET    /api/v1/engines                  catalog + install status + loaded state
  GET    /api/v1/engines/{name}
  POST   /api/v1/engines/{name}/load      {"workers": 2}
  POST   /api/v1/engines/{name}/unload
  GET    /api/v1/voices                   ?language=&gender=&tag=&kind=cloned|designed&q=
  POST   /api/v1/voices                   multipart: file, name, consent=true, description, gender, language, accent, tags, transcript
  POST   /api/v1/voices/design            {"name", "description", "engine", "text", "gender", "language"}  (?wait=false -> job)
  GET    /api/v1/voices/{id}
  PATCH  /api/v1/voices/{id}              {"name", "description", "gender", "language", "accent", "tags", "favorite", "notes"}
  PUT    /api/v1/voices/{id}/transcript   {"transcript"}
  DELETE /api/v1/voices/{id}
  POST   /api/v1/voices/{id}/default
  GET    /api/v1/voices/{id}/audio        the reference clip (?style= for a per-style clip)
  POST   /api/v1/voices/{id}/styles/{style}   multipart: file, transcript
  GET    /api/v1/styles                   built-in + user styles
  GET    /api/v1/styles/{name}
  PUT    /api/v1/styles/{name}            create or replace a user style
  DELETE /api/v1/styles/{name}            user styles only
  POST   /api/v1/tts                      TTS request -> audio bytes (or JSON with base64 + words: "response": "json")
  POST   /api/v1/tts/stream               TTS request -> Server-Sent Events, one event per sentence chunk as it is ready
  POST   /api/v1/tts/stream.pcm           TTS request -> raw 16-bit PCM bytes as they are ready (X-Sample-Rate header)
  POST   /api/v1/stt                      multipart: file, language, beam_size -> text + word times
  WS     /api/v1/dictate                  live dictation: microphone PCM in, text out as it becomes certain
  POST   /api/v1/dictate/warm             load the speech model so the first dictation starts at once
  POST   /api/v1/jobs                     {"kind": "tts"|"batch"|"design", "payload": {...}, "title": ""}
  GET    /api/v1/jobs                     ?status=&kind=&limit=
  GET    /api/v1/jobs/events              SSE of every job event (?since=<seq> to resume)
  GET    /api/v1/jobs/{id}
  GET    /api/v1/jobs/{id}/events         SSE for one job, ends when it finishes
  POST   /api/v1/jobs/{id}/cancel
  DELETE /api/v1/jobs/{id}
  GET    /api/v1/jobs/{id}/audio          main audio file;  GET /api/v1/jobs/{id}/files/{name} any output

ElevenLabs-compatible (existing clients):  POST /v1/text-to-speech/{voice_id}[/with-timestamps], GET /v1/voices,
POST /v1/voices/add, GET /v1/models

Auth: when a token is set (--token or FIREVOICE_API_KEY) send `Authorization: Bearer <token>`, `x-api-key` or
`xi-api-key`; `?token=` also works so <audio src> and EventSource can authenticate. /health is always open.
Errors are JSON: {"error": {"code": "bad_request|not_found|conflict|unavailable|internal", "message": "..."}}.
"""

import base64
import json
import os
import re
import tempfile
import threading
from pathlib import Path
from typing import Any, Literal, Optional, Union

from . import audio as A
from .service import FireVoice, FireVoiceError, TTSRequest
from .types import Cancelled

TAGS = [
    {"name": "system", "description": "Health, GPU and everything a UI needs in one call (`/api/v1/options`)."},
    {"name": "engines", "description": "Engine catalog, capabilities, parameter schemas, install status, load and unload."},
    {"name": "history", "description": "Everything made, kept until you delete it: speech renders, sound and music, voice changer, dialogue, transcripts, separated and cleaned audio."},
    {"name": "sound", "description": "Sound effects, ambience and music from a description (Crackle, Bonfire)."},
    {"name": "dubbing", "description": "Dub a recording or video into another language, keeping timing and speakers."},
    {"name": "voices", "description": "Voice library: upload (with consent), design from a description, edit, per-style clips, previews."},
    {"name": "styles", "description": "Delivery styles: built in plus your own."},
    {"name": "tts", "description": "Text to speech: whole file, streamed chunks (SSE) or raw PCM. One request shape for every engine."},
    {"name": "stt", "description": "Speech to text with word times and language detection."},
    {"name": "jobs", "description": "Background renders, batches and voice design with progress events and history."},
    {"name": "takes", "description": "Kept renders (keep_takes): every take of every passage with its speech check. Compare, swap, re-take, lock, export."},
    {"name": "dictionary", "description": "Pronunciation dictionary: your rules for how words are said, plus the built-in list."},
    {"name": "dialogue", "description": "Multi-speaker scripts: 'Name: line' turns, a cast of voices, one mix plus stems and speaker-labelled subtitles."},
    {"name": "audio tools", "description": "Check and clean recordings, and the voice changer (speech to speech in any library voice)."},
    {"name": "projects", "description": "Long-form projects: chapters of paragraphs, each rendered with every take kept; render what changed, export WAV/MP3/M4B with chapters, audiobook check, bundles."},
    {"name": "elevenlabs", "description": "ElevenLabs-compatible routes for existing clients."},
    {"name": "openai", "description": "OpenAI-compatible routes: point an OpenAI client's base URL at this server."},
    {"name": "legacy", "description": "Older studio contract."},
]

TTS_EXAMPLES = {
    "simple": {"summary": "A library voice and a style", "value": {
        "text": "Hello! This is FireVoice, running on your own GPU.", "voice": "lib-f-4992", "style": "storyteller", "format": "mp3"}},
    "designed voice": {"summary": "Invent a voice from a description", "value": {
        "text": "Welcome back, traveller. The fire is warm tonight.", "voice": "design:a deep, gravelly old storyteller with a slight British accent",
        "style": "storyteller", "instruct": "slow, warm and mysterious", "format": "mp3"}},
    "engine settings": {"summary": "Engine parameters, style overrides, 2 takes per sentence, wav at 44.1 kHz", "value": {
        "text": "Every password you have ever typed went somewhere. Some were stored safely. Others were not.", "engine": "voxcpm2",
        "voice": "glb-m-sco-s01863", "style": "documentary", "params": {"cfg_value": 2.5, "inference_timesteps": 14},
        "style_overrides": {"pause": 1.2}, "candidates": 2, "format": "wav", "sample_rate": 44100}},
    "urdu": {"summary": "Urdu in Roman script with a native Urdu voice", "value": {
        "text": "The weather is lovely today. Let's go for a walk by the river.", "voice": "Evelyn", "language": "en", "format": "mp3"}},
    "json with word times": {"summary": "JSON response: base64 audio plus word timestamps", "value": {
        "text": "Word timestamps come back with the audio.", "voice": "hifi-f-92", "response": "json"}},
    "another engine": {"summary": "The same request on Chatterbox Turbo", "value": {
        "text": "Same API, different engine. [laugh] Nice.", "engine": "chatterbox-turbo", "voice": "lib-m-1188", "style": "excited",
        "params": {"temperature": 0.7}, "format": "mp3"}},
}

JOB_EXAMPLES = {
    "long render": {"summary": "Render a long script in the background", "value": {"kind": "tts", "title": "chapter one", "payload": {
        "request": {"text": "This is a background job. It reports progress and lands in the history. " * 4, "voice": "lib-m-1188",
                    "style": "audiobook"}, "format": "mp3"}}},
    "batch": {"summary": "Several lines; each line may override any request field", "value": {"kind": "batch", "payload": {
        "lines": [{"id": "intro", "text": "Welcome to the show."}, {"id": "scare", "text": "Do not turn around.", "style": "horror"}],
        "defaults": {"voice": "hifi-f-92"}, "format": "wav"}}},
    "design": {"summary": "Design a voice in the background", "value": {"kind": "design", "payload": {
        "name": "my-narrator", "description": "a calm, warm middle-aged male narrator"}}},
}

DESIGN_EXAMPLES = {"radio host": {"summary": "Design and lock a new voice", "value": {
    "name": "my-radio-host", "description": "a cheerful young woman radio host, bright and quick", "engine": "voxcpm2"}}}

STATUS = {"bad_request": 400, "unauthorized": 401, "not_found": 404, "conflict": 409, "too_large": 413, "unavailable": 503, "internal": 500}
MAX_UPLOAD = 1024 * 1024 * 1024        # uploads stream to disk, so long recordings are fine


def _expose(**types) -> None:
    """Make types that are created inside create_app findable in this module by name.

    Route signatures name such types (the request models, FastAPI's own classes). In source form an annotation is the
    type itself. A release build compiles this module, and a compiled function keeps its annotations as text, which
    FastAPI resolves by looking the name up in the function's module: so every such type is put here."""
    globals().update(types)


def _check_signatures(app) -> None:
    """Fail at startup, naming the route, if a route or dependency has an annotation that cannot be resolved (see
    _expose). Left unresolved, FastAPI would quietly read a body or the request as a query parameter."""
    import inspect

    def calls(dep):
        if dep.call is not None:
            yield dep.call
        for d in dep.dependencies:
            yield from calls(d)

    for route in app.routes:
        dep = getattr(route, "dependant", None)
        for fn in calls(dep) if dep is not None else ():
            try:
                params = inspect.signature(fn).parameters.values()
            except (TypeError, ValueError):
                continue
            for p in params:
                if isinstance(p.annotation, str):
                    try:
                        eval(p.annotation, getattr(fn, "__globals__", globals()))
                    except Exception as e:  # noqa: BLE001
                        raise RuntimeError(f"route {getattr(route, 'path', '?')}: parameter {p.name!r} of {getattr(fn, '__name__', fn)} "
                                           f"is annotated {p.annotation!r}, which does not resolve ({e}); pass the type to _expose()") from None


def create_app(svc: FireVoice, token: Optional[str] = None, cors_origins: Optional[list[str]] = None):
    from fastapi import Body, Depends, FastAPI, File, Form, Query, Request, Security, UploadFile
    from fastapi.concurrency import run_in_threadpool
    from fastapi.exceptions import RequestValidationError
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
    from fastapi.security import APIKeyHeader, HTTPBearer
    from pydantic import BaseModel as _PydanticModel, ConfigDict, Field

    class BaseModel(_PydanticModel):
        # A method on a model is not a field. Pydantic knows that for plain functions; a release build compiles this
        # module, where functions are another type of object, so that type is named here too.
        model_config = ConfigDict(ignored_types=(type(create_app),))

        @classmethod
        def __pydantic_init_subclass__(cls, **kwargs):
            _expose(**{cls.__name__: cls})

    from fastapi import WebSocket, WebSocketDisconnect
    _expose(Request=Request, UploadFile=UploadFile, Response=Response, WebSocket=WebSocket)

    from . import __version__

    token = token or os.environ.get("FIREVOICE_API_KEY") or None
    app = FastAPI(
        title="FireVoice", version=__version__, openapi_tags=TAGS,
        description=("Local expressive text-to-speech and speech-to-text engine: many open models, one API. "
                     "Use **Try it out** on any route and pick a ready-made example from the Examples dropdown; TTS routes return audio you "
                     "can download from the response panel."),
        swagger_ui_parameters={"tryItOutEnabled": True, "persistAuthorization": True, "displayRequestDuration": True, "filter": True,
                               "docExpansion": "list", "defaultModelsExpandDepth": 0, "syntaxHighlight.theme": "obsidian"})
    app.state.svc = svc
    app.add_middleware(CORSMiddleware, allow_origins=cors_origins or [], allow_credentials=False, allow_methods=["*"], allow_headers=["*"],
                       allow_origin_regex=None if cors_origins else r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|tauri://localhost|https?://tauri\.localhost|app://.*)$",
                       expose_headers=["X-Duration", "X-Sample-Rate", "X-Engine", "X-RTF", "X-Warnings", "X-Warning-Count", "X-Watermarked", "X-Seed", "X-License", "X-Render-Id", "X-Quality-Before", "X-Quality-After", "X-History-Id", "Content-Disposition"])

    # ------------------------------------------------------------------ errors + auth
    def err(code: str, message: str, status: Optional[int] = None):
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=status or STATUS.get(code, 500))

    @app.exception_handler(FireVoiceError)
    async def _fv(_req, e: FireVoiceError):
        return err(e.code, e.message)

    @app.exception_handler(Cancelled)
    async def _cancelled(_req, e: Cancelled):
        return err("cancelled", "the render was cancelled", 499)

    @app.exception_handler(Exception)
    async def _any(_req, e: Exception):
        # every failure keeps the documented {"error": {code, message}} shape, never a plain-text 500
        import logging
        logging.getLogger("firevoice").exception("unhandled error")
        from .service import friendly_error
        return err("internal", friendly_error(e), 500)

    @app.exception_handler(RequestValidationError)
    async def _val(_req, e: RequestValidationError):
        msg = "; ".join(f"{'.'.join(str(x) for x in d.get('loc', [])[1:]) or 'body'}: {d.get('msg')}" for d in e.errors())
        return err("bad_request", msg or "invalid request", 400)

    bearer = HTTPBearer(auto_error=False, description="the server token (--token / FIREVOICE_API_KEY); not needed when auth is off")
    api_key = APIKeyHeader(name="x-api-key", auto_error=False)

    def auth(request: Request, _b=Security(bearer), _k=Security(api_key)):   # the Security params give Swagger its Authorize button
        if not token:
            return
        h = request.headers
        given = (h.get("authorization", "").removeprefix("Bearer ").strip() or h.get("x-api-key") or h.get("xi-api-key")
                 or request.query_params.get("token"))
        if not _same(given, token):
            raise FireVoiceError("unauthorized", "missing or wrong API token")

    deps = [Depends(auth)]

    # ------------------------------------------------------------------ models
    class TTSBody(BaseModel):
        model_config = ConfigDict(extra="forbid")
        text: str = Field(..., description="what to say; supports [pause 500ms] and per-engine tags like [laugh]")
        engine: Optional[str] = Field(None, description="engine name (GET /api/v1/engines); default: the server default")
        voice: str = Field("default", description="voice id, 'default', or 'design:<description>'")
        style: str = Field("conversational", description="delivery style (GET /api/v1/styles)")
        pace: float = Field(1.0, ge=0.25, le=4.0)
        seed: int = 1234
        language: Optional[str] = Field(None, description="ISO code; null = detect from the text")
        instruct: Optional[str] = Field(None, description="delivery instruction; null = the style's own, '' = none")
        params: dict[str, Any] = Field(default_factory=dict, description="engine-specific parameters (see the engine's params)")
        style_overrides: dict[str, Any] = Field(default_factory=dict, description="override any style field: temperature, cfg, pause...")
        lufs: Optional[float] = Field(-16.0, description="loudness target; null = raw output")
        candidates: int = Field(1, ge=1, le=8)
        accept: float = Field(0.9, ge=0.0, le=1.0)
        validate_takes: bool = Field(True, alias="validate", description="ASR-check English takes and retry bad ones")
        lead_ms: int = Field(120, ge=0, le=5000)
        tail_ms: int = Field(280, ge=0, le=5000)
        format: Literal["wav", "mp3", "flac", "ogg", "opus", "m4a", "pcm16"] = "mp3"
        sample_rate: Optional[int] = Field(None, ge=8000, le=96000, description="resample the output; null = engine native")
        response: Literal["audio", "json"] = "audio"
        dictionary: Optional[Union[list[dict[str, Any]], dict[str, str]]] = Field(
            None, description='extra pronunciation rules for this request: [{"match": "SQL", "say": "sequel"}] or {"SQL": "sequel"}')
        keep_takes: bool = Field(False, description="keep every take of every passage; the response names the kept render "
                                                     "(X-Render-Id, render_id) for /api/v1/renders")
        watermark: Optional[bool] = Field(None, description="inaudible 'made by FireVoice' mark (AudioSeal); null = the server's policy, on by default")

        def request(self) -> TTSRequest:
            d = self.model_dump(by_alias=True, exclude={"format", "sample_rate", "response"})
            return TTSRequest.from_dict(d)

    class EngineLoad(BaseModel):
        workers: Optional[int] = Field(None, ge=1, le=8)

    class VoicePatch(BaseModel):
        model_config = ConfigDict(extra="forbid")
        name: Optional[str] = None
        tagline: Optional[str] = None
        traits: Optional[list[str]] = None
        use_cases: Optional[list[str]] = None
        description: Optional[str] = None
        gender: Optional[str] = None
        language: Optional[str] = None
        accent: Optional[str] = None
        tags: Optional[list[str]] = None
        favorite: Optional[bool] = None
        notes: Optional[str] = None

    class DesignBody(BaseModel):
        model_config = ConfigDict(extra="forbid")
        name: str
        description: str
        engine: Optional[str] = None
        text: Optional[str] = None
        gender: str = ""
        language: str = ""
        seed: int = 1234

    class JobBody(BaseModel):
        model_config = ConfigDict(extra="forbid")
        kind: Literal["tts", "batch", "design", "previews", "project", "style_refs", "dialogue"]
        payload: dict[str, Any]
        title: str = ""

    class RuleBody(BaseModel):
        model_config = ConfigDict(extra="forbid")
        match: str = Field(..., min_length=1, max_length=200, description="the written word or phrase")
        say: str = Field(..., max_length=400, description="how to say it (letters only, as you would type it)")
        case: bool = Field(False, description="match this exact casing only")
        whole_word: bool = Field(True, description="only whole words (\"cat\" leaves \"concatenate\" alone)")
        note: str = ""

    class RulePatch(BaseModel):
        model_config = ConfigDict(extra="forbid")
        match: Optional[str] = None
        say: Optional[str] = None
        case: Optional[bool] = None
        whole_word: Optional[bool] = None
        note: Optional[str] = None

    class RulesBody(BaseModel):
        rules: list[dict[str, Any]]

    class DictTest(BaseModel):
        text: str = Field(..., min_length=1, max_length=5000)
        engine: Optional[str] = None
        language: Optional[str] = None
        dictionary: Optional[Union[list[dict[str, Any]], dict[str, str]]] = None

    class RetakeBody(BaseModel):
        seed: Optional[int] = Field(None, description="null = a fresh random seed")
        choose: bool = Field(True, description="make the new take the one used in the stitched audio")

    class EditBody(BaseModel):
        text: str = Field(..., description="the passage's new text (as shown in the render's chunks)")
        mode: Literal["splice", "passage"] = Field("splice", description="splice: only the edited words are new; passage: the whole re-recorded passage")
        seed: Optional[int] = None

    class ChooseBody(BaseModel):
        take: int = Field(..., ge=1, description="take number (n) to use for this passage")

    class LockBody(BaseModel):
        locked: bool = True

    class RegenBody(BaseModel):
        chunks: Optional[list[int]] = Field(None, description="passage indexes; null = every unlocked passage")

    class DialogueParse(BaseModel):
        script: str = Field(..., min_length=1, max_length=500_000)
        cast: Optional[dict[str, Any]] = Field(None, description='{"Evelyn": {"voice": "Evelyn", "style": "podcast"}, "Arthur": "Arthur"}')

    class DialogueBody(DialogueParse):
        defaults: Optional[dict[str, Any]] = Field(None, description="TTS request fields for every turn (engine, style, pace...)")
        gap_ms: int = Field(350, ge=0, le=5000, description="silence between speakers")
        seed: int = 1234
        lufs: Optional[float] = -16.0
        format: Literal["wav", "mp3", "flac", "ogg", "opus", "m4a"] = "mp3"
        response: Literal["audio", "json", "zip"] = Field("audio", description="audio = the mix; json = mix, turns, words (stems with stems=true); zip = mix, stems, subtitles, turns")
        stems: bool = False
        save: bool = Field(True, description="keep the result in History (default); false skips it")

    class StyleBuild(BaseModel):
        engine: Optional[str] = None
        text: Optional[str] = Field(None, max_length=2000, description="what the clip says (default: the style's sample)")
        seed: int = 1234

    class CleanBody(BaseModel):
        strength: Literal["light", "medium", "strong", "neural"] = "medium"

    class DesignCands(BaseModel):
        description: str = Field(..., min_length=3, max_length=1000)
        n: int = Field(3, ge=1, le=6)
        engine: Optional[str] = None
        text: Optional[str] = Field(None, max_length=1000)
        seed: Optional[int] = None
        language: Optional[str] = None

    class DesignKeep(BaseModel):
        name: str = Field(..., min_length=1, max_length=60)
        gender: str = ""
        language: str = ""
        description: Optional[str] = None

    class ProjectNew(BaseModel):
        model_config = ConfigDict(extra="forbid")
        title: str = Field("Untitled project", max_length=200)
        text: str = Field("", max_length=5_000_000, description="optional script: '# Heading' or 'Chapter 1' lines start chapters, blank lines split paragraphs")
        defaults: Optional[dict[str, Any]] = Field(None, description="any TTS request field (voice, style, engine, pace, lufs, dictionary...) plus paragraph_gap_ms, chapter_gap_ms, chapter_lead_ms")

    class ProjectPatch(BaseModel):
        model_config = ConfigDict(extra="forbid")
        title: Optional[str] = Field(None, max_length=200)
        defaults: Optional[dict[str, Any]] = None
        chapters: Optional[list[dict[str, Any]]] = Field(None, description="the whole structure: [{id?, title, paragraphs: [{id?, text, voice?, style?, pace?, locked?}]}]; "
                                                                          "paragraphs that keep their id keep their render")

    class ProjectRender(BaseModel):
        scope: Literal["stale", "all"] = Field("stale", description="stale = drafts and changed paragraphs; all = everything not locked")
        chapter: Optional[str] = None

    class SubBody(BaseModel):
        words: list[dict[str, Any]] = Field(..., description='[{"text", "start", "end"}] in seconds, as /tts returns them')
        format: Literal["srt", "vtt"] = "srt"

    def info_headers(r) -> dict:
        i = r.info()
        return {"X-Duration": str(i["duration"]), "X-Sample-Rate": str(r.sr), "X-Engine": i["engine"], "X-RTF": str(i["rtf"]),
                # the warnings themselves (";"-separated, ASCII-safe for a header), and how many there were
                "X-Warnings": "; ".join(w.replace(";", ",") for w in i["warnings"]).encode("ascii", "replace").decode()[:900],
                "X-Warning-Count": str(len(i["warnings"])), "X-Watermarked": "1" if i.get("watermarked") else "0",
                **({"X-Render-Id": i["render_id"]} if i.get("render_id") else {})}

    async def save_upload(f: UploadFile) -> str:
        """Stream an upload to a temp file in 1 MB pieces, stopping at the size limit (never all in memory)."""
        suffix = Path(f.filename or "audio.wav").suffix or ".wav"
        size = 0
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as t:
            try:
                while True:
                    chunk = await f.read(1 << 20)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        raise FireVoiceError("too_large", f"This file is larger than the {MAX_UPLOAD // 1024 // 1024} MB limit.")
                    t.write(chunk)
            except BaseException:
                t.close()
                Path(t.name).unlink(missing_ok=True)
                raise
        if not size:
            Path(t.name).unlink(missing_ok=True)
            raise FireVoiceError("bad_request", "The uploaded file is empty.")
        return t.name

    def to_wav(path: str) -> str:
        """Decode anything ffmpeg reads (mp3, m4a, ogg, webm from a browser recorder...) to wav."""
        import subprocess
        if path.lower().endswith((".wav", ".flac")):
            return path
        out = path + ".wav"
        try:
            p = subprocess.run([A._ffmpeg(), "-y", "-v", "error", "-i", path, "-ac", "1", out], capture_output=True, timeout=600)
        except subprocess.TimeoutExpired:
            Path(out).unlink(missing_ok=True)
            raise FireVoiceError("bad_request", "Reading this file took too long. Try a shorter recording or another format.")
        if p.returncode != 0:
            Path(out).unlink(missing_ok=True)
            raise FireVoiceError("bad_request", "This file couldn't be read as audio or video. Try MP3, WAV, M4A or MP4.")
        return out

    def sse(gen):
        def body():
            yield "retry: 3000\n\n"
            for ev in gen:
                eid = f"id: {ev['seq']}\n" if ev.get("seq") is not None and ev.get("type") != "ping" else ""
                yield f"{eid}event: {ev.get('type', 'message')}\ndata: {json.dumps(ev, default=str, ensure_ascii=False)}\n\n"
        return StreamingResponse(body(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ------------------------------------------------------------------ pages
    @app.get("/", include_in_schema=False)
    def root():
        return RedirectResponse("/docs")

    samples_dir = Path(__file__).parent / "samples"

    @app.get("/api/v1/samples", tags=["system"])
    def samples():
        """Sample recordings that ship with the server, for trying the audio tools without recording anything:
        `speech.mp3` (one speaker), `conversation.mp3` (three speakers), `speech-with-music.mp3` (a voice over music)."""
        return {"samples": [{"name": f.name, "bytes": f.stat().st_size, "url": f"/api/v1/samples/{f.name}"}
                            for f in sorted(samples_dir.glob("*.mp3"))]}

    @app.get("/api/v1/samples/{name}", tags=["system"])
    def sample(name: str):
        """One sample recording (MP3)."""
        f = samples_dir / name
        if "/" in name or "\\" in name or not f.is_file() or f.suffix != ".mp3":
            raise FireVoiceError("not_found", f"no sample {name!r}")
        return FileResponse(f, media_type="audio/mpeg", headers={"Cache-Control": "public, max-age=3600"})

    # ------------------------------------------------------------------ system
    @app.get("/health", tags=["system"])
    def health():
        from . import API_VERSION, MIN_CLIENT_API
        return {"ok": True, "version": __version__, "api_version": API_VERSION, "min_client_api": MIN_CLIENT_API, "auth": bool(token)}

    @app.get("/api/v1/engines/{name}/install", dependencies=deps, tags=["engines"])
    def engine_install_plan(name: str, sizes: bool = True):
        """What installing this engine does (venv, CUDA torch, pinned packages, weights) with what is already done
        and an estimated download. `auto: false` engines carry the manual steps instead."""
        return svc.engine_install_plan(name, sizes=sizes)

    @app.post("/api/v1/engines/{name}/install", dependencies=deps, tags=["engines"], status_code=202)
    def engine_install(name: str, force: bool = False):
        """Install as a background job (kind `install`): follow it on the jobs event stream; the log is the job's
        install.log file. `force` rebuilds the venv and downloads the weights again."""
        return svc.jobs.submit("install", {"engine": name, "force": force})

    @app.delete("/api/v1/engines/{name}/install", dependencies=deps, tags=["engines"])
    def engine_uninstall(name: str, weights: bool = False):
        """Remove the engine's venv (shared venvs go for every engine using them, listed in `also_affects`); add
        `weights=true` to delete its downloaded weights as well."""
        return svc.engine_uninstall(name, weights=weights)

    @app.get("/api/v1/system/setup", dependencies=deps, tags=["system"])
    def system_setup():
        """First-run facts: the GPU, a recommended engine for it (with alternatives), which engines are ready, and
        anything missing (ffmpeg, no engine installed)."""
        return svc.setup_report()

    @app.get("/api/v1/system/paths", dependencies=deps, tags=["system"])
    def system_paths():
        """Where the data folder, engine venvs, model weights and ffmpeg were found, and why (env var, settings.json,
        source checkout or default)."""
        from . import paths
        return {**paths.report(), "watermark": svc.watermark_status()}

    class SettingsBody(BaseModel):
        engines_dir: Optional[str] = None
        weights_dir: Optional[str] = None
        ffmpeg: Optional[str] = None
        watermark: Optional[Literal["all", "off", ""]] = Field(None, description="all (default): mark every output; off")

    @app.put("/api/v1/system/settings", dependencies=deps, tags=["system"])
    def system_settings(body: SettingsBody):
        """Store path settings in FIREVOICE_HOME/settings.json. Send only the keys to change; an empty string removes a
        key (back to the default). Environment variables still win over these. Changing engines_dir or weights_dir
        takes effect after a restart; ffmpeg applies at once."""
        from . import paths
        changes = body.model_dump(exclude_unset=True)
        for k, v in changes.items():
            if not v:
                continue
            if k == "watermark":
                continue
            p = Path(v)
            if k == "ffmpeg" and not p.is_file():
                raise FireVoiceError("bad_request", f"ffmpeg not found at {v}")
            if k != "ffmpeg" and not p.is_dir():
                raise FireVoiceError("bad_request", f"{k}: folder not found: {v}")
        stored = paths.save_settings(changes)
        return {"settings": stored, "restart_required": any(k in changes for k in ("engines_dir", "weights_dir")), "paths": paths.report()}

    @app.get("/api/v1/system", dependencies=deps, tags=["system"])
    def system():
        return svc.system()

    @app.get("/api/v1/options", dependencies=deps, tags=["system"])
    def options():
        defaults = TTSRequest(text="").to_dict()
        defaults.pop("text")
        voices = svc.voices.list()
        from .service import _engine_names
        return {"engines": svc.engines(), "styles": svc.style_list(), "formats": list(A.FORMATS), "defaults": {**defaults, "format": "mp3"},
                "default_engine": svc._resolve_engine(None), "engine_names": _engine_names(), "voice_count": len(voices),
                "languages": sorted({v.get("language") or "en" for v in voices})}

    # ------------------------------------------------------------------ engines
    @app.get("/api/v1/engines", dependencies=deps, tags=["engines"])
    def engines(task: Literal["tts", "sfx", "vc", "all"] = "tts"):
        """Engines for one task: tts (default), sfx (sound effects and music), vc (voice changer) or all."""
        return {"engines": svc.engines(task)}

    class SoundBody(BaseModel):
        prompt: str = Field(..., description="describe the sound: 'rain on a tin roof, distant thunder' or 'calm lo-fi piano bed'")
        kind: Literal["sfx", "music"] = "sfx"
        duration: float = Field(5.0, ge=1.0, le=180.0, description="seconds: effects up to 30, music up to 180")
        seed: Optional[int] = None
        engine: Optional[str] = None
        params: dict = Field(default_factory=dict)
        format: str = "mp3"
        save: bool = Field(True, description="keep the result in History (default); false skips it")

    @app.post("/api/v1/sound", dependencies=deps, tags=["sound"])
    async def sound(request: Request, body: SoundBody):
        """A sound effect or ambience (kind sfx, AudioLDM 2) or a music bed (kind music, MusicGen) from a description.
        Headers: X-Seed (to make it again), X-Engine, X-Duration, X-License. Both engines' weights are non-commercial."""
        import asyncio
        cancel = threading.Event()
        task = asyncio.ensure_future(run_in_threadpool(lambda: svc.sound(body.prompt, body.kind, body.duration, body.seed, engine=body.engine,
                                                                          params=body.params, cancel=cancel)))
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=0.5)
            if not done and await request.is_disconnected():
                cancel.set()
        a, sr, info = task.result()
        fmt = body.format if body.format in A.FORMATS else "mp3"
        data = await run_in_threadpool(svc.encode, a, fmt, None, sr)
        h = {"X-Seed": str(info["seed"]), "X-Engine": info["engine"], "X-Duration": str(info["duration"]), "X-License": str(info["license"])}
        if body.save:
            item = await run_in_threadpool(lambda: svc.history.add(
                "music" if body.kind == "music" else "sound", body.prompt, audio={"audio": a}, sr=sr,
                meta={"prompt": body.prompt, "kind": body.kind, "seed": info["seed"], "engine": info["engine"], "duration": info["duration"]}))
            h["X-History-Id"] = item["id"]
        return Response(data, media_type=A.media_type(fmt), headers={**h, "Access-Control-Expose-Headers": ", ".join(h)})

    @app.get("/api/v1/engines/{name}", dependencies=deps, tags=["engines"])
    def engine(name: str):
        return svc.engine(name)

    @app.post("/api/v1/engines/{name}/load", dependencies=deps, tags=["engines"])
    async def engine_load(name: str, body: EngineLoad = Body(default=EngineLoad())):
        return await run_in_threadpool(svc.load, name, body.workers)

    @app.post("/api/v1/engines/{name}/unload", dependencies=deps, tags=["engines"])
    async def engine_unload(name: str):
        return await run_in_threadpool(svc.unload, name)

    # ------------------------------------------------------------------ voices
    @app.get("/api/v1/voices", dependencies=deps, tags=["voices"])
    def voices(language: Optional[str] = None, gender: Optional[str] = None, tag: Optional[str] = None, kind: Optional[str] = None, q: Optional[str] = None):
        return {"voices": svc.voice_list(language=language, gender=gender, tag=tag, q=q, kind=kind)}

    @app.get("/api/v1/voices/library", dependencies=deps, tags=["voices"])
    def voice_library():
        """The ready-made voice library: how much of it this computer has (`present` of `count`, `installed` when
        nothing is missing) and whether this version can download it (`available`)."""
        from . import voicepack
        return voicepack.status(svc.voices.root)

    @app.post("/api/v1/voices/library", dependencies=deps, tags=["voices"], status_code=202)
    def voice_library_install():
        """Download the voice library and add its voices, as a background job (kind `voices`). Safe to repeat: voices you
        have edited, renamed or deleted are left alone, and the default voice is set only when there is none."""
        return svc.jobs.submit("voices", {})

    @app.post("/api/v1/voices", dependencies=deps, tags=["voices"], status_code=201)
    async def voice_add(file: UploadFile = File(...), name: str = Form(...), consent: bool = Form(False), description: str = Form(""),
                        gender: str = Form(""), language: str = Form(""), accent: str = Form(""), tags: str = Form(""), transcript: str = Form(""),
                        clean: str = Form("", description="clean the clip first: light, medium or strong (empty = as recorded)"),
                        consent_by: str = Form("", description="who gave consent (the speaker's name), kept in the voice's consent record")):
        """Add a cloned voice (with consent). The response includes `quality_check` of the clip (noise, clipping, length).
        A consent record is kept with the voice: who, when, through what, and fingerprints of the clip (GET .../consent)."""
        p = await save_upload(file)
        try:
            wav = to_wav(p)
            return await run_in_threadpool(lambda: svc.voice_add(name, wav, consent=consent, description=description, gender=gender, language=language,
                                                                 accent=accent, tags=[t for t in tags.split(",") if t.strip()], transcript=transcript or None,
                                                                 clean=clean or None, consent_by=consent_by or None, via="api"))
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)

    @app.get("/api/v1/voices/{voice_id}/consent", dependencies=deps, tags=["voices"])
    def voice_consent(voice_id: str):
        """The voice's consent record ({given, by, via, statement, time, upload_sha256, ref_sha256, clip_unchanged}), or for
        voices without one what their use rests on (`basis`: a dataset licence, a synthetic design)."""
        return svc.voice_consent(voice_id)

    @app.post("/api/v1/voices/design/candidates", dependencies=deps, tags=["voices"])
    async def design_candidates(body: DesignCands):
        """Several takes of a described voice (different seeds) to compare; keep one with .../keep."""
        return await run_in_threadpool(lambda: svc.design_candidates(body.description, n=body.n, engine=body.engine, text=body.text,
                                                                     seed=body.seed, language=body.language))

    @app.get("/api/v1/voices/design/candidates/{batch}/{n}/audio", dependencies=deps, tags=["voices"])
    def design_candidate_audio(batch: str, n: int):
        return FileResponse(svc.design_candidate_path(batch, n), media_type="audio/wav")

    @app.post("/api/v1/voices/design/candidates/{batch}/{n}/keep", dependencies=deps, tags=["voices"], status_code=201)
    def design_keep(batch: str, n: int, body: DesignKeep):
        return svc.design_keep(batch, n, body.name, gender=body.gender, language=body.language, description=body.description)

    @app.post("/api/v1/voices/design", dependencies=deps, tags=["voices"])
    async def voice_design(body: DesignBody = Body(openapi_examples=DESIGN_EXAMPLES), wait: bool = True):
        if not wait:
            return svc.jobs.submit("design", body.model_dump())
        return await run_in_threadpool(lambda: svc.voice_design(body.name, body.description, engine=body.engine, text=body.text, gender=body.gender,
                                                                language=body.language, seed=body.seed))

    @app.post("/api/v1/voices/import", dependencies=deps, tags=["voices"], status_code=201)
    async def voice_import(file: UploadFile = File(...), consent: bool = Form(False), voice_id: str = Form("")):
        """Add a voice from a voice pack (.fvvoice.zip). Needs consent=true: only voices you own or may use."""
        data = await file.read()
        return await run_in_threadpool(lambda: svc.voice_import(data, consent=consent, voice_id=voice_id or None))

    @app.get("/api/v1/voices/{voice_id}/avatar", dependencies=deps, tags=["voices"])
    def voice_avatar(voice_id: str):
        """The voice's mascot avatar (512x512 PNG). Voices list it as `avatar`: a version number to add as ?v= so a new
        image is fetched at once."""
        return FileResponse(svc.voice_avatar_path(voice_id), media_type="image/png", headers={"Cache-Control": "public, max-age=604800"})

    @app.post("/api/v1/voices/{voice_id}/avatar", dependencies=deps, tags=["voices"])
    async def voice_avatar_set(voice_id: str, file: UploadFile = File(...)):
        """Replace the avatar with any image; it is centre-cropped to a square and stored as 512x512 PNG."""
        data = await file.read()
        if len(data) > 20 * 1024 * 1024:
            raise FireVoiceError("too_large", "the image is larger than 20 MB")
        return await run_in_threadpool(svc.voice_set_avatar, voice_id, data)

    @app.delete("/api/v1/voices/{voice_id}/avatar", dependencies=deps, tags=["voices"])
    def voice_avatar_remove(voice_id: str):
        return svc.voice_remove_avatar(voice_id)

    @app.get("/api/v1/voices/{voice_id}/pack", dependencies=deps, tags=["voices"])
    def voice_pack(voice_id: str):
        """The voice as a portable pack: its clip, transcript, per-style clips, metadata, preview and avatar."""
        data, name = svc.voice_pack(voice_id)
        return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/api/v1/voices/collections", dependencies=deps, tags=["voices"])
    def voice_collections():
        """Curated shelves (featured, narrators, conversational, characters, accents, Urdu, designed) of voice ids."""
        return {"collections": svc.voice_collections()}

    @app.post("/api/v1/voices/brand", dependencies=deps, tags=["voices"])
    async def voice_brand(force: bool = False, only: Optional[list[str]] = Query(None, description="re-brand only these voices; every other name stays")):
        """(Re)assign names, taglines, traits, use cases and quality tiers. Names set by hand are kept unless force=true.
        Pass `only` (repeatable) to refresh a few voices, e.g. after correcting a voice's gender."""
        return {"branded": await run_in_threadpool(lambda: svc.voice_brand(None, force, only=only or None))}

    @app.get("/api/v1/voices/{voice_id}/preview", dependencies=deps, tags=["voices"])
    def voice_preview(voice_id: str):
        """The voice introducing itself ("Hi, I'm Isla..."); falls back to the original reference clip."""
        p = svc.voice_preview_clip(voice_id)
        return FileResponse(p, media_type="audio/mpeg" if p.suffix == ".mp3" else "audio/wav", headers={"Cache-Control": "no-cache"})   # re-renders show up at once

    @app.post("/api/v1/voices/{voice_id}/preview", dependencies=deps, tags=["voices"])
    async def voice_preview_render(voice_id: str, engine: Optional[str] = None):
        return await run_in_threadpool(svc.voice_render_preview, voice_id, engine)

    @app.get("/api/v1/voices/{voice_id}", dependencies=deps, tags=["voices"])
    def voice(voice_id: str):
        return svc.voice(voice_id)

    @app.patch("/api/v1/voices/{voice_id}", dependencies=deps, tags=["voices"])
    def voice_patch(voice_id: str, body: VoicePatch):
        return svc.voice_update(voice_id, **body.model_dump(exclude_unset=True))

    @app.put("/api/v1/voices/{voice_id}/transcript", dependencies=deps, tags=["voices"])
    def voice_transcript(voice_id: str, transcript: str = Body(..., embed=True)):
        return svc.voice_set_transcript(voice_id, transcript)

    @app.delete("/api/v1/voices/{voice_id}", dependencies=deps, tags=["voices"])
    def voice_delete(voice_id: str):
        return svc.voice_remove(voice_id)

    @app.post("/api/v1/voices/{voice_id}/default", dependencies=deps, tags=["voices"])
    def voice_default(voice_id: str):
        return svc.voice_set_default(voice_id)

    @app.get("/api/v1/voices/{voice_id}/audio", dependencies=deps, tags=["voices"])
    def voice_audio(voice_id: str, style: Optional[str] = None):
        return FileResponse(svc.voice_preview_path(voice_id, style), media_type="audio/wav")

    @app.post("/api/v1/voices/{voice_id}/styles/{style}/build", dependencies=deps, tags=["voices"])
    async def voice_style_build(voice_id: str, style: str, body: StyleBuild = Body(default_factory=lambda: StyleBuild())):
        """Give the voice its own clip for a style, rendered in that style. Renders in the style then keep both the
        voice and the delivery. Use a job (kind style_refs) for many styles."""
        return await run_in_threadpool(lambda: svc.voice_build_style_ref(voice_id, style, engine=body.engine, text=body.text, seed=body.seed))

    @app.delete("/api/v1/voices/{voice_id}/styles/{style}", dependencies=deps, tags=["voices"])
    def voice_style_remove(voice_id: str, style: str):
        return svc.voice_remove_style_ref(voice_id, style)

    @app.post("/api/v1/voices/{voice_id}/clean", dependencies=deps, tags=["voices"])
    async def voice_clean(voice_id: str, body: CleanBody = Body(default_factory=lambda: CleanBody())):
        """Clean the voice's reference clip in place (the original is kept; restore it with /restore-original)."""
        return await run_in_threadpool(svc.voice_clean, voice_id, body.strength)

    @app.post("/api/v1/voices/{voice_id}/restore-original", dependencies=deps, tags=["voices"])
    def voice_restore(voice_id: str):
        return svc.voice_restore_original(voice_id)

    @app.post("/api/v1/voices/{voice_id}/styles/{style}", dependencies=deps, tags=["voices"])
    async def voice_style_ref(voice_id: str, style: str, file: UploadFile = File(...), transcript: str = Form("")):
        p = await save_upload(file)
        try:
            wav = to_wav(p)
            return await run_in_threadpool(svc.voice_add_style_ref, voice_id, style, wav, transcript or None)
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)

    # ------------------------------------------------------------------ styles
    @app.get("/api/v1/styles", dependencies=deps, tags=["styles"])
    def styles():
        return {"styles": svc.style_list()}

    @app.get("/api/v1/styles/{name}", dependencies=deps, tags=["styles"])
    def style(name: str):
        return svc.style(name)

    @app.put("/api/v1/styles/{name}", dependencies=deps, tags=["styles"])
    def style_put(name: str, body: dict[str, Any] = Body(...)):
        return svc.style_save({**body, "name": name})

    @app.delete("/api/v1/styles/{name}", dependencies=deps, tags=["styles"])
    def style_delete(name: str):
        return svc.style_remove(name)

    # ------------------------------------------------------------------ tts
    async def render_until_disconnect(request, req):
        """Render in the thread pool, and cancel the render (dropping its queued GPU work) if the client goes away."""
        import asyncio
        cancel = threading.Event()
        task = asyncio.ensure_future(run_in_threadpool(lambda: svc.tts(req, cancel=cancel)))
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=0.5)
            if not done and await request.is_disconnected():
                cancel.set()
        return task.result()

    @app.post("/api/v1/tts", dependencies=deps, tags=["tts"], responses={200: {
        "description": "audio in the requested format (or JSON when response=json)",
        "content": {"audio/mpeg": {}, "audio/wav": {}, "application/json": {}}}})
    async def tts(request: Request, body: TTSBody = Body(openapi_examples=TTS_EXAMPLES)):
        req = body.request()
        r = await render_until_disconnect(request, req)
        data = await run_in_threadpool(svc.encode, r, body.format, body.sample_rate)
        if body.response == "json":
            return {"audio_base64": base64.b64encode(data).decode(), "format": body.format, **r.info()}
        return Response(data, media_type=A.media_type(body.format), headers=info_headers(r))

    @app.post("/api/v1/tts/stream", dependencies=deps, tags=["tts"])
    def tts_stream(body: TTSBody = Body(openapi_examples=TTS_EXAMPLES)):
        """Server-Sent Events: `chunk` events ({index, total, start, sample_rate, format, audio_base64, words, text}) in order as soon
        as each is ready, then `done` (render info) or `error`. Chunks are loudness-matched; the final studio chain is not applied."""
        req = body.request()
        svc.prepare(req)
        fmt = body.format if body.format in ("wav", "pcm16", "mp3", "ogg", "opus", "flac") else "wav"

        def events():
            # svc.stream cancels the render (and its queued GPU work) when this generator is closed on disconnect
            for ev in svc.stream(req):
                if ev["type"] == "chunk":
                    audio = ev.pop("audio")
                    ev["format"] = fmt
                    ev["audio_base64"] = base64.b64encode(svc.encode(audio, fmt, body.sample_rate, sr=ev["sample_rate"])).decode() if len(audio) else ""
                    if body.sample_rate:
                        ev["sample_rate"] = body.sample_rate
                yield ev
        return sse(events())

    @app.post("/api/v1/tts/stream.pcm", dependencies=deps, tags=["tts"])
    async def tts_stream_pcm(body: TTSBody = Body(openapi_examples=TTS_EXAMPLES)):
        """Raw little-endian 16-bit mono PCM, streamed chunk by chunk. Headers: X-Sample-Rate."""
        req = body.request()
        eng, *_ = svc.prepare(req)
        info = await run_in_threadpool(svc.load, eng)
        sr = body.sample_rate or info.get("runtime_sample_rate") or info.get("sample_rate")

        def chunks():
            import numpy as np
            for ev in svc.stream(req):
                if ev["type"] == "chunk" and len(ev["audio"]):
                    a = ev["audio"]
                    if body.sample_rate and body.sample_rate != ev["sample_rate"]:
                        yield svc.encode(a, "pcm16", body.sample_rate, sr=ev["sample_rate"])
                    else:
                        yield (np.clip(a, -1, 1) * 32767).astype("<i2").tobytes()
                elif ev["type"] == "error":
                    return
        return StreamingResponse(chunks(), media_type="audio/L16", headers={"X-Sample-Rate": str(sr), "X-Channels": "1"})

    # ------------------------------------------------------------------ stt
    @app.post("/api/v1/stt", dependencies=deps, tags=["stt"])
    async def stt(file: UploadFile = File(...), language: str = Form("auto"), beam_size: int = Form(5),
                  prompt: str = Form("", description="context that steers spelling and style"),
                  keyterms: str = Form("", description="comma-separated names and terms to spell right"),
                  diarize: bool = Form(False, description="label who speaks when (Speaker 1, Speaker 2...)"),
                  speakers: Optional[int] = Form(None, description="how many speakers, when known"),
                  format: Literal["json", "text", "srt", "vtt"] = Form("json"),
                  save: bool = Form(True, description="keep the result in History (default); false skips it")):
        """Speech to text: text, language, word times, segments (with speakers when diarize=true), or subtitles."""
        p = await save_upload(file)
        hid = None
        try:
            wav = await run_in_threadpool(to_wav, p)
            r = await run_in_threadpool(lambda: svc.transcribe(wav, None, language, beam_size, prompt=prompt or None,
                                                               keyterms=[k for k in keyterms.split(",") if k.strip()], diarize=diarize, speakers=speakers))
            if save:
                def keep():
                    import soundfile as _sf
                    a, asr = _sf.read(wav, dtype="float32", always_2d=False)
                    if getattr(a, "ndim", 1) > 1:
                        a = a.mean(axis=1)
                    srt, _ = svc.subtitles(_speaker_words(r["words"]), "srt")
                    return svc.history.add("transcript", Path(file.filename or "recording").name, audio={"audio": a}, sr=asr,
                                           texts={"transcript.json": r, "transcript.srt": srt, "transcript.txt": r.get("text_roman") or r["text"]},
                                           meta={"language": r.get("language"), "words": len(r.get("words") or []), "diarize": diarize},
                                           compressed=("audio",))["id"]
                hid = await run_in_threadpool(keep)
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)
        hh = {"X-History-Id": hid, "Access-Control-Expose-Headers": "X-History-Id"} if hid else {}
        if format == "text":
            return Response(r.get("text_roman") or r["text"], media_type="text/plain; charset=utf-8", headers=hh)
        if format in ("srt", "vtt"):
            text, mt = svc.subtitles(_speaker_words(r["words"]), format)
            return Response(text, media_type=mt, headers=hh)
        return {**r, "history_id": hid}

    # ------------------------------------------------------------------ live dictation
    @app.post("/api/v1/dictate/warm", dependencies=deps, tags=["stt"])
    async def dictate_warm():
        """Load the speech model now, so the first dictation starts at once. -> {"model", "device"}"""
        return await run_in_threadpool(svc.dictation_warm)

    @app.websocket("/api/v1/dictate")
    async def dictate(ws: WebSocket):
        """Live dictation: speech in as it is spoken, text out as soon as it is certain.

        Client: first {"type": "start", "language": "auto"|code, "keyterms": [...], "commands": true, "fillers": true,
        "refine": false, "sample_rate": 16000}; then binary messages of 16-bit little-endian mono PCM at that rate, as
        the microphone delivers them; {"type": "stop"} when the speaker is done; {"type": "cancel"} to drop it all.
        Server: {"type": "ready"}; {"type": "partial", "commit", "text", "tentative"} whenever something changes:
        "commit" is new text that is final (append it; it is never taken back), "text" everything final so far,
        "tentative" the still-changing guess after it; {"type": "final", "commit", "text", "replace", "seconds",
        "language"} after stop, then the connection closes. With "refine" a short dictation is transcribed once more
        as a whole at the end: "replace": true then means "text" is the better version of everything (for clients
        that insert only at the end). "commands" turns spoken "new line" / "new paragraph" into line breaks, "fillers"
        drops um and uh. {"type": "error", "code", "message"} on failure. Auth: ?token= or the usual headers."""
        import asyncio

        import numpy as np
        given = (ws.headers.get("authorization", "").removeprefix("Bearer ").strip() or ws.headers.get("x-api-key") or ws.query_params.get("token"))
        if token and not _same(given, token):
            await ws.close(code=4401)
            return
        await ws.accept()
        try:
            first = await ws.receive_json()
            if first.get("type") != "start":
                raise FireVoiceError("bad_request", 'the first message must be {"type": "start"}')
            rate = int(first.get("sample_rate") or 16000)
            if not 8000 <= rate <= 96000:
                raise FireVoiceError("bad_request", "sample_rate must be between 8000 and 96000")
            live = await run_in_threadpool(lambda: svc.dictation(
                language=first.get("language"), keyterms=first.get("keyterms") or None, commands=bool(first.get("commands", True)),
                fillers=bool(first.get("fillers", True)), refine=bool(first.get("refine", False))))
        except FireVoiceError as err:
            await ws.send_json({"type": "error", "code": err.code, "message": err.message})
            await ws.close()
            return
        except WebSocketDisconnect:
            return
        except Exception as err:  # noqa: BLE001
            from .service import friendly_error
            await ws.send_json({"type": "error", "code": "internal", "message": friendly_error(err)})
            await ws.close()
            return
        await ws.send_json({"type": "ready"})
        state = {"stop": False, "cancel": False, "gone": False}

        async def receive():
            from .asr import _resample16k
            try:
                while True:
                    m = await ws.receive()
                    if m.get("type") == "websocket.disconnect":
                        state["gone"] = True
                        return
                    if m.get("bytes"):
                        pcm = np.frombuffer(m["bytes"][: len(m["bytes"]) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
                        live.feed(_resample16k(pcm, rate))
                    elif m.get("text"):
                        t = json.loads(m["text"]).get("type")
                        if t in ("stop", "cancel"):
                            state[t] = True
                            return
            except (WebSocketDisconnect, RuntimeError):
                state["gone"] = True

        rx = asyncio.ensure_future(receive())
        try:
            while not rx.done():
                ev = await run_in_threadpool(live.step)
                if ev:
                    await ws.send_json({"type": "partial", **ev})
                else:
                    await asyncio.sleep(0.04)
            if state["stop"]:
                ev = await run_in_threadpool(live.finish)
                await ws.send_json({"type": "final", **ev, "seconds": round(live.total, 2), "language": live.language})
        except (WebSocketDisconnect, RuntimeError):
            pass
        except Exception as err:  # noqa: BLE001
            import logging
            logging.getLogger("firevoice").exception("dictation failed")
            from .service import friendly_error
            try:
                await ws.send_json({"type": "error", "code": "internal", "message": friendly_error(err)})
            except Exception:  # noqa: BLE001
                pass
        finally:
            rx.cancel()
            if not state["gone"]:
                try:
                    await ws.close()
                except Exception:  # noqa: BLE001
                    pass

    # ------------------------------------------------------------------ OpenAI-compatible
    class OAISpeech(BaseModel):
        model_config = ConfigDict(extra="ignore")
        model: str = "tts-1"
        input: str = Field(..., min_length=1, max_length=200_000)
        voice: str = "alloy"
        response_format: Literal["mp3", "opus", "aac", "flac", "wav", "pcm"] = "mp3"
        speed: float = Field(1.0, ge=0.25, le=4.0)
        instructions: Optional[str] = None

    @app.post("/v1/audio/speech", dependencies=deps, tags=["openai"])
    async def oai_speech(request: Request, body: OAISpeech):
        """OpenAI's speech route. `voice` is an OpenAI name (alloy, nova...: mapped to library voices) or any library
        voice; `model` is an engine name or any OpenAI model name (then the default engine); `instructions` steer the
        delivery; `pcm` is 24 kHz 16-bit mono like OpenAI's."""
        eng = body.model if _is_engine(body.model) else None
        req = TTSRequest(text=body.input, engine=eng, voice=svc.openai_voice(body.voice), pace=body.speed,
                         instruct=body.instructions or None)
        r = await render_until_disconnect(request, req)
        fmt = {"pcm": "pcm16"}.get(body.response_format, body.response_format)
        data = svc.encode(r, fmt, 24000 if fmt == "pcm16" else None)
        return Response(data, media_type=A.media_type(fmt))

    @app.post("/v1/audio/transcriptions", dependencies=deps, tags=["openai"])
    async def oai_transcriptions(file: UploadFile = File(...), model: str = Form("whisper-1"), language: Optional[str] = Form(None),
                                 prompt: Optional[str] = Form(None), response_format: str = Form("json"), temperature: float = Form(0.0)):
        """OpenAI's transcription route: json, text, srt, vtt or verbose_json (with words and segments)."""
        p = await save_upload(file)
        try:
            wav = to_wav(p)
            r = await run_in_threadpool(lambda: svc.transcribe(wav, None, language or "auto", 5, prompt=prompt or None))
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)
        if response_format == "text":
            return Response(r.get("text_roman") or r["text"], media_type="text/plain; charset=utf-8")
        if response_format in ("srt", "vtt"):
            text, mt = svc.subtitles(_roman(r["words"]), response_format)
            return Response(text, media_type=mt)
        if response_format == "verbose_json":
            return {"task": "transcribe", "language": r["language"], "duration": r["duration"], "text": r.get("text_roman") or r["text"],
                    "words": [{"word": w["text"], "start": w["start"], "end": w["end"]} for w in _roman(r["words"])],
                    "segments": [{"id": i, "start": s["start"], "end": s["end"], "text": s["text"]} for i, s in enumerate(_roman(r["segments"]))]}
        return {"text": r.get("text_roman") or r["text"]}

    # ------------------------------------------------------------------ WebSocket: text in as it arrives, audio out

    @app.websocket("/api/v1/tts/ws")
    async def tts_ws(ws: WebSocket):
        """Text arrives in pieces (an LLM's tokens), audio goes out per sentence as soon as each is complete.

        Client messages (JSON): {"type": "config", ...any TTS request field except text} first (optional);
        {"type": "text", "text": "..."} (appended); {"type": "flush"} (speak what is buffered now); {"type": "end"}
        (flush, then close when done); {"type": "cancel"} (drop the buffer and stop speaking).
        Server messages: {"type": "audio", index, segment, audio_base64, format, sample_rate, words, text, partial?},
        {"type": "segment_done", segment, text}, {"type": "done"}, {"type": "error", code, message}.
        Auth: ?token= or the usual headers."""
        import asyncio
        import queue as _queue
        given = (ws.headers.get("authorization", "").removeprefix("Bearer ").strip() or ws.headers.get("x-api-key") or ws.query_params.get("token"))
        if token and not _same(given, token):
            await ws.close(code=4401)
            return
        await ws.accept()
        loop = asyncio.get_running_loop()
        out: asyncio.Queue = asyncio.Queue()
        segs: _queue.Queue = _queue.Queue()
        state = {"cfg": {}, "buf": "", "cancel": threading.Event(), "n": 0, "ending": False}

        def worker():
            while True:
                item = segs.get()
                if item is None:
                    loop.call_soon_threadsafe(out.put_nowait, {"type": "done"})
                    return
                k, text, cfg, cancel = item
                if cancel.is_set():
                    continue
                try:
                    req = TTSRequest.from_dict({**{k: v for k, v in cfg.items() if k not in ("format", "sample_rate")}, "text": text})
                    fmt = cfg.get("format", "wav") if cfg.get("format") in ("wav", "pcm16", "mp3", "ogg", "opus", "flac") else "wav"
                    for ev in svc.stream(req, cancel=_Either(cancel)):
                        if ev["type"] == "chunk":
                            audio = ev.pop("audio")
                            ev["audio_base64"] = base64.b64encode(svc.encode(audio, fmt, None, sr=ev["sample_rate"])).decode() if len(audio) else ""
                            ev.update({"type": "audio", "segment": k, "format": fmt})
                            loop.call_soon_threadsafe(out.put_nowait, ev)
                        elif ev["type"] in ("error",):
                            loop.call_soon_threadsafe(out.put_nowait, {**ev, "segment": k})
                    loop.call_soon_threadsafe(out.put_nowait, {"type": "segment_done", "segment": k, "text": text})
                except FireVoiceError as e:
                    loop.call_soon_threadsafe(out.put_nowait, {"type": "error", "segment": k, "code": e.code, "message": e.message})
                except Exception as e:  # noqa: BLE001
                    loop.call_soon_threadsafe(out.put_nowait, {"type": "error", "segment": k, "code": "internal", "message": str(e)[:300]})

        threading.Thread(target=worker, daemon=True, name="fv-ws").start()

        def cut(final: bool):
            buf = state["buf"]
            if final:
                text, state["buf"] = buf.strip(), ""
            else:
                ends = [m.end() for m in re.finditer(r"[.!?…]['\")\]]*\s", buf)]
                ends = [e for e in ends if e >= 30] or ([] if len(buf) < 400 else [len(buf)])
                if not ends:
                    return
                text, state["buf"] = buf[: ends[-1]].strip(), buf[ends[-1]:]
            if text:
                segs.put((state["n"], text, dict(state["cfg"]), state["cancel"]))
                state["n"] += 1

        async def sender():
            while True:
                ev = await out.get()
                await ws.send_json(ev)
                if ev.get("type") == "done":
                    return

        send_task = asyncio.ensure_future(sender())
        try:
            while not send_task.done():
                recv = asyncio.ensure_future(ws.receive_json())
                done, _ = await asyncio.wait({recv, send_task}, return_when=asyncio.FIRST_COMPLETED)
                if recv not in done:
                    recv.cancel()
                    break
                msg = recv.result()
                t = msg.get("type")
                if t == "config":
                    cfg = {k: v for k, v in msg.items() if k != "type"}
                    try:
                        TTSRequest.from_dict({**{k: v for k, v in cfg.items() if k not in ("format", "sample_rate")}, "text": "check"})
                    except FireVoiceError as err:
                        await ws.send_json({"type": "error", "code": err.code, "message": err.message})
                        continue
                    state["cfg"] = cfg
                elif t == "text":
                    state["buf"] += str(msg.get("text") or "")
                    cut(False)
                elif t == "flush":
                    cut(True)
                elif t == "cancel":
                    state["cancel"].set()
                    state["cancel"] = threading.Event()
                    state["buf"] = ""
                elif t == "end":
                    cut(True)
                    segs.put(None)
                    state["ending"] = True
                else:
                    await ws.send_json({"type": "error", "code": "bad_request", "message": f"unknown message type {t!r}"})
            await send_task
        except WebSocketDisconnect:
            pass
        finally:
            state["cancel"].set()
            if not state["ending"]:
                segs.put(None)
            send_task.cancel()

    # ------------------------------------------------------------------ jobs
    # ------------------------------------------------------------------ dictionary
    @app.get("/api/v1/dictionary", dependencies=deps, tags=["dictionary"])
    def dictionary():
        """Your rules and the built-in list. Your rules run first and win."""
        return svc.dictionary_view()

    @app.post("/api/v1/dictionary", dependencies=deps, tags=["dictionary"], status_code=201)
    def dictionary_add(body: RuleBody):
        """Add a rule. A rule with the same match (and casing option) replaces the old one."""
        return svc.dictionary_add(body.model_dump())

    @app.put("/api/v1/dictionary", dependencies=deps, tags=["dictionary"])
    def dictionary_replace(body: RulesBody):
        """Replace all your rules (import)."""
        return svc.dictionary_replace(body.rules)

    @app.post("/api/v1/dictionary/test", dependencies=deps, tags=["dictionary"])
    def dictionary_test(body: DictTest):
        """What the engine will actually read for this text, after your rules and the built-in text pass."""
        return svc.dictionary_test(body.text, body.engine, body.language, body.dictionary)

    @app.patch("/api/v1/dictionary/{rule_id}", dependencies=deps, tags=["dictionary"])
    def dictionary_update(rule_id: str, body: RulePatch):
        return svc.dictionary_update(rule_id, body.model_dump(exclude_none=True))

    @app.delete("/api/v1/dictionary/{rule_id}", dependencies=deps, tags=["dictionary"])
    def dictionary_remove(rule_id: str):
        return svc.dictionary_remove(rule_id)

    # ------------------------------------------------------------------ kept renders (takes)
    @app.get("/api/v1/renders", dependencies=deps, tags=["takes"])
    def renders(limit: int = Query(50, ge=1, le=500)):
        """Kept renders, newest first, with how many passages are flagged by the speech check."""
        return {"renders": svc.render_list(limit)}

    @app.get("/api/v1/renders/{rid}", dependencies=deps, tags=["takes"])
    def render_get(rid: str):
        """The timeline, every passage, every take with its speech check (words missed or changed), and which take is used."""
        return svc.render_get(rid)

    @app.get("/api/v1/renders/{rid}/audio", dependencies=deps, tags=["takes"])
    def render_audio(rid: str, format: str = "mp3", download: bool = False):
        """The chosen take of every passage, stitched and mastered like the original render."""
        a, sr, _w = svc.render_audio(rid)
        data = svc.encode(a, format, sr=sr)
        h = {"Content-Disposition": f'attachment; filename="{rid}.{A.FORMATS[format][2]}"'} if download else {}
        return Response(data, media_type=A.media_type(format), headers=h)

    @app.get("/api/v1/renders/{rid}/quality", dependencies=deps, tags=["takes"])
    async def render_quality(rid: str):
        """The quality report of the stitched render against its voice (see POST /api/v1/audio/quality)."""
        return await run_in_threadpool(svc.render_quality, rid)

    @app.get("/api/v1/renders/{rid}/words", dependencies=deps, tags=["takes"])
    def render_words(rid: str):
        """Word times of the stitched audio (they move when a take of a different length is chosen)."""
        a, sr, words = svc.render_audio(rid)
        return {"words": words, "duration": round(len(a) / sr, 3)}

    @app.get("/api/v1/renders/{rid}/subtitles", dependencies=deps, tags=["takes"])
    def render_subtitles(rid: str, format: Literal["srt", "vtt"] = "srt", download: bool = False):
        _a, _sr, words = svc.render_audio(rid)
        text, mt = svc.subtitles(words, format)
        h = {"Content-Disposition": f'attachment; filename="{rid}.{format}"'} if download else {}
        return Response(text, media_type=mt, headers=h)

    @app.get("/api/v1/renders/{rid}/chunks/{index}/takes/{n}/audio", dependencies=deps, tags=["takes"])
    def render_take_audio(rid: str, index: int, n: int, format: str = "wav"):
        """One take of one passage, as heard in the render."""
        import soundfile as _sf
        p = svc.render_take_path(rid, index, n)
        a, sr = _sf.read(str(p), dtype="float32", always_2d=False)
        return Response(svc.encode(a, format, sr=sr), media_type=A.media_type(format))

    @app.post("/api/v1/renders/{rid}/chunks/{index}/takes", dependencies=deps, tags=["takes"])
    async def render_retake(request: Request, rid: str, index: int, body: RetakeBody = Body(default_factory=RetakeBody)):
        """A new take of one passage (same voice, style and checks); by default it becomes the one used."""
        import asyncio
        cancel = threading.Event()
        task = asyncio.ensure_future(run_in_threadpool(lambda: svc.render_retake(rid, index, body.seed, body.choose, cancel=cancel)))
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=0.5)
            if not done and await request.is_disconnected():
                cancel.set()
        return task.result()

    @app.post("/api/v1/renders/{rid}/chunks/{index}/edit", dependencies=deps, tags=["takes"])
    async def render_edit(request: Request, rid: str, index: int, body: EditBody):
        """Change the words of one passage. The passage is re-recorded with the new text and, in `splice` mode, only
        the changed words are swapped into the original take (cut at quiet points, crossfaded); a big change uses the
        whole new recording. The result is a new take of that passage, chosen; the take records what was edited."""
        import asyncio
        cancel = threading.Event()
        task = asyncio.ensure_future(run_in_threadpool(lambda: svc.render_edit(rid, index, body.text, body.mode, body.seed, cancel=cancel)))
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=0.5)
            if not done and await request.is_disconnected():
                cancel.set()
        return task.result()

    @app.post("/api/v1/renders/{rid}/chunks/{index}/choose", dependencies=deps, tags=["takes"])
    def render_choose(rid: str, index: int, body: ChooseBody):
        return svc.render_choose(rid, index, body.take)

    @app.post("/api/v1/renders/{rid}/chunks/{index}/lock", dependencies=deps, tags=["takes"])
    def render_lock(rid: str, index: int, body: LockBody = Body(default_factory=LockBody)):
        """A locked passage keeps its take when you regenerate the rest."""
        return svc.render_lock(rid, index, body.locked)

    @app.post("/api/v1/renders/{rid}/regenerate", dependencies=deps, tags=["takes"])
    async def render_regenerate(rid: str, body: RegenBody = Body(default_factory=RegenBody)):
        """New takes for the listed passages, or every unlocked one."""
        return await run_in_threadpool(svc.render_regenerate, rid, body.chunks)

    @app.delete("/api/v1/renders/{rid}", dependencies=deps, tags=["takes"])
    def render_delete(rid: str):
        return svc.render_delete(rid)

    # ------------------------------------------------------------------ stats
    @app.get("/api/v1/stats", dependencies=deps, tags=["system"])
    def stats(days: int = Query(30, ge=0, le=3650, description="the last N days; 0 for all time")):
        """Every number: speech, sound, music, voice changes, dialogues, dubs and transcripts made; time, words and speed;
        engines, voices, styles and languages used; daily activity; when you work; records and streaks; the library;
        and disk use. Built from the usage log (seeded from history on first run)."""
        return svc.stats(days or None)

    # ------------------------------------------------------------------ history
    @app.get("/api/v1/history", dependencies=deps, tags=["history"])
    def history(kind: Optional[str] = Query(None, description="comma-separated: speech, sound, music, changer, dialogue, transcript, separate, clean"),
                limit: int = Query(100, ge=1, le=1000), before: Optional[float] = Query(None, description="only items created before this time (for paging)"),
                q: Optional[str] = Query(None, description="text in the title")):
        """Everything made, newest first. Speech items (kind "speech") are kept renders: play them at /api/v1/renders/{id}/audio.
        Other items keep their files here: /api/v1/history/{id}/files/{name}."""
        return {"items": svc.history_list(kind, limit, before, q)}

    @app.get("/api/v1/history/{hid}", dependencies=deps, tags=["history"])
    def history_item(hid: str):
        """One history item: kind, title, when, length, its files and what it was made from."""
        return svc.history_item(hid)

    @app.get("/api/v1/history/{hid}/files/{name}", dependencies=deps, tags=["history"])
    def history_file(hid: str, name: str, format: str = "mp3", download: bool = False):
        """A file of a history item. Audio comes in any format (`format`, default mp3); text and JSON as they are."""
        path, f = svc.history_file(hid, name)
        if f["type"] != "audio":
            mt = "application/json" if f["type"] == "json" else "text/plain; charset=utf-8"
            h = {"Content-Disposition": f'attachment; filename="{f["file"]}"'} if download else {}
            return Response(path.read_bytes(), media_type=mt, headers=h)
        fmt = format if format in A.FORMATS else "mp3"
        if path.suffix.lstrip(".") == A.FORMATS[fmt][2]:
            data = path.read_bytes()
        else:
            import soundfile as _sf
            a, sr = _sf.read(str(path), dtype="float32", always_2d=False)
            if getattr(a, "ndim", 1) > 1:
                a = a.mean(axis=1)
            data = svc.encode(a, fmt, sr=sr)
        h = {"Content-Disposition": f'attachment; filename="{hid}-{name}.{A.FORMATS[fmt][2]}"'} if download else {}
        return Response(data, media_type=A.media_type(fmt), headers={**h, "Cache-Control": "private, max-age=86400"})

    class HistoryPatch(BaseModel):
        title: str = Field(..., min_length=1, max_length=200)

    @app.patch("/api/v1/history/{hid}", dependencies=deps, tags=["history"])
    def history_rename(hid: str, body: HistoryPatch):
        return svc.history_rename(hid, body.title)

    @app.delete("/api/v1/history/{hid}", dependencies=deps, tags=["history"])
    def history_delete(hid: str):
        """Delete a history item and its files. Speech items are deleted with DELETE /api/v1/renders/{id}."""
        return svc.history_delete(hid)

    # ------------------------------------------------------------------ dialogue and tags
    @app.post("/api/v1/dialogue/parse", dependencies=deps, tags=["dialogue"])
    def dialogue_parse(body: DialogueParse):
        """The turns and speakers of a script, and a cast with a voice for every speaker (a library voice with the
        speaker's name first, then distinct voices)."""
        return svc.dialogue_parse(body.script, body.cast)

    @app.post("/api/v1/dialogue", dependencies=deps, tags=["dialogue"])
    async def dialogue(request: Request, body: DialogueBody):
        """Render a dialogue: each turn in its speaker's voice. Long scripts: a job of kind "dialogue"."""
        import asyncio
        import io
        import zipfile
        cancel = threading.Event()
        task = asyncio.ensure_future(run_in_threadpool(lambda: svc.dialogue(body.script, cast=body.cast, defaults=body.defaults, gap_ms=body.gap_ms,
                                                                             lufs=body.lufs, seed=body.seed, cancel=cancel)))
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=0.5)
            if not done and await request.is_disconnected():
                cancel.set()
        d = task.result()
        mix = await run_in_threadpool(svc.encode, d["audio"], body.format, None, d["sr"])
        dur = round(len(d["audio"]) / d["sr"], 3)
        hid = None
        if body.save:
            first = next((t["text"] for t in d["turns"] if t.get("kind") not in ("sfx", "music")), "Dialogue")
            stems = {f"stem-{re.sub(r'[^A-Za-z0-9 _-]+', '', n).strip() or 'speaker'}": a for n, a in d["stems"].items()}
            hid = (await run_in_threadpool(lambda: svc.history.add(
                "dialogue", first[:80], audio={"mix": d["audio"], **stems}, sr=d["sr"],
                texts={"turns.json": {"turns": d["turns"], "cast": d["cast"], "script": body.script},
                       "dialogue.srt": svc.dialogue_subtitles(d["turns"], "srt")},
                meta={"speakers": [n for n in d["stems"] if n not in ("SFX", "Music")], "turns": len(d["turns"])})))["id"]
        hh = {"X-History-Id": hid, "Access-Control-Expose-Headers": "X-History-Id, X-Duration, X-Sample-Rate"} if hid else {}
        if body.response == "audio":
            return Response(mix, media_type=A.media_type(body.format), headers={"X-Duration": str(dur), "X-Sample-Rate": str(d["sr"]), **hh})
        if body.response == "json":
            out = {"audio_base64": base64.b64encode(mix).decode(), "format": body.format, "duration": dur, "sample_rate": d["sr"],
                   "turns": d["turns"], "words": d["words"], "cast": d["cast"], "history_id": hid}
            if body.stems:
                out["stems"] = {n: base64.b64encode(svc.encode(a, body.format, sr=d["sr"])).decode() for n, a in d["stems"].items()}
            return out
        buf = io.BytesIO()
        ext = A.FORMATS[body.format][2]
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
            z.writestr(f"dialogue.{ext}", mix)
            for n, a in d["stems"].items():
                stem = re.sub(r"[^\w -]+", "", n).strip() or "speaker"
                z.writestr(f"stems/{stem}.{ext}", svc.encode(a, body.format, sr=d["sr"]))
            z.writestr("dialogue.srt", svc.dialogue_subtitles(d["turns"], "srt"))
            z.writestr("dialogue.vtt", svc.dialogue_subtitles(d["turns"], "vtt"))
            z.writestr("turns.json", json.dumps({"turns": d["turns"], "cast": d["cast"]}, indent=1, ensure_ascii=False))
        return Response(buf.getvalue(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="dialogue.zip"'})

    @app.get("/api/v1/tags", dependencies=deps, tags=["tts"])
    def tags():
        """Inline tags for scripts: sound tags ([laugh]...) with the engines that perform them (others drop them),
        delivery tags ([whisper]... [normal]) that switch style, and the markup directives."""
        return svc.tag_catalog()

    # ------------------------------------------------------------------ audio tools
    @app.get("/api/v1/dub/languages", dependencies=deps, tags=["dubbing"])
    def dub_languages():
        """Languages dubbing can translate between (M2M100, local)."""
        from . import translate
        return {"languages": list(translate.LANGS), "model": translate.MODEL, "sizes": translate.SIZES}

    @app.post("/api/v1/dub", dependencies=deps, tags=["dubbing"], status_code=202)
    async def dub(file: UploadFile = File(..., description="audio or video"), target_language: str = Form(...),
                  source_language: str = Form("auto"), voice: str = Form("", description="voice for every line (default: the default voice)"),
                  cast: str = Form("", description='JSON {"Speaker 1": "Ember", ...}: a voice per original speaker'),
                  keep_voices: bool = Form(False, description="clone each original speaker for the dub (needs consent)"),
                  consent: bool = Form(False), speakers: int = Form(0, description="number of speakers, 0 = detect"),
                  engine: str = Form(""), style: str = Form("conversational"),
                  background: float = Form(0.0, description="0-1: how much of the original audio stays underneath"),
                  format: str = Form("mp3"), video: bool = Form(True, description="for a video: also the video with the dubbed soundtrack"),
                  translator: str = Form("fast", description="fast (M2M100 418M, 2 GB) or better (M2M100 1.2B, 5 GB, more accurate)"),
                  keep_music: bool = Form(False, description="keep the original's music and effects under the dub (needs the separator engine)")):
        """Dub a recording into another language as a background job (kind `dub`): speech to text, local translation,
        each line rendered and fitted to its original slot. The job's files: dub.<format>, dub.srt, dub.vtt, lines.json and,
        for a video, the video with the new soundtrack."""
        import uuid

        from .paths import home
        try:
            cast_map = json.loads(cast) if cast.strip() else None
        except json.JSONDecodeError:
            raise FireVoiceError("bad_request", "cast must be JSON like {\"Speaker 1\": \"Ember\"}")
        d = home() / "uploads" / uuid.uuid4().hex
        d.mkdir(parents=True, exist_ok=True)
        dest = d / ("source" + (Path(file.filename or "a.wav").suffix or ".wav"))
        dest.write_bytes(await file.read())
        if dest.stat().st_size == 0:
            raise FireVoiceError("bad_request", "the uploaded file is empty")
        payload = {"input": str(dest), "name": file.filename, "target": target_language, "source": None if source_language in ("", "auto") else source_language,
                   "voice": voice or None, "cast": cast_map, "keep_voices": keep_voices, "consent": consent, "speakers": speakers or None,
                   "engine": engine or None, "style": style, "background": background, "format": format, "video": video,
                   "translator": translator if translator in ("fast", "better") else "fast", "keep_music": keep_music}
        try:
            return svc.jobs.submit("dub", payload)
        except Exception:
            import shutil
            shutil.rmtree(d, ignore_errors=True)
            raise

    @app.post("/api/v1/audio/quality", dependencies=deps, tags=["audio tools"])
    async def audio_quality(file: UploadFile = File(...), voice: str = Form("", description="compare with this voice's clip")):
        """A quality report: speaker similarity to `voice` (WavLM; same speaker from about 0.86), DNSMOS listener-score
        predictions (overall, signal, background, P.808; 1-5), and a drift check (similarity, pitch and level per 8 s
        window, with flags where they wander). -> {duration, mos, similarity, drift, verdict, notes}"""
        p = await save_upload(file)
        try:
            return await run_in_threadpool(svc.quality_report, to_wav(p), voice or None)
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)

    @app.post("/api/v1/audio/separate", dependencies=deps, tags=["audio tools"])
    async def audio_separate(file: UploadFile = File(...), mode: Literal["vocals", "denoise", "dereverb"] = Form("vocals"),
                             stem: Literal["voice", "rest", "zip"] = Form("voice"), format: str = Form("wav"),
                             save: bool = Form(True, description="keep the result in History (default); false skips it")):
        """Split a recording: vocals (voice | music and effects), denoise (voice | noise), dereverb (voice | room echo).
        `stem` picks the voice, the rest, or a zip with both; with save, History keeps both (X-History-Id), so the other
        track is at /api/v1/history/{id}/files/rest without separating again. Needs Crucible (Engines)."""
        import io
        import zipfile
        p = await save_upload(file)
        try:
            voice, rest, sr = await run_in_threadpool(lambda: svc.audio_separate(to_wav(p), mode))
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)
        hh = {}
        if save:
            label = {"vocals": "voice and music", "denoise": "voice and noise", "dereverb": "voice and room echo"}[mode]
            item = await run_in_threadpool(lambda: svc.history.add(
                "separate", f"{Path(file.filename or 'recording').name} ({label})", audio={"voice": voice, "rest": rest}, sr=sr,
                meta={"mode": mode, "source": file.filename}))
            hh = {"X-History-Id": item["id"], "Access-Control-Expose-Headers": "X-History-Id"}
        fmt = format if format in A.FORMATS else "wav"
        if stem != "zip":
            data = await run_in_threadpool(svc.encode, voice if stem == "voice" else rest, fmt, None, sr)
            return Response(data, media_type=A.media_type(fmt), headers=hh)
        buf = io.BytesIO()
        ext = A.FORMATS[fmt][2]
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
            z.writestr(f"voice.{ext}", svc.encode(voice, fmt, sr=sr))
            z.writestr(f"{'music' if mode == 'vocals' else 'noise' if mode == 'denoise' else 'echo'}.{ext}", svc.encode(rest, fmt, sr=sr))
        return Response(buf.getvalue(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="separated.zip"'})

    @app.post("/api/v1/audio/detect", dependencies=deps, tags=["audio tools"])
    async def audio_detect(file: UploadFile = File(...)):
        """Is this audio marked as AI-generated (AudioSeal), and by FireVoice? -> {watermarked, probability (share of the
        audio carrying a mark), firevoice, kind (render | convert), bits, seconds}. Survives MP3, cuts and level changes."""
        p = await save_upload(file)
        try:
            return await run_in_threadpool(svc.audio_detect, to_wav(p))
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)

    @app.post("/api/v1/audio/analyze", dependencies=deps, tags=["audio tools"])
    async def audio_analyze(file: UploadFile = File(...)):
        """How good a recording is to clone from: SNR estimate, clipping, length, silence, a verdict and notes."""
        p = await save_upload(file)
        try:
            return await run_in_threadpool(svc.audio_analyze, to_wav(p))
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)

    @app.post("/api/v1/audio/clean", dependencies=deps, tags=["audio tools"])
    async def audio_clean(file: UploadFile = File(...), strength: str = Form("medium"), format: str = Form("wav"),
                          save: bool = Form(True, description="keep the result in History (default); false skips it")):
        """Take out steady noise, hum and rumble, trim the silent ends and set the level. Headers X-Quality-Before and
        X-Quality-After carry the check before and after (JSON)."""
        p = await save_upload(file)
        try:
            out, sr, check = await run_in_threadpool(lambda: svc.audio_clean(to_wav(p), strength))
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)
        h = {"X-Quality-Before": json.dumps(check["before"]), "X-Quality-After": json.dumps(check["after"])}
        if save:
            item = await run_in_threadpool(lambda: svc.history.add("clean", Path(file.filename or "recording").name, audio={"audio": out}, sr=sr,
                                                                   meta={"strength": strength, "before": check["before"], "after": check["after"]}))
            h["X-History-Id"] = item["id"]
        data = await run_in_threadpool(svc.encode, out, format, None, sr)
        return Response(data, media_type=A.media_type(format), headers={**h, "Access-Control-Expose-Headers": ", ".join(h)})

    @app.post("/api/v1/voice-changer", dependencies=deps, tags=["audio tools"])
    async def voice_changer(request: Request, file: UploadFile = File(...), voice: str = Form("default"), format: str = Form("mp3"),
                            lufs: Optional[float] = Form(-16.0), save: bool = Form(True, description="keep the result in History (default); false skips it")):
        """Speech to speech: keeps the words, timing and delivery of your recording and swaps the voice for a library voice."""
        import asyncio
        p = await save_upload(file)
        cancel = threading.Event()
        try:
            wav = await run_in_threadpool(to_wav, p)
            task = asyncio.ensure_future(run_in_threadpool(lambda: svc.voice_convert(wav, voice, lufs=lufs, cancel=cancel)))
            while not task.done():
                done, _ = await asyncio.wait({task}, timeout=0.5)
                if not done and await request.is_disconnected():
                    cancel.set()
            out, sr = task.result()
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)
        h = {"X-Duration": str(round(len(out) / sr, 3)), "X-Sample-Rate": str(sr)}
        if save:
            vname = (svc.voices.get(voice) or {}).get("name") if voice != "default" and svc.voices.exists(voice) else None
            item = await run_in_threadpool(lambda: svc.history.add(
                "changer", f"{Path(file.filename or 'recording').name} as {vname or 'the default voice'}", audio={"audio": out}, sr=sr,
                meta={"voice": voice, "voice_name": vname, "source": file.filename}))
            h["X-History-Id"] = item["id"]
        data = await run_in_threadpool(svc.encode, out, format, None, sr)
        return Response(data, media_type=A.media_type(format), headers={**h, "Access-Control-Expose-Headers": ", ".join(h)})

    # ------------------------------------------------------------------ projects
    @app.get("/api/v1/projects", dependencies=deps, tags=["projects"])
    def projects():
        return {"projects": svc.project_list()}

    @app.post("/api/v1/projects", dependencies=deps, tags=["projects"], status_code=201)
    def project_new(body: ProjectNew):
        """Create a project, optionally from a whole script (chapters from heading lines, paragraphs from blank lines)."""
        return svc.project_create(body.title, body.text, body.defaults)

    @app.post("/api/v1/projects/import", dependencies=deps, tags=["projects"], status_code=201)
    async def project_import(file: UploadFile = File(...)):
        """A new project from a bundle (.fvproject.zip), with every take it carried."""
        data = await file.read()
        return await run_in_threadpool(svc.project_import, data)

    @app.get("/api/v1/projects/{pid}", dependencies=deps, tags=["projects"])
    def project_get(pid: str):
        """Chapters, paragraphs with their status (draft, rendered, stale, locked) and render, counts and durations."""
        return svc.project_get(pid)

    @app.patch("/api/v1/projects/{pid}", dependencies=deps, tags=["projects"])
    def project_patch(pid: str, body: ProjectPatch):
        return svc.project_update(pid, body.title, body.defaults, body.chapters)

    @app.delete("/api/v1/projects/{pid}", dependencies=deps, tags=["projects"])
    def project_delete(pid: str):
        return svc.project_delete(pid)

    @app.post("/api/v1/projects/{pid}/paragraphs/{para}/render", dependencies=deps, tags=["projects"])
    async def paragraph_render(request: Request, pid: str, para: str):
        """Render one paragraph now (every take kept; its takes are under /api/v1/renders/{render id})."""
        import asyncio
        cancel = threading.Event()
        task = asyncio.ensure_future(run_in_threadpool(lambda: svc.paragraph_render(pid, para, cancel=cancel)))
        while not task.done():
            done, _ = await asyncio.wait({task}, timeout=0.5)
            if not done and await request.is_disconnected():
                cancel.set()
        return task.result()

    @app.post("/api/v1/projects/{pid}/paragraphs/{para}/lock", dependencies=deps, tags=["projects"])
    def paragraph_lock(pid: str, para: str, body: LockBody = Body(default_factory=LockBody)):
        return svc.paragraph_lock(pid, para, body.locked)

    @app.get("/api/v1/projects/{pid}/paragraphs/{para}/audio", dependencies=deps, tags=["projects"])
    def paragraph_audio(pid: str, para: str, format: str = "mp3"):
        a, sr, _w = svc.paragraph_audio(pid, para)
        return Response(svc.encode(a, format, sr=sr), media_type=A.media_type(format))

    @app.post("/api/v1/projects/{pid}/render", dependencies=deps, tags=["projects"], status_code=202)
    def project_render(pid: str, body: ProjectRender = Body(default_factory=ProjectRender)):
        """Render drafts and changed paragraphs (or all unlocked ones) as a background job; follow it under /api/v1/jobs."""
        return svc.jobs.submit("project", {"project": pid, "scope": body.scope, "chapter": body.chapter})

    @app.get("/api/v1/projects/{pid}/export", dependencies=deps, tags=["projects"])
    def project_export(pid: str, format: str = "mp3", chapter: Optional[str] = None,
                       master: Optional[Literal["audiobook"]] = Query(None, description="audiobook = bring each file inside the usual audiobook limits"),
                       allow_missing: bool = False):
        """The book (or one chapter): any audio format, m4b with chapter marks, or srt / vtt subtitles."""
        data, mt, name = svc.project_export(pid, format, chapter, master, allow_missing)
        return Response(data, media_type=mt, headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.get("/api/v1/projects/{pid}/check", dependencies=deps, tags=["projects"])
    def project_check(pid: str, master: Optional[Literal["audiobook"]] = None):
        """The audiobook check per chapter: loudness, peaks, noise floor, quiet at the start and end."""
        return svc.project_check(pid, master)

    @app.get("/api/v1/projects/{pid}/bundle", dependencies=deps, tags=["projects"])
    def project_bundle(pid: str):
        """The project and every take as one zip, to move or back up; import it with POST /api/v1/projects/import."""
        data, name = svc.project_bundle(pid)
        return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.post("/api/v1/subtitles", dependencies=deps, tags=["tts"])
    def subtitles(body: SubBody):
        """SRT or WebVTT from word timings (the `words` of any /tts JSON response or stream)."""
        text, mt = svc.subtitles(body.words, body.format)
        return Response(text, media_type=mt)

    @app.get("/api/v1/jobs/{job_id}/subtitles", dependencies=deps, tags=["jobs"])
    def job_subtitles(job_id: str, format: Literal["srt", "vtt"] = "srt", download: bool = False):
        """Subtitles for a finished tts job."""
        words = json.loads(svc.jobs.file(job_id, "words.json").read_text(encoding="utf-8"))
        text, mt = svc.subtitles(words, format)
        h = {"Content-Disposition": f'attachment; filename="{job_id}.{format}"'} if download else {}
        return Response(text, media_type=mt, headers=h)

    @app.post("/api/v1/jobs", dependencies=deps, tags=["jobs"], status_code=202)
    async def job_submit(body: JobBody = Body(openapi_examples=JOB_EXAMPLES)):
        return await run_in_threadpool(svc.jobs.submit, body.kind, body.payload, body.title)

    @app.get("/api/v1/jobs", dependencies=deps, tags=["jobs"])
    def jobs(status: Optional[str] = None, kind: Optional[str] = None, limit: int = Query(100, ge=1, le=1000)):
        return {"jobs": svc.jobs.list(status=status, kind=kind, limit=limit), "counts": svc.jobs.counts()}

    @app.get("/api/v1/jobs/events", dependencies=deps, tags=["jobs"])
    def job_events_all(request: Request, since: Optional[int] = None):
        """Every job event. Resume with ?since=<id> or the browser's automatic Last-Event-ID header; with neither,
        only new events are sent (no replay of history: list the jobs for that)."""
        since = _resume_from(request, since, svc.jobs.seq)
        return sse(svc.jobs.events(since=since))

    @app.get("/api/v1/jobs/{job_id}", dependencies=deps, tags=["jobs"])
    def job(job_id: str):
        return svc.jobs.get(job_id)

    @app.get("/api/v1/jobs/{job_id}/events", dependencies=deps, tags=["jobs"])
    def job_events(job_id: str, request: Request, since: Optional[int] = None):
        svc.jobs.get(job_id)
        return sse(svc.jobs.events(since=_resume_from(request, since, 0), job_id=job_id))

    @app.post("/api/v1/jobs/{job_id}/cancel", dependencies=deps, tags=["jobs"])
    def job_cancel(job_id: str):
        return svc.jobs.cancel(job_id)

    @app.delete("/api/v1/jobs/{job_id}", dependencies=deps, tags=["jobs"])
    def job_delete(job_id: str):
        return svc.jobs.delete(job_id)

    @app.get("/api/v1/jobs/{job_id}/audio", dependencies=deps, tags=["jobs"])
    def job_audio(job_id: str, download: bool = False):
        p = svc.jobs.file(job_id)
        return FileResponse(p, media_type=_media(p), filename=p.name if download else None)

    @app.get("/api/v1/jobs/{job_id}/files/{name}", dependencies=deps, tags=["jobs"])
    def job_file(job_id: str, name: str, download: bool = False):
        p = svc.jobs.file(job_id, name)
        return FileResponse(p, media_type=_media(p), filename=p.name if download else None)

    # ------------------------------------------------------------------ ElevenLabs-compatible
    class XITTS(BaseModel):
        text: str
        model_id: Optional[str] = None
        voice_settings: Optional[dict] = None
        style: Optional[str] = None
        seed: Optional[int] = None

    def xi_request(voice_id: str, body: XITTS) -> TTSRequest:
        vs = body.voice_settings or {}
        over = {}
        if vs:   # stability / style map onto sampling temperature; speed onto pace
            stability = float(vs.get("stability", 0.5))
            over["temperature"] = round(min(1.2, max(0.3, 1.1 - 0.6 * stability + 0.2 * float(vs.get("style", 0.0)))), 3)
        engine = body.model_id if body.model_id and _is_engine(body.model_id) else None
        return TTSRequest(text=body.text, engine=engine, voice=voice_id, style=body.style or "conversational", pace=float(vs.get("speed", 1.0)),
                          seed=body.seed or 1234, style_overrides=over)

    @app.post("/v1/text-to-speech/{voice_id}", dependencies=deps, tags=["elevenlabs"])
    async def xi_tts(request: Request, voice_id: str, body: XITTS, output_format: str = "mp3_44100_128"):
        r = await render_until_disconnect(request, xi_request(voice_id, body))
        fmt = "wav" if output_format.startswith(("pcm", "wav")) else "mp3"
        data = await run_in_threadpool(svc.encode, r, fmt)
        return Response(data, media_type=A.media_type(fmt), headers=info_headers(r))

    @app.post("/v1/text-to-speech/{voice_id}/with-timestamps", dependencies=deps, tags=["elevenlabs"])
    async def xi_tts_ts(request: Request, voice_id: str, body: XITTS):
        r = await render_until_disconnect(request, xi_request(voice_id, body))
        data = await run_in_threadpool(svc.encode, r, "mp3")
        chars, starts, ends = [], [], []
        for w in r.result.words:   # character times are interpolated inside each word
            n = max(1, len(w.text))
            for i, c in enumerate(w.text):
                chars.append(c)
                starts.append(round(w.start + (w.end - w.start) * i / n, 3))
                ends.append(round(w.start + (w.end - w.start) * (i + 1) / n, 3))
        return {"audio_base64": base64.b64encode(data).decode(),
                "alignment": {"characters": chars, "character_start_times_seconds": starts, "character_end_times_seconds": ends},
                "words": [w.__dict__ for w in r.result.words], "warnings": r.info()["warnings"]}

    @app.get("/v1/voices", dependencies=deps, tags=["elevenlabs"])
    def xi_voices():
        return {"voices": [{"voice_id": "default", "name": "Default (library default)", "category": "builtin"}] + svc.voice_list()}

    @app.post("/v1/voices/add", dependencies=deps, tags=["elevenlabs"])
    async def xi_voice_add(name: str = Form(...), file: UploadFile = File(...), consent: str = Form("false"), description: str = Form("")):
        p = await save_upload(file)
        try:
            wav = to_wav(p)
            return await run_in_threadpool(lambda: svc.voice_add(name, wav, consent=consent.lower() == "true", description=description))
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)

    class LegacyBatch(BaseModel):
        lines: list[dict]
        out_dir: str
        seed: Optional[int] = None
        lufs: Optional[float] = -16.0
        force: bool = False
        voice: Optional[str] = None
        style: Optional[str] = None
        pace: Optional[float] = None
        engine: Optional[str] = None

    @app.post("/v1/batch", dependencies=deps, tags=["legacy"])
    async def legacy_batch(body: LegacyBatch):
        """Older studio contract: render lines into out_dir (<id>.wav, <id>.words.json, manifest.json) and return the entries.
        New clients should POST /api/v1/jobs with kind "batch"."""
        import time as _t

        from .batch import run_batch
        from .service import home
        # this route writes files: keep it inside FIREVOICE_HOME/exports (a relative out_dir lands there)
        base = (home() / "exports").resolve()
        out = Path(body.out_dir)
        out = (out if out.is_absolute() else base / out).resolve()
        roots = [home().resolve()] + [Path(x).resolve() for x in os.environ.get("FIREVOICE_EXPORT_ROOTS", "").split(os.pathsep) if x.strip()]
        if not any(out == r or r in out.parents for r in roots):
            raise FireVoiceError("bad_request", f"out_dir must be inside {base} (a relative path is resolved there) or a folder "
                                               "listed in FIREVOICE_EXPORT_ROOTS")
        if any("id" not in ln or "text" not in ln for ln in body.lines):
            raise FireVoiceError("bad_request", "every line needs an 'id' and a 'text'")
        body.out_dir = str(out)
        eng = svc._resolve_engine(body.engine)
        ld = await run_in_threadpool(svc._pool, eng)
        s = svc._synth(ld, True, 1, 0.9)
        t0 = _t.time()
        entries = await run_in_threadpool(run_batch, s, body.lines, body.out_dir, voice=body.voice or "default", style=body.style or "conversational",
                                          pace=body.pace or 1.0, seed=body.seed if body.seed is not None else 1234, lufs=body.lufs, force=body.force, log=None)
        return {"entries": entries, "seconds": round(_t.time() - t0, 3), "cache": {"hits": s.cache_hits, "misses": s.cache_misses}}

    @app.get("/v1/models", dependencies=deps, tags=["elevenlabs"])
    def xi_models():
        return [{"model_id": e["name"], "name": e["title"], "languages": [{"language_id": l} for l in e["languages"]], "can_do_text_to_speech": e["ready"]}
                for e in svc.engines()]

    _check_signatures(app)
    return app


class _Either:
    """A cancel flag for one sentence of a WebSocket session: set when the session is cancelled, and settable on its
    own (a finished stream sets its flag) without touching the session's."""

    def __init__(self, session: threading.Event):
        self.session, self.own = session, threading.Event()

    def is_set(self) -> bool:
        return self.session.is_set() or self.own.is_set()

    def set(self) -> None:
        self.own.set()

    def wait(self, timeout=None) -> bool:
        return self.own.wait(timeout) or self.session.is_set()


def _same(given: Optional[str], expected: Optional[str]) -> bool:
    """Token check in constant time."""
    import hmac
    return bool(given) and bool(expected) and hmac.compare_digest(str(given).encode(), str(expected).encode())


def _roman(items: list) -> list:
    """Urdu comes out in Roman letters: words or segments with a `roman` reading use it as their text."""
    return [{**w, "text": w.get("roman") or w["text"]} for w in items]


def _speaker_words(words: list) -> list:
    """Words for subtitles; with speaker labels, a cue starts at each change of speaker and names them."""
    out, last = [], None
    words = _roman(words)
    for w in words:
        sp = w.get("speaker")
        if sp and sp != last:
            out.append({**w, "text": f"{sp}: {w['text']}", "start": w["start"]})
            last = sp
        else:
            out.append(w)
    return out


def _resume_from(request, since: Optional[int], default: int) -> int:
    """Where an event stream starts: ?since=, else the Last-Event-ID header an EventSource sends on reconnect."""
    if since is not None:
        return since
    h = request.headers.get("last-event-id")
    if h and h.strip().isdigit():
        return int(h.strip())
    return default


def _media(p: Path) -> str:
    ext = p.suffix.lower().lstrip(".")
    return {"json": "application/json", "pcm": "audio/L16", "m4a": "audio/mp4", "opus": "audio/ogg"}.get(ext) or next(
        (v[1] for k, v in A.FORMATS.items() if v[2] == ext), "application/octet-stream")


def _is_engine(name: str) -> bool:
    from .core.registry import get_engine
    try:
        get_engine(name)
        return True
    except ValueError:
        return False


DEFAULT_ENGINE = os.environ.get("FIREVOICE_ENGINE", "voxcpm2")


def _quiet_logs() -> None:
    """Keep the server's log readable when it goes to a file (the desktop app's backend.log): no progress bars (each
    redraw would be a line, hundreds per model load) and none of the libraries' deprecation notices about their own
    code, which say nothing about FireVoice."""
    import sys
    import warnings
    if not sys.stderr.isatty():
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        os.environ.setdefault("TQDM_DISABLE", "1")
    for cat in (FutureWarning, DeprecationWarning, UserWarning):
        warnings.filterwarnings("ignore", category=cat, module=r"(torch|transformers|diffusers|resemblyzer|webrtcvad|librosa)(\..*)?")


def main(argv=None) -> int:
    """Start the HTTP API. This is the one way to run the backend: the desktop app starts it like this, and everything
    else (other programs, AI agents) talks to the API it serves."""
    import argparse
    import sys
    import time

    p = argparse.ArgumentParser(prog="firevoice-server", description="FireVoice HTTP API (docs at /docs)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8787)
    p.add_argument("--engine", default=None, help=f"default engine (default {DEFAULT_ENGINE})")
    p.add_argument("--preload", default=None, help="comma-separated engines to load at startup")
    p.add_argument("--workers", type=int, default=None, help="model copies per preloaded engine")
    p.add_argument("--token", default=None, help="require this API token (also FIREVOICE_API_KEY)")
    p.add_argument("--no-token", action="store_true", help="allow --host on a network address without a token (only on a network you trust)")
    p.add_argument("--cors", default=None, help="comma-separated allowed origins (default: localhost and the desktop app)")
    p.add_argument("--asr-model", default="auto")
    p.add_argument("--asr-device", default="auto")
    p.add_argument("--log-level", default="warning", choices=["critical", "error", "warning", "info", "debug"])
    a = p.parse_args(argv)

    _quiet_logs()
    import uvicorn

    from .core.brands import name_of

    local = a.host in ("127.0.0.1", "localhost", "::1")
    if not local and not (a.token or os.environ.get("FIREVOICE_API_KEY")):
        if not a.no_token:
            print("refusing to listen on a non-local address without --token (or FIREVOICE_API_KEY); "
                  "--no-token allows it on a network you trust", file=sys.stderr)
            return 2
        print(f"WARNING: no token on {a.host}: anyone who can reach this port can use FireVoice "
              "(renders, voices, cloning, files)", file=sys.stderr, flush=True)
    svc = FireVoice(default_engine=a.engine or DEFAULT_ENGINE, asr_model=a.asr_model, asr_device=a.asr_device,
                    workers={e: a.workers for e in (a.preload or "").split(",") if e} if a.workers else None)
    for e in [x for x in (a.preload or "").split(",") if x]:
        print(f"loading {e}...", flush=True)
        t0 = time.time()
        svc.load(e)
        print(f"  {e} ready in {time.time() - t0:.0f}s", flush=True)
    app = create_app(svc, token=a.token, cors_origins=a.cors.split(",") if a.cors else None)
    engine = svc.default_engine
    print(f"FireVoice API on http://{a.host}:{a.port}  (docs: http://{a.host}:{a.port}/docs, default engine {name_of(engine) if engine else '?'})", flush=True)
    try:
        uvicorn.run(app, host=a.host, port=a.port, log_level=a.log_level)
    finally:
        svc.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
