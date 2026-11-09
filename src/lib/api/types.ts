/** Types mirroring docs/API.md. Keep field names identical to the server JSON. */

export type ParamType = "float" | "int" | "bool" | "str" | "enum" | "vector";

export interface EngineParam {
  name: string;
  type: ParamType;
  default: unknown;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  choices?: string[] | null;
  length?: number | null;
  labels?: string[] | null;
  label?: string;
  help?: string;
}

export interface Engine {
  name: string;
  title: string;
  license?: string;
  commercial?: boolean;
  clone: boolean;
  needs_reference: boolean;
  needs_transcript: boolean;
  design: boolean;
  instruct: boolean;
  tags: boolean;
  presets: string[];
  languages: string[];
  sample_rate: number;
  vram_gb?: number | null;
  speed_rtf?: number | null;
  notes?: string;
  description?: string;
  default?: boolean;
  default_workers?: number;
  venv?: string | null;
  weights?: string | null;
  venv_ok?: boolean;
  weights_ok?: boolean;
  ready: boolean;
  problems: string[];
  loaded: boolean;
  workers?: number;
  active_requests?: number;
  params: EngineParam[];
}

export interface Style {
  name: string;
  title: string;
  description: string;
  pace: number;
  pause: number;
  temperature: number;
  top_p: number;
  repetition_penalty: number;
  cfg: number;
  exaggeration: number;
  cfg_weight: number;
  instruct: string;
  desc: string;
  emo_vector: number[];
  emo_alpha: number;
  tags: string[];
  sample: string;
  extra: Record<string, unknown>;
  builtin: boolean;
}

export interface Voice {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  gender?: string;
  language: string;
  accent?: string;
  age?: string;
  tags?: string[];
  source?: string;
  license?: string;
  ref_seconds?: number;
  created?: number;
  has_ref?: boolean;
  styles?: string[];
  design_prompt?: string;
  favorite?: boolean;
  notes?: string;
  kind: "cloned" | "designed";
  default: boolean;
  transcript?: string;
  /** branding: one-line description, character traits, what it suits, listening-test tier */
  tagline?: string;
  traits?: string[];
  use_cases?: string[];
  quality?: VoiceQuality;
  featured?: boolean;
  /** a rendered "Hi, I'm …" introduction exists (GET /voices/{id}/preview) */
  has_preview?: boolean;
}

export interface VoiceQuality {
  tier: "S" | "A" | "B" | "C";
  rank: number;
  of: number;
  naturalness?: number | null;
}

export interface VoiceCollection {
  id: string;
  title: string;
  description: string;
  voices: string[];
}

export type AudioFormat = "wav" | "mp3" | "flac" | "ogg" | "opus" | "m4a" | "pcm16";

export interface TTSRequest {
  text: string;
  engine?: string | null;
  voice?: string;
  style?: string;
  pace?: number;
  seed?: number;
  language?: string | null;
  instruct?: string | null;
  params?: Record<string, unknown>;
  style_overrides?: Record<string, unknown>;
  lufs?: number | null;
  candidates?: number;
  accept?: number;
  validate?: boolean;
  lead_ms?: number;
  tail_ms?: number;
  format?: AudioFormat;
  sample_rate?: number | null;
  response?: "audio" | "json";
  /** extra pronunciation rules for this request only */
  dictionary?: DictRuleInput[] | Record<string, string> | null;
  /** keep every take of every passage (see /api/v1/renders) */
  keep_takes?: boolean;
}

// ---------------------------------------------------------------- pronunciation dictionary
export interface DictRuleInput {
  match: string;
  say: string;
  case?: boolean;
  whole_word?: boolean;
  note?: string;
}
export interface DictRule extends Required<DictRuleInput> {
  id: string;
  created: number;
}
export interface DictView {
  rules: DictRule[];
  builtin: { match: string; say: string }[];
}

// ---------------------------------------------------------------- kept renders (takes and QA)
export interface QAWord {
  text: string;
  status: "ok" | "missed" | "changed";
  heard?: string;
}
export interface RenderTake {
  n: number;
  seed: number;
  score: number;
  validated: boolean;
  reasons: string[];
  said: string;
  duration: number;
  words: WordTime[];
  qa: { words: QAWord[]; extra: string[]; match: number } | null;
}
export interface RenderChunk {
  index: number;
  text: string;
  style: string;
  pace: number;
  takes: RenderTake[];
  chosen: number | null;
  locked: boolean;
  flagged: boolean;
}
export interface KeptRender {
  id: string;
  created: number;
  title: string;
  engine: string;
  sample_rate: number;
  chunks: RenderChunk[];
  flagged: number;
}

export interface WordTime {
  text: string;
  start: number;
  end: number;
}

export interface TTSJson {
  audio_base64: string;
  format: string;
  engine: string;
  voice: string;
  style: string;
  duration: number;
  sample_rate: number;
  seconds: number;
  rtf: number;
  chunks: number;
  takes: number;
  retries: number;
  warnings: string[];
  words: WordTime[];
  render_id?: string | null;
}

export interface StreamChunk {
  type: "chunk";
  index: number;
  total: number;
  start: number;
  sample_rate: number;
  format: string;
  audio_base64: string;
  words: WordTime[];
  text: string;
  /** a piece of a passage that is still rendering (real streaming); more pieces of the same index follow */
  partial?: boolean;
}
export interface StreamDone {
  type: "done";
  duration?: number;
  seconds?: number;
  rtf?: number;
  warnings?: string[];
  [k: string]: unknown;
}
export interface StreamError {
  type: "error";
  code?: string;
  message: string;
}
export type StreamEvent = StreamChunk | StreamDone | StreamError | { type: string; [k: string]: unknown };

export interface STTResult {
  text: string;
  language: string;
  language_probability: number;
  duration: number;
  seconds: number;
  model: string;
  device: string;
  words: WordTime[];
}

export type JobKind = "tts" | "batch" | "design" | "previews";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  progress: number;
  step?: number | null;
  steps?: number | null;
  message?: string | null;
  error?: { code?: string; message?: string } | string | null;
  result?: Record<string, unknown> | null;
  created: number;
  started?: number | null;
  finished?: number | null;
  elapsed?: number | null;
  payload?: Record<string, unknown>;
}

export interface JobEvent {
  seq: number;
  type: string;
  time: number;
  job: Job;
}

export interface GPUInfo {
  name?: string;
  vram_total_gb?: number;
  vram_used_gb?: number;
  vram_free_gb?: number;
  utilization?: number;
  temperature_c?: number;
  [k: string]: unknown;
}

export interface SystemInfo {
  version: string;
  uptime_seconds: number;
  home: string;
  voices_dir: string;
  default_engine: string;
  loaded_engines: string[];
  gpu: GPUInfo | null;
  asr: { model: string; loaded: boolean };
  jobs: Record<string, number>;
  voices: number;
  styles: number;
}

export interface Options {
  engines: Engine[];
  styles: Style[];
  formats: string[];
  defaults: Omit<TTSRequest, "text"> & { format: AudioFormat };
  default_engine: string;
  voice_count: number;
  languages: string[];
}

export interface Health {
  ok: boolean;
  version: string;
  auth: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}
