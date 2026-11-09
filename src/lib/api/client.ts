import { useSettings } from "@/stores/settings";
import type {
  ApiErrorBody, Engine, Health, Job, JobEvent, JobKind, Options, Style, STTResult, SystemInfo, TTSJson, TTSRequest,
  Voice, VoiceCollection, StreamEvent, DictRule, DictRuleInput, DictView, KeptRender, WordTime,
  Project, ProjectSummary, ChapterEdit, AudiobookCheck,
} from "./types";

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
  return useSettings.getState().serverUrl;
}

function authHeaders(): Record<string, string> {
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
  const u = new URL(path, base() + "/");
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

async function request<T>(path: string, init: RequestInit = {}, query?: Record<string, string | number | boolean | null | undefined>): Promise<T> {
  const headers: Record<string, string> = { ...authHeaders(), ...((init.headers as Record<string, string>) ?? {}) };
  if (init.body && typeof init.body === "string" && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(url(path, query), { ...init, headers });
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

const json = (body: unknown) => JSON.stringify(body);

// ------------------------------------------------------------------ system
export const api = {
  health: () => request<Health>("/health"),
  system: () => request<SystemInfo>("/api/v1/system"),
  options: () => request<Options>("/api/v1/options"),

  // ---------------------------------------------------------------- engines
  engines: async () => (await request<{ engines: Engine[] }>("/api/v1/engines")).engines,
  engine: (name: string) => request<Engine>(`/api/v1/engines/${encodeURIComponent(name)}`),
  loadEngine: (name: string, workers?: number) =>
    request<Engine>(`/api/v1/engines/${encodeURIComponent(name)}/load`, { method: "POST", body: json(workers ? { workers } : {}) }),
  unloadEngine: (name: string) => request<Engine>(`/api/v1/engines/${encodeURIComponent(name)}/unload`, { method: "POST" }),

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
  stt: async (file: Blob, opts: { language?: string; beam_size?: number; filename?: string } = {}, signal?: AbortSignal) => {
    const fd = new FormData();
    fd.append("file", file, opts.filename ?? (file instanceof File ? file.name : "recording.webm"));
    fd.append("language", opts.language ?? "auto");
    if (opts.beam_size) fd.append("beam_size", String(opts.beam_size));
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

/** Subscribe to the global job event stream. Returns an unsubscribe function. Reconnects with `since`. */
export function subscribeJobEvents(onEvent: (e: JobEvent) => void, onState?: (open: boolean) => void): () => void {
  let es: EventSource | null = null;
  let since: number | undefined;
  let closed = false;
  let retry = 1000;

  const open = () => {
    if (closed) return;
    es = new EventSource(api.jobEventsUrl(since));
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
