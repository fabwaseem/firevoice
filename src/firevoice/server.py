"""FireVoice HTTP API (FastAPI). Everything goes through the FireVoice service, so the API, the CLI and the desktop
app behave identically. Interactive docs: http://127.0.0.1:8787/docs

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
import tempfile
from pathlib import Path
from typing import Any, Literal, Optional

from . import audio as A
from .service import FireVoice, FireVoiceError, TTSRequest

TAGS = [
    {"name": "system", "description": "Health, GPU and everything a UI needs in one call (`/api/v1/options`)."},
    {"name": "engines", "description": "Engine catalog, capabilities, parameter schemas, install status, load and unload."},
    {"name": "voices", "description": "Voice library: upload (with consent), design from a description, edit, per-style clips, previews."},
    {"name": "styles", "description": "Delivery styles: built in plus your own."},
    {"name": "tts", "description": "Text to speech: whole file, streamed chunks (SSE) or raw PCM. One request shape for every engine."},
    {"name": "stt", "description": "Speech to text with word times and language detection."},
    {"name": "jobs", "description": "Background renders, batches and voice design with progress events and history."},
    {"name": "elevenlabs", "description": "ElevenLabs-compatible routes for existing clients."},
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
        "text": "Aaj mausam bohat acha hai. Chalo, chai peetay hain.", "voice": "Ayesha", "language": "ur", "format": "mp3"}},
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
MAX_UPLOAD = 60 * 1024 * 1024


def create_app(svc: FireVoice, token: Optional[str] = None, cors_origins: Optional[list[str]] = None):
    from fastapi import Body, Depends, FastAPI, File, Form, Query, Request, Security, UploadFile
    from fastapi.concurrency import run_in_threadpool
    from fastapi.exceptions import RequestValidationError
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
    from fastapi.security import APIKeyHeader, HTTPBearer
    from pydantic import BaseModel, ConfigDict, Field

    from . import __version__

    token = token or os.environ.get("FIREVOICE_API_KEY") or None
    app = FastAPI(
        title="FireVoice", version=__version__, openapi_tags=TAGS,
        description=("Local expressive text-to-speech and speech-to-text engine: many open models, one API. "
                     "Use **Try it out** on any route and pick a ready-made example from the Examples dropdown; TTS routes return audio you "
                     "can download from the response panel. For playing and streaming audio, recording speech and watching jobs live, "
                     "open the [playground](/playground). Full contract: docs/API.md in the repository."),
        swagger_ui_parameters={"tryItOutEnabled": True, "persistAuthorization": True, "displayRequestDuration": True, "filter": True,
                               "docExpansion": "list", "defaultModelsExpandDepth": 0, "syntaxHighlight.theme": "obsidian"})
    app.state.svc = svc
    app.add_middleware(CORSMiddleware, allow_origins=cors_origins or [], allow_credentials=False, allow_methods=["*"], allow_headers=["*"],
                       allow_origin_regex=None if cors_origins else r"^(https?://(localhost|127\.0\.0\.1)(:\d+)?|tauri://localhost|https?://tauri\.localhost|app://.*)$",
                       expose_headers=["X-Duration", "X-Sample-Rate", "X-Engine", "X-RTF", "X-Warnings", "Content-Disposition"])

    # ------------------------------------------------------------------ errors + auth
    def err(code: str, message: str, status: Optional[int] = None):
        return JSONResponse({"error": {"code": code, "message": message}}, status_code=status or STATUS.get(code, 500))

    @app.exception_handler(FireVoiceError)
    async def _fv(_req, e: FireVoiceError):
        return err(e.code, e.message)

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
        if given != token:
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
        kind: Literal["tts", "batch", "design", "previews"]
        payload: dict[str, Any]
        title: str = ""

    def info_headers(r) -> dict:
        i = r.info()
        return {"X-Duration": str(i["duration"]), "X-Sample-Rate": str(r.sr), "X-Engine": i["engine"], "X-RTF": str(i["rtf"]),
                "X-Warnings": str(len(i["warnings"]))}

    async def save_upload(f: UploadFile) -> str:
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise FireVoiceError("too_large", f"upload is {len(data) // 1024 // 1024} MB; the limit is {MAX_UPLOAD // 1024 // 1024} MB")
        if not data:
            raise FireVoiceError("bad_request", "the uploaded file is empty")
        suffix = Path(f.filename or "audio.wav").suffix or ".wav"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as t:
            t.write(data)
        return t.name

    def to_wav(path: str) -> str:
        """Decode anything ffmpeg reads (mp3, m4a, ogg, webm from a browser recorder...) to wav."""
        import subprocess
        if path.lower().endswith((".wav", ".flac")):
            return path
        out = path + ".wav"
        p = subprocess.run([A._ffmpeg(), "-y", "-v", "error", "-i", path, "-ac", "1", out], capture_output=True)
        if p.returncode != 0:
            raise FireVoiceError("bad_request", "could not decode the uploaded audio: " + p.stderr.decode(errors="replace")[-200:])
        return out

    def sse(gen):
        def body():
            for ev in gen:
                yield f"event: {ev.get('type', 'message')}\ndata: {json.dumps(ev, default=str, ensure_ascii=False)}\n\n"
        return StreamingResponse(body(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    # ------------------------------------------------------------------ pages
    @app.get("/", include_in_schema=False)
    def root():
        return RedirectResponse("/playground")

    from fastapi.staticfiles import StaticFiles
    web = Path(__file__).parent / "web"
    app.mount("/web", StaticFiles(directory=str(web)), name="web")

    @app.get("/playground", include_in_schema=False)
    def playground():
        return HTMLResponse((web / "index.html").read_text(encoding="utf-8"), headers={"Cache-Control": "no-cache"})

    # ------------------------------------------------------------------ system
    @app.get("/health", tags=["system"])
    def health():
        return {"ok": True, "version": __version__, "auth": bool(token)}

    @app.get("/api/v1/system", dependencies=deps, tags=["system"])
    def system():
        return svc.system()

    @app.get("/api/v1/options", dependencies=deps, tags=["system"])
    def options():
        defaults = TTSRequest(text="").to_dict()
        defaults.pop("text")
        return {"engines": svc.engines(), "styles": svc.style_list(), "formats": list(A.FORMATS), "defaults": {**defaults, "format": "mp3"},
                "default_engine": svc.system()["default_engine"], "voice_count": len(svc.voices.list()),
                "languages": sorted({v.get("language") or "en" for v in svc.voices.list()})}

    # ------------------------------------------------------------------ engines
    @app.get("/api/v1/engines", dependencies=deps, tags=["engines"])
    def engines():
        return {"engines": svc.engines()}

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

    @app.post("/api/v1/voices", dependencies=deps, tags=["voices"], status_code=201)
    async def voice_add(file: UploadFile = File(...), name: str = Form(...), consent: bool = Form(False), description: str = Form(""),
                        gender: str = Form(""), language: str = Form(""), accent: str = Form(""), tags: str = Form(""), transcript: str = Form("")):
        p = await save_upload(file)
        try:
            wav = to_wav(p)
            return await run_in_threadpool(lambda: svc.voice_add(name, wav, consent=consent, description=description, gender=gender, language=language,
                                                                 accent=accent, tags=[t for t in tags.split(",") if t.strip()], transcript=transcript or None))
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)

    @app.post("/api/v1/voices/design", dependencies=deps, tags=["voices"])
    async def voice_design(body: DesignBody = Body(openapi_examples=DESIGN_EXAMPLES), wait: bool = True):
        if not wait:
            return svc.jobs.submit("design", body.model_dump())
        return await run_in_threadpool(lambda: svc.voice_design(body.name, body.description, engine=body.engine, text=body.text, gender=body.gender,
                                                                language=body.language, seed=body.seed))

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
    @app.post("/api/v1/tts", dependencies=deps, tags=["tts"], responses={200: {
        "description": "audio in the requested format (or JSON when response=json)",
        "content": {"audio/mpeg": {}, "audio/wav": {}, "application/json": {}}}})
    async def tts(body: TTSBody = Body(openapi_examples=TTS_EXAMPLES)):
        req = body.request()
        r = await run_in_threadpool(svc.tts, req)
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
    async def stt(file: UploadFile = File(...), language: str = Form("auto"), beam_size: int = Form(5)):
        p = await save_upload(file)
        try:
            wav = to_wav(p)
            return await run_in_threadpool(svc.transcribe, wav, None, language, beam_size)
        finally:
            for x in (p, p + ".wav"):
                Path(x).unlink(missing_ok=True)

    # ------------------------------------------------------------------ jobs
    @app.post("/api/v1/jobs", dependencies=deps, tags=["jobs"], status_code=202)
    async def job_submit(body: JobBody = Body(openapi_examples=JOB_EXAMPLES)):
        return await run_in_threadpool(svc.jobs.submit, body.kind, body.payload, body.title)

    @app.get("/api/v1/jobs", dependencies=deps, tags=["jobs"])
    def jobs(status: Optional[str] = None, kind: Optional[str] = None, limit: int = Query(100, ge=1, le=1000)):
        return {"jobs": svc.jobs.list(status=status, kind=kind, limit=limit), "counts": svc.jobs.counts()}

    @app.get("/api/v1/jobs/events", dependencies=deps, tags=["jobs"])
    def job_events_all(since: int = 0):
        return sse(svc.jobs.events(since=since))

    @app.get("/api/v1/jobs/{job_id}", dependencies=deps, tags=["jobs"])
    def job(job_id: str):
        return svc.jobs.get(job_id)

    @app.get("/api/v1/jobs/{job_id}/events", dependencies=deps, tags=["jobs"])
    def job_events(job_id: str, since: int = 0):
        svc.jobs.get(job_id)
        return sse(svc.jobs.events(since=since, job_id=job_id))

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
    async def xi_tts(voice_id: str, body: XITTS, output_format: str = "mp3_44100_128"):
        r = await run_in_threadpool(svc.tts, xi_request(voice_id, body))
        fmt = "wav" if output_format.startswith(("pcm", "wav")) else "mp3"
        data = await run_in_threadpool(svc.encode, r, fmt)
        return Response(data, media_type=A.media_type(fmt), headers=info_headers(r))

    @app.post("/v1/text-to-speech/{voice_id}/with-timestamps", dependencies=deps, tags=["elevenlabs"])
    async def xi_tts_ts(voice_id: str, body: XITTS):
        r = await run_in_threadpool(svc.tts, xi_request(voice_id, body))
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

    return app


def _media(p: Path) -> str:
    ext = p.suffix.lower().lstrip(".")
    return {"json": "application/json", "pcm": "audio/L16", "m4a": "audio/aac", "opus": "audio/ogg"}.get(ext) or next(
        (v[1] for k, v in A.FORMATS.items() if v[2] == ext), "application/octet-stream")


def _is_engine(name: str) -> bool:
    from .core.registry import get_engine
    try:
        get_engine(name)
        return True
    except ValueError:
        return False
