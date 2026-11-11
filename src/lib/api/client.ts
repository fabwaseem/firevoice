import { useSettings } from "@/stores/settings";
import type { HistoryItem, HistoryKind, Stats } from "./types";
import type { ApiErrorBody, AudiobookCheck, ChapterEdit, ClipCheck, ConsentRecord, DesignBatch, DialogueParse, DialogueResult, DictRule, DictRuleInput, DictView, Engine, Health, InstallPlan, Job, JobEvent, JobKind, KeptRender, Options, PathSettingKey, PathsReport, Project, ProjectSummary, QualityReport, STTResult, SetupReport, StreamEvent, Style, SystemInfo, TTSJson, TTSRequest, Voice, VoiceCollection, VoiceLibraryStatus, WatermarkResult, WordTime } from "./types";
import { rememberEngineNames } from "@/lib/engineNames";
import { saveBlob } from "@/lib/audio";
import { DEFAULT_SERVER, normaliseServerUrl } from "@/stores/settings";

export { normaliseServerUrl };

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function base(): string {
  return normaliseServerUrl(useSettings.getState().serverUrl);
}

/** The Authorization header for the current token (empty when no token is set). */
export function authHeaders(): Record<string, string> {
  const t = useSettings.getState().token;
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Append ?token= for <audio src> and EventSource, which cannot send headers. */
export function withToken(url: string): string {
  const t = useSettings.getState().token;
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}

export function url(path: string, query?: Record<string, string | number | boolean | null | undefined>): string {
  let u: URL;
  try {
    u = new URL(path, base() + "/");
  } catch {
    u = new URL(path, DEFAULT_SERVER + "/");
  }
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody | null = null;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    /* non-JSON error */
  }
  const code = body?.error?.code ?? (res.status === 401 ? "unauthorized" : "http_" + res.status);
  const message = body?.error?.message ?? res.statusText ?? "Request failed";
  return new ApiError(res.status, code, message);
}

/** Combine a caller's abort signal with a timeout, using the best the runtime offers. */
function withTimeout(signal: AbortSignal | null | undefined, timeoutMs?: number): AbortSignal | undefined {
  if (!timeoutMs) return signal ?? undefined;
  const timeout =
    typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(timeoutMs)
      : (() => {
          const c = new AbortController();
          setTimeout(() => c.abort(new DOMException("The request timed out", "TimeoutError")), timeoutMs);
          return c.signal;
        })();
  if (!signal) return timeout;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, [signal, timeout]);
  const c = new AbortController();
  const abort = (s: AbortSignal) => () => c.abort(s.reason);
  if (signal.aborted) c.abort(signal.reason);
  else signal.addEventListener("abort", abort(signal), { once: true });
  timeout.addEventListener("abort", abort(timeout), { once: true });
  return c.signal;
}

type RequestOptions = RequestInit & { timeoutMs?: number };

/** Health and system calls give up after this long so the app never hangs on "Connecting". */
const QUICK_TIMEOUT = 8000;

async function request<T>(path: string, init: RequestOptions = {}, query?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
  const { timeoutMs, ...rest } = init;
  const headers: Record<string, string> = { ...authHeaders(), ...((rest.headers as Record<string, string>) ?? {}) };
  if (rest.body && typeof rest.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url(path, query), { ...rest, headers, signal: withTimeout(rest.signal, timeoutMs) });
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new ApiError(0, "timeout", "FireVoice took too long to answer. Please try again.");
    }
    throw e;
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

const json = (body: unknown) => JSON.stringify(body);

// ------------------------------------------------------------------ system
export const api = {
  health: () => request<Health>("/health", { timeoutMs: QUICK_TIMEOUT }),
  system: async () => {
    const s = await request<SystemInfo>("/api/v1/system", { timeoutMs: QUICK_TIMEOUT });
    rememberEngineNames(s.engine_names);
    return s;
  },
  options: async () => {
    const o = await request<Options>("/api/v1/options");
    rememberEngineNames(o.engine_names);
    return o;
  },

  // ---------------------------------------------------------------- engines
  engines: async (task: "tts" | "sfx" | "vc" | "all" = "tts") => {
    const list = (await request<{ engines: Engine[] }>("/api/v1/engines", {}, { task })).engines;
    rememberEngineNames(Object.fromEntries(list.map((e) => [e.name, e.title])));
    return list;
  },
  sound: async (body: { prompt: string; kind: "sfx" | "music"; duration: number; seed?: number; format?: string }) => {
    const res = await fetch(url("/api/v1/sound"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: json({ format: "mp3", ...body }),
    });
    if (!res.ok) throw await parseError(res);
    const h = (k: string) => res.headers.get(k) ?? "";
    return { blob: await res.blob(), seed: h("X-Seed"), duration: h("X-Duration"), engine: h("X-Engine"), historyId: h("X-History-Id") || null };
  },
  engine: (name: string) => request<Engine>(`/api/v1/engines/${encodeURIComponent(name)}`),
  // loading a model into the graphics card can take minutes the first time (it is compiled and warmed up)
  loadEngine: (name: string, workers?: number) =>
    request<Engine>(`/api/v1/engines/${encodeURIComponent(name)}/load`, { method: "POST", body: json(workers ? { workers } : {}), timeoutMs: 20 * 60_000 }),
  // the speech model that checks every render (and types dictation): about 1.6 GB, fetched the first time it is used
  warmSpeech: () => request<{ model: string; device: string }>("/api/v1/dictate/warm", { method: "POST", timeoutMs: 20 * 60_000 }),
  unloadEngine: (name: string) => request<Engine>(`/api/v1/engines/${encodeURIComponent(name)}/unload`, { method: "POST" }),
  installPlan: (name: string, sizes = true) => request<InstallPlan>(`/api/v1/engines/${encodeURIComponent(name)}/install`, {}, { sizes }),
  installEngine: (name: string, force = false) =>
    request<Job>(`/api/v1/engines/${encodeURIComponent(name)}/install`, { method: "POST" }, { force }),
  uninstallEngine: (name: string, weights = false) =>
    request<{ engine: string; removed: string[]; also_affects: string[] }>(`/api/v1/engines/${encodeURIComponent(name)}/install`, { method: "DELETE" }, { weights }),
  paths: () => request<PathsReport>("/api/v1/system/paths", { timeoutMs: QUICK_TIMEOUT }),
  setupReport: () => request<SetupReport>("/api/v1/system/setup", { timeoutMs: QUICK_TIMEOUT * 4 }),
  voiceLibrary: () => request<VoiceLibraryStatus>("/api/v1/voices/library", { timeoutMs: QUICK_TIMEOUT }),
  installVoiceLibrary: () => request<Job>("/api/v1/voices/library", { method: "POST" }),
  saveSettings: (body: Partial<Record<PathSettingKey, string>>) =>
    request<{ settings: PathsReport["settings"]; restart_required: boolean; paths: PathsReport }>("/api/v1/system/settings", { method: "PUT", body: json(body) }),

  // ----------------------------------------------------------------- voices
  voices: async (filters: { language?: string; gender?: string; kind?: string; tag?: string; q?: string } = {}) =>
    (await request<{ voices: Voice[] }>("/api/v1/voices", {}, filters)).voices,
  voice: (id: string) => request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}`),
  voiceAudioUrl: (id: string, style?: string) => withToken(url(`/api/v1/voices/${encodeURIComponent(id)}/audio`, { style })),
  /** the voice introducing itself; the server falls back to the reference clip when no preview was rendered */
  voicePreviewUrl: (id: string) => withToken(url(`/api/v1/voices/${encodeURIComponent(id)}/preview`)),
  voiceCollections: async () => (await request<{ collections: VoiceCollection[] }>("/api/v1/voices/collections")).collections,
  renderVoicePreview: (id: string) => request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/preview`, { method: "POST" }),
  addVoice: (form: FormData) => request<Voice>("/api/v1/voices", { method: "POST", body: form }),
  voiceConsent: (id: string) => request<ConsentRecord>(`/api/v1/voices/${encodeURIComponent(id)}/consent`),
  qualityReport: (file: Blob, voice?: string) => {
    const fd = new FormData();
    fd.append("file", file, file instanceof File ? file.name : "audio");
    if (voice) fd.append("voice", voice);
    return request<QualityReport>("/api/v1/audio/quality", { method: "POST", body: fd });
  },
  dubLanguages: () => request<{ languages: string[]; model: string; sizes: Record<string, string> }>("/api/v1/dub/languages"),
  dub: (file: Blob, opts: { target_language: string; source_language?: string; voice?: string; keep_voices?: boolean; consent?: boolean;
    background?: number; translator?: "fast" | "better"; keep_music?: boolean; format?: string; cast?: Record<string, string> }) => {
    const fd = new FormData();
    fd.append("file", file, file instanceof File ? file.name : "recording.wav");
    for (const [k, v] of Object.entries({ format: "mp3", ...opts })) {
      if (v === undefined || v === null || v === "") continue;
      fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
    return request<Job>("/api/v1/dub", { method: "POST", body: fd });
  },
  separate: async (file: Blob, mode: "vocals" | "denoise" | "dereverb", stem: "voice" | "rest") => {
    const fd = new FormData();
    fd.append("file", file, file instanceof File ? file.name : "audio");
    fd.append("mode", mode);
    fd.append("stem", stem);
    fd.append("format", "mp3");
    const res = await fetch(url("/api/v1/audio/separate"), { method: "POST", headers: authHeaders(), body: fd });
    if (!res.ok) throw await parseError(res);
    return { blob: await res.blob(), historyId: res.headers.get("X-History-Id") };
  },
  renderQuality: (id: string) => request<QualityReport>(`/api/v1/renders/${encodeURIComponent(id)}/quality`),
  detectWatermark: (file: Blob, name = "audio") => {
    const fd = new FormData();
    fd.append("file", file, file instanceof File ? file.name : name);
    return request<WatermarkResult>("/api/v1/audio/detect", { method: "POST", body: fd });
  },
  designVoice: (body: { name: string; description: string; engine?: string; text?: string; gender?: string; language?: string; seed?: number }, wait = true) =>
    request<Voice | Job>("/api/v1/voices/design", { method: "POST", body: json(body) }, { wait: wait ? undefined : "false" }),
  updateVoice: (id: string, patch: Partial<Pick<Voice, "name" | "tagline" | "description" | "gender" | "language" | "accent" | "tags" | "favorite" | "notes">>) =>
    request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}`, { method: "PATCH", body: json(patch) }),
  setTranscript: (id: string, transcript: string) =>
    request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/transcript`, { method: "PUT", body: json({ transcript }) }),
  deleteVoice: (id: string) => request<unknown>(`/api/v1/voices/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setDefaultVoice: (id: string) => request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/default`, { method: "POST" }),
  addStyleClip: (id: string, style: string, form: FormData) =>
    request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/styles/${encodeURIComponent(style)}`, { method: "POST", body: form }),

  // ----------------------------------------------------------------- styles
  styles: async () => {
    const r = await request<{ styles: Style[] } | Style[]>("/api/v1/styles");
    return Array.isArray(r) ? r : r.styles;
  },
  style: (name: string) => request<Style>(`/api/v1/styles/${encodeURIComponent(name)}`),
  putStyle: (name: string, body: Partial<Style>) => request<Style>(`/api/v1/styles/${encodeURIComponent(name)}`, { method: "PUT", body: json(body) }),
  deleteStyle: (name: string) => request<unknown>(`/api/v1/styles/${encodeURIComponent(name)}`, { method: "DELETE" }),

  // -------------------------------------------------------------------- tts
  /** Whole-file render. Returns the audio as a Blob plus the X-* headers. */
  tts: async (req: TTSRequest, signal?: AbortSignal) => {
    const res = await fetch(url("/api/v1/tts"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: json({ ...req, response: "audio" }),
      signal,
    });
    if (!res.ok) throw await parseError(res);
    const blob = await res.blob();
    const h = (k: string) => res.headers.get(k);
    return {
      blob,
      duration: Number(h("X-Duration") ?? 0),
      sampleRate: Number(h("X-Sample-Rate") ?? 0),
      engine: h("X-Engine") ?? "",
      rtf: Number(h("X-RTF") ?? 0),
      warnings: (h("X-Warnings") ?? "").split(";").map((s) => s.trim()).filter(Boolean),
    };
  },
  /** Whole-file render with word times. */
  ttsJson: (req: TTSRequest, signal?: AbortSignal) =>
    request<TTSJson>("/api/v1/tts", { method: "POST", body: json({ ...req, response: "json" }), signal }),

  /** Sentence-by-sentence SSE stream. Yields parsed events; abort the signal to cancel the render. */
  async *ttsStream(req: TTSRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await fetch(url("/api/v1/tts/stream"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: json(req),
      signal,
    });
    if (!res.ok) throw await parseError(res);
    if (!res.body) throw new ApiError(500, "internal", "empty stream body");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as StreamEvent;
        } catch {
          /* ignore malformed block */
        }
      }
    }
  },

  // -------------------------------------------------------------------- stt
  stt: async (file: Blob, opts: { language?: string; beam_size?: number; filename?: string; keyterms?: string; diarize?: boolean } = {}, signal?: AbortSignal) => {
    const fd = new FormData();
    fd.append("file", file, opts.filename ?? (file instanceof File ? file.name : "recording.webm"));
    fd.append("language", opts.language ?? "auto");
    if (opts.beam_size) fd.append("beam_size", String(opts.beam_size));
    if (opts.keyterms) fd.append("keyterms", opts.keyterms);
    if (opts.diarize) fd.append("diarize", "true");
    return request<STTResult>("/api/v1/stt", { method: "POST", body: fd, signal });
  },

  // ------------------------------------------------------------------- jobs
  jobs: (filters: { status?: string; kind?: string; limit?: number } = {}) =>
    request<{ jobs: Job[]; counts: Record<string, number> }>("/api/v1/jobs", {}, filters),
  job: (id: string) => request<Job>(`/api/v1/jobs/${encodeURIComponent(id)}`),
  createJob: (kind: JobKind, payload: Record<string, unknown>, title = "") =>
    request<Job>("/api/v1/jobs", { method: "POST", body: json({ kind, payload, title }) }),
  cancelJob: (id: string) => request<Job>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  deleteJob: (id: string) => request<unknown>(`/api/v1/jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // ---- pronunciation dictionary
  dictionary: () => request<DictView>("/api/v1/dictionary"),
  addRule: (r: DictRuleInput) => request<DictRule>("/api/v1/dictionary", { method: "POST", body: json(r) }),
  updateRule: (id: string, r: Partial<DictRuleInput>) => request<DictRule>(`/api/v1/dictionary/${encodeURIComponent(id)}`, { method: "PATCH", body: json(r) }),
  removeRule: (id: string) => request<unknown>(`/api/v1/dictionary/${encodeURIComponent(id)}`, { method: "DELETE" }),
  replaceRules: (rules: DictRuleInput[]) => request<{ rules: DictRule[] }>("/api/v1/dictionary", { method: "PUT", body: json({ rules }) }),
  testDictionary: (text: string, engine?: string | null) =>
    request<{ text: string; spoken: string; engine: string }>("/api/v1/dictionary/test", { method: "POST", body: json({ text, engine: engine ?? undefined }) }),

  // ---- dialogue
  dialogueParse: (script: string, cast?: Record<string, unknown>) => request<DialogueParse>("/api/v1/dialogue/parse", { method: "POST", body: json({ script, cast }) }),
  dialogue: (body: Record<string, unknown>) => request<DialogueResult>("/api/v1/dialogue", { method: "POST", body: json(body) }),
  dialogueZip: async (body: Record<string, unknown>) => {
    const res = await fetch(url("/api/v1/dialogue"), { method: "POST", body: json({ ...body, response: "zip" }), headers: { "Content-Type": "application/json", ...authHeaders() } });
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },

  // ---- audio tools
  analyzeAudio: (file: Blob, name = "audio.wav") => {
    const fd = new FormData();
    fd.append("file", file, name);
    return request<ClipCheck>("/api/v1/audio/analyze", { method: "POST", body: fd });
  },
  voiceChange: async (file: Blob, name: string, voice: string, signal?: AbortSignal) => {
    const fd = new FormData();
    fd.append("file", file, name);
    fd.append("voice", voice);
    fd.append("format", "mp3");
    const res = await fetch(url("/api/v1/voice-changer"), { method: "POST", body: fd, headers: authHeaders(), signal });
    if (!res.ok) throw await parseError(res);
    return { blob: await res.blob(), duration: Number(res.headers.get("X-Duration") ?? 0), historyId: res.headers.get("X-History-Id") };
  },
  cleanVoice: (id: string, strength: "light" | "medium" | "strong" | "neural") =>
    request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/clean`, { method: "POST", body: json({ strength }) }),
  restoreVoice: (id: string) => request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/restore-original`, { method: "POST" }),
  buildStyleClip: (id: string, style: string) =>
    request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/styles/${encodeURIComponent(style)}/build`, { method: "POST", body: json({}) }),
  removeStyleClip: (id: string, style: string) =>
    request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/styles/${encodeURIComponent(style)}`, { method: "DELETE" }),
  designCandidates: (body: { description: string; n?: number; engine?: string; text?: string }) =>
    request<DesignBatch>("/api/v1/voices/design/candidates", { method: "POST", body: json(body) }),
  designCandidateUrl: (batch: string, n: number) => withToken(url(`/api/v1/voices/design/candidates/${batch}/${n}/audio`)),
  keepDesignCandidate: (batch: string, n: number, body: { name: string; gender?: string; language?: string }) =>
    request<Voice>(`/api/v1/voices/design/candidates/${batch}/${n}/keep`, { method: "POST", body: json(body) }),

  // ---- voice avatars
  voiceAvatarUrl: (v: { voice_id: string; avatar?: number | null } | null | undefined) =>
    v?.avatar ? withToken(url(`/api/v1/voices/${encodeURIComponent(v.voice_id)}/avatar`, { v: v.avatar })) : null,
  setVoiceAvatar: (id: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/avatar`, { method: "POST", body: fd });
  },
  removeVoiceAvatar: (id: string) => request<Voice>(`/api/v1/voices/${encodeURIComponent(id)}/avatar`, { method: "DELETE" }),

  // ---- projects
  projects: async () => (await request<{ projects: ProjectSummary[] }>("/api/v1/projects")).projects,
  project: (id: string) => request<Project>(`/api/v1/projects/${encodeURIComponent(id)}`),
  createProject: (body: { title: string; text?: string; defaults?: Record<string, unknown> }) =>
    request<Project>("/api/v1/projects", { method: "POST", body: json(body) }),
  updateProject: (id: string, body: { title?: string; defaults?: Record<string, unknown>; chapters?: ChapterEdit[] }) =>
    request<Project>(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: json(body) }),
  deleteProject: (id: string) => request<unknown>(`/api/v1/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  renderParagraph: (id: string, para: string, signal?: AbortSignal) =>
    request<Project>(`/api/v1/projects/${encodeURIComponent(id)}/paragraphs/${encodeURIComponent(para)}/render`, { method: "POST", signal }),
  lockParagraph: (id: string, para: string, locked: boolean) =>
    request<Project>(`/api/v1/projects/${encodeURIComponent(id)}/paragraphs/${encodeURIComponent(para)}/lock`, { method: "POST", body: json({ locked }) }),
  paragraphAudioUrl: (id: string, para: string) => withToken(url(`/api/v1/projects/${encodeURIComponent(id)}/paragraphs/${encodeURIComponent(para)}/audio`, { format: "mp3" })),
  chapterAudioUrl: (id: string, chapter: string) =>
    withToken(url(`/api/v1/projects/${encodeURIComponent(id)}/export`, { format: "mp3", chapter, allow_missing: true })),
  renderProject: (id: string, scope: "stale" | "all" = "stale", chapter?: string) =>
    request<Job>(`/api/v1/projects/${encodeURIComponent(id)}/render`, { method: "POST", body: json({ scope, chapter: chapter ?? null }) }),
  exportProject: async (id: string, format: string, master?: "audiobook" | null) => {
    const res = await fetch(url(`/api/v1/projects/${encodeURIComponent(id)}/export`, { format, master: master ?? undefined }), { headers: authHeaders() });
    if (!res.ok) throw await parseError(res);
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `project.${format}`;
    return { blob: await res.blob(), name };
  },
  checkProject: (id: string, master?: "audiobook" | null) => request<AudiobookCheck>(`/api/v1/projects/${encodeURIComponent(id)}/check`, {}, { master: master ?? undefined }),
  projectBundle: async (id: string) => {
    const res = await fetch(url(`/api/v1/projects/${encodeURIComponent(id)}/bundle`), { headers: authHeaders() });
    if (!res.ok) throw await parseError(res);
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "project.fvproject.zip";
    return { blob: await res.blob(), name };
  },
  importProject: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return request<Project>("/api/v1/projects/import", { method: "POST", body: fd });
  },

  // ---- kept renders: takes and QA
  keptRender: (id: string) => request<KeptRender>(`/api/v1/renders/${encodeURIComponent(id)}`),
  stats: (days: number) => request<Stats>("/api/v1/stats", {}, { days }),
  // ---- history: everything made
  history: (q: { kind?: HistoryKind | HistoryKind[]; limit?: number; before?: number; q?: string } = {}) =>
    request<{ items: HistoryItem[] }>("/api/v1/history", {}, {
      kind: Array.isArray(q.kind) ? q.kind.join(",") : q.kind,
      limit: q.limit ?? 60,
      before: q.before,
      q: q.q,
    }).then((r) => r.items),
  historyItem: (id: string) => request<HistoryItem>(`/api/v1/history/${encodeURIComponent(id)}`),
  /** A playable URL for a history item's audio (speech items come from their kept render). */
  historyAudioUrl: (item: Pick<HistoryItem, "id" | "source">, stem = "audio", format = "mp3") =>
    item.source === "render"
      ? withToken(url(`/api/v1/renders/${encodeURIComponent(item.id)}/audio`, { format }))
      : withToken(url(`/api/v1/history/${encodeURIComponent(item.id)}/files/${encodeURIComponent(stem)}`, { format })),
  historyFile: async (item: Pick<HistoryItem, "id" | "source">, stem = "audio", format = "mp3") => {
    const path = item.source === "render" ? `/api/v1/renders/${encodeURIComponent(item.id)}/audio` : `/api/v1/history/${encodeURIComponent(item.id)}/files/${encodeURIComponent(stem)}`;
    const res = await fetch(url(path, { format }), { headers: authHeaders() });
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },
  renameHistory: (id: string, title: string) => request<HistoryItem>(`/api/v1/history/${encodeURIComponent(id)}`, { method: "PATCH", body: json({ title }) }),
  deleteHistory: (item: Pick<HistoryItem, "id" | "source">) =>
    item.source === "render"
      ? request<{ deleted: boolean }>(`/api/v1/renders/${encodeURIComponent(item.id)}`, { method: "DELETE" })
      : request<{ deleted: boolean }>(`/api/v1/history/${encodeURIComponent(item.id)}`, { method: "DELETE" }),
  keptRenderWords: (id: string) => request<{ words: WordTime[]; duration: number }>(`/api/v1/renders/${encodeURIComponent(id)}/words`),
  keptRenderAudio: async (id: string, format: string) => {
    const res = await fetch(url(`/api/v1/renders/${encodeURIComponent(id)}/audio`, { format }), { headers: authHeaders() });
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },
  takeAudioUrl: (id: string, index: number, n: number) => withToken(url(`/api/v1/renders/${encodeURIComponent(id)}/chunks/${index}/takes/${n}/audio`, { format: "mp3" })),
  newTake: (id: string, index: number, seed?: number) =>
    request<KeptRender>(`/api/v1/renders/${encodeURIComponent(id)}/chunks/${index}/takes`, { method: "POST", body: json({ seed: seed ?? null }) }),
  chooseTake: (id: string, index: number, take: number) =>
    request<KeptRender>(`/api/v1/renders/${encodeURIComponent(id)}/chunks/${index}/choose`, { method: "POST", body: json({ take }) }),
  /** Change a passage's words: "splice" keeps the original audio around the change, "passage" uses the re-recording. */
  editPassage: (id: string, index: number, text: string, mode: "splice" | "passage" = "splice") =>
    request<KeptRender>(`/api/v1/renders/${encodeURIComponent(id)}/chunks/${index}/edit`, { method: "POST", body: json({ text, mode }) }),
  lockPassage: (id: string, index: number, locked: boolean) =>
    request<KeptRender>(`/api/v1/renders/${encodeURIComponent(id)}/chunks/${index}/lock`, { method: "POST", body: json({ locked }) }),
  regenerateUnlocked: (id: string) => request<KeptRender>(`/api/v1/renders/${encodeURIComponent(id)}/regenerate`, { method: "POST", body: json({}) }),
  keptSubtitles: (id: string, format: "srt" | "vtt") => request<string>(`/api/v1/renders/${encodeURIComponent(id)}/subtitles`, {}, { format }),
  subtitles: (words: WordTime[], format: "srt" | "vtt") => request<string>("/api/v1/subtitles", { method: "POST", body: json({ words, format }) }),

  jobAudioUrl: (id: string, download = false) => withToken(url(`/api/v1/jobs/${encodeURIComponent(id)}/audio`, { download: download ? "true" : undefined })),
  jobFileUrl: (id: string, name: string) => withToken(url(`/api/v1/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`)),
  jobFile: <T = unknown>(id: string, name: string) => request<T>(`/api/v1/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`),
  jobEventsUrl: (since?: number) => withToken(url("/api/v1/jobs/events", { since })),
  jobEventUrl: (id: string) => withToken(url(`/api/v1/jobs/${encodeURIComponent(id)}/events`)),
};

/** Fetch a server file with the auth header (for saving to disk or reading locally). */
export async function fetchBlob(u: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(u, { headers: authHeaders(), signal });
  if (!res.ok) throw await parseError(res);
  return res.blob();
}

/** Make a file name safe for the save dialog. */
export function safeFileName(name: string, fallback = "firevoice"): string {
  return name.replace(/[^\w\-. ]+/g, "").trim().slice(0, 80) || fallback;
}

/** Fetch a server file with the auth header and save it through the save dialog. False when cancelled. */
export async function downloadFile(u: string, suggestedName: string): Promise<boolean> {
  const blob = await fetchBlob(u);
  return saveBlob(blob, suggestedName);
}

/** Subscribe to the global job event stream. Returns an unsubscribe function. Reconnects with `since`. */
export function subscribeJobEvents(onEvent: (e: JobEvent) => void, onState?: (open: boolean) => void): () => void {
  let es: EventSource | null = null;
  let since: number | undefined;
  let closed = false;
  let retry = 1000;

  const open = () => {
    if (closed) return;
    try {
      es = new EventSource(api.jobEventsUrl(since));
    } catch {
      es = null;
      onState?.(false);
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 15000);
      return;
    }
    es.onopen = () => {
      retry = 1000;
      onState?.(true);
    };
    const handle = (ev: MessageEvent) => {
      try {
        const e = JSON.parse(ev.data) as JobEvent;
        if (typeof e.seq === "number") since = e.seq;
        if (e.job) onEvent(e);
      } catch {
        /* ping or malformed */
      }
    };
    es.onmessage = handle;
    for (const t of ["progress", "queued", "running", "done", "failed", "cancelled", "created", "deleted", "update"]) {
      es.addEventListener(t, handle as EventListener);
    }
    es.onerror = () => {
      onState?.(false);
      es?.close();
      es = null;
      if (!closed) {
        setTimeout(open, retry);
        retry = Math.min(retry * 2, 15000);
      }
    };
  };
  open();
  return () => {
    closed = true;
    es?.close();
  };
}
