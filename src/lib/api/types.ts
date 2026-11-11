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

/** Measured axes behind an engine's FireVoice name. */
export interface EngineTier {
  quality: "Studio" | "Pro" | "Standard" | "-";
  size: "XS" | "S" | "M" | "L" | "XL" | "-";
  speed: "Instant" | "Fast" | "Real-time" | "Slow" | "-";
  params: string | null;
  rtf: number | null;
  vram_gb: number | null;
}

export interface Engine {
  name: string;
  /** The FireVoice name ("Inferno"); the model behind it is `model`. */
  title: string;
  brand?: string | null;
  model?: string;
  tagline?: string;
  tier?: EngineTier | null;
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
  /** The backend can build this engine's venv and fetch its weights itself (POST /engines/{name}/install). */
  installable?: boolean;
  /** tts (speech), sfx (sound effects and music) or vc (voice changer) */
  task?: "tts" | "sfx" | "vc" | "tool";
}

export interface InstallStep {
  step: "venv" | "code" | "torch" | "packages" | "weights" | "check";
  what: string;
  done: boolean;
  gb?: number | null;
}

export interface InstallPlan {
  engine: string;
  auto: boolean;
  manual: string | null;
  notes: string;
  venv: string | null;
  venv_state: "missing" | "building" | "outdated" | "ok" | null;
  /** Runs code from the model's own repository (a pinned git checkout or trust_remote_code). */
  repo_code?: boolean;
  installed: boolean;
  steps: InstallStep[];
  estimated_gb: number | null;
  uv: string | null;
  engines_dir: string;
  weights_dir: string;
}

export interface PathEntry {
  path: string | null;
  source: string;
  exists: boolean;
}

export interface PathsReport {
  home: PathEntry;
  engines_dir: PathEntry;
  weights_dir: PathEntry;
  ffmpeg: PathEntry;
  package: { path: string; checkout: string | null };
  settings_file: string;
  settings: Partial<Record<PathSettingKey, string>>;
  watermark?: { policy: "all" | "off"; available: boolean };
}

export interface EnginePick {
  engine: string;
  title: string;
  reason: string;
  ready: boolean;
  installable: boolean;
  vram_gb?: number | null;
  model?: string | null;
  tier?: EngineTier | null;
  /** estimated seconds to make one second of speech on this computer (below 1 is faster than real time) */
  est_rtf?: number | null;
}

/** What this computer can run (from the server): the card, its memory, the system memory and the free disk space. */
export interface Hardware {
  gpu: string | null;
  vram_gb: number | null;
  vram_free_gb: number | null;
  speed: number | null;
  ram_gb: number | null;
  cpu_cores: number | null;
  disk_free_gb: number | null;
  disk_path: string;
}

/** The ready-made voice library: how much of it this computer has, and whether it can be downloaded. */
export interface VoiceLibraryStatus {
  version: number;
  count: number;
  present: number;
  missing: number;
  installed: boolean;
  bytes: number | null;
  available: boolean;
}

export interface SetupReport {
  gpu: GPUInfo | null;
  vram_gb: number | null;
  hardware: Hardware;
  library: VoiceLibraryStatus;
  recommended: EnginePick;
  alternatives: EnginePick[];
  ffmpeg: string | null;
  voices: number;
  ready_engines: string[];
  problems: string[];
}

export type PathSettingKey = "engines_dir" | "weights_dir" | "ffmpeg" | "watermark";

export interface DubLine {
  start: number;
  end: number;
  text: string;
  translation: string;
  speaker: string | null;
  voice: string;
  speed: number;
  at: number;
  duration: number;
}

export interface QualityReport {
  duration: number;
  mos: { overall: number; signal: number; background: number; p808: number } | null;
  similarity: { value: number; backend: "wavlm" | "resemblyzer"; same_speaker: boolean } | null;
  drift: {
    windows: { start: number; end: number; similarity?: number; f0: number | null; level_db: number }[];
    flags: { start: number; end: number; why: string[] }[];
    backend: string;
    min_similarity?: number;
    spread?: number;
    pitch_hz?: number | null;
    compared_with?: string;
  };
  verdict: "good" | "check";
  notes: string[];
  voice: string | null;
  render_id?: string;
}

export interface WatermarkResult {
  watermarked: boolean;
  probability: number;
  firevoice: boolean;
  kind: "render" | "convert" | null;
  bits: string | null;
  seconds: number;
}

export interface ConsentRecord {
  voice_id: string;
  /** "consent" when a record was kept; otherwise what the voice's use rests on */
  basis: string;
  given: boolean | null;
  by?: string | null;
  via?: string;
  time?: string;
  statement?: string;
  clip_unchanged?: boolean | null;
  clip_note?: string | null;
  license?: string | null;
  source?: string | null;
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
  quality_check?: { before: ClipCheck; after: ClipCheck | null; cleaned: string | null } | null;
  /** avatar version (modification time); null when the voice has no avatar */
  avatar?: number | null;
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

// ---------------------------------------------------------------- audio tools
export interface ClipCheck {
  duration: number;
  peak_db?: number;
  clipped_pct?: number;
  speech_db?: number;
  noise_db?: number;
  snr_db?: number;
  silence_pct?: number;
  verdict: "good" | "fair" | "poor";
  notes: string[];
}
export interface DesignBatch {
  batch: string;
  description: string;
  text: string;
  engine: string;
  candidates: { n: number; seed: number; duration: number }[];
}

// ---------------------------------------------------------------- dialogue
export interface DialogueTurn { speaker: string; voice?: string; text: string; start: number; end: number }
export interface DialogueParse { turns: { speaker: string; text: string }[]; speakers: string[]; cast: Record<string, { voice?: string; style?: string }> }
export interface DialogueResult {
  audio_base64: string;
  format: string;
  duration: number;
  sample_rate: number;
  turns: DialogueTurn[];
  words: (WordTime & { speaker: string })[];
  cast: Record<string, { voice?: string; style?: string }>;
}

// ---------------------------------------------------------------- projects
export type ParagraphStatus = "draft" | "rendered" | "stale" | "locked";
export interface Paragraph {
  id: string;
  text: string;
  voice?: string | null;
  style?: string | null;
  pace?: number | null;
  locked: boolean;
  status: ParagraphStatus;
  render: { id: string; key: string; duration: number; at: number } | null;
}
export interface Chapter {
  id: string;
  title: string;
  paragraphs: Paragraph[];
  counts: Record<ParagraphStatus, number>;
  duration: number;
}
export interface Project {
  id: string;
  title: string;
  created: number;
  updated: number;
  defaults: Record<string, unknown> & { voice?: string; style?: string; paragraph_gap_ms?: number; chapter_gap_ms?: number };
  chapters: Chapter[];
  counts: Record<ParagraphStatus, number>;
  duration: number;
  paragraphs: number;
  words: number;
}
export interface ProjectSummary {
  id: string;
  title: string;
  created: number;
  updated: number;
  counts: Record<ParagraphStatus, number>;
  duration: number;
  paragraphs: number;
  words: number;
  chapters: number;
}
export interface ChapterEdit {
  id?: string;
  title: string;
  paragraphs: { id?: string; text: string; voice?: string | null; style?: string | null; pace?: number | null; locked?: boolean }[];
}
export interface AudiobookCheck {
  master: string | null;
  pass: boolean;
  chapters: { chapter: string; title: string; pass: boolean; note?: string; checks: { name: string; value: number; unit: string; target: string; ok: boolean }[] }[];
}

// ---------------------------------------------------------------- kept renders (takes and QA)
export interface QAWord {
  text: string;
  status: "ok" | "missed" | "changed";
  heard?: string;
}
export interface RenderTake {
  /** The text this take says (set once the passage was edited) */
  text?: string;
  /** How this take came from a word edit */
  edit?: { mode: "splice" | "passage"; from_take: number; old_text: string; changed_words?: number[]; cuts_s?: number[]; note?: string };
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
  words: (WordTime & { speaker?: string; roman?: string })[];
  /** Urdu transcripts also in English letters (Roman Urdu) */
  text_roman?: string;
  segments?: { start: number; end: number; text: string; speaker?: string }[];
}

export type JobKind = "tts" | "batch" | "design" | "previews" | "project" | "style_refs" | "dialogue" | "install" | "dub" | "voices";
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
  /** engine id -> FireVoice name */
  engine_names?: Record<string, string>;
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
  /** engine id -> FireVoice name */
  engine_names?: Record<string, string>;
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
  /** HTTP contract version; the app checks it against the range it supports. Missing on servers older than 1.1. */
  api_version?: number;
  /** The oldest client contract this server still serves. */
  min_client_api?: number;
  auth: boolean;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

/** Everything made, kept until deleted. Speech items (kind "speech") are kept renders. */
export type HistoryKind = "speech" | "sound" | "music" | "changer" | "dialogue" | "transcript" | "separate" | "clean";

export interface HistoryFile {
  file?: string;
  type: "audio" | "json" | "text";
  duration?: number;
}

export interface HistoryItem {
  id: string;
  kind: HistoryKind;
  /** "render" for speech: its audio and deletion go through /api/v1/renders */
  source?: "render";
  title: string;
  created: number;
  duration?: number | null;
  sample_rate?: number | null;
  files: Record<string, HistoryFile>;
  meta: Record<string, unknown>;
}

/** One ranked row on the Stats screen (an engine, voice, style or language). */
export interface StatRow {
  key: string;
  name?: string;
  count: number;
  audio_s: number;
  speed: number | null;
}

export type StatGroup = "speech" | "dialogue" | "sound" | "changer" | "dub" | "transcript" | "tools";

export interface Stats {
  range: { days: number; since: number | null; until: number };
  totals: {
    operations: number; done: number; failed: number; cancelled: number; success_rate: number;
    speech_renders: number; audio_made_s: number; speech_s: number; chars: number; words_spoken: number;
    transcripts: number; transcribed_s: number; words_transcribed: number; sounds: number; music: number; music_s: number;
    voice_changes: number; dialogues: number; dubs: number; separations: number; cleanups: number;
    voices_added: number; voices_designed: number; gpu_s: number; speed: number | null; takes: number; retries: number; sentences: number;
  };
  by_kind: { kind: string; count: number; audio_s: number }[];
  engines: StatRow[]; engines_used: number;
  voices: StatRow[]; voices_used: number;
  styles: StatRow[]; styles_used: number;
  languages: StatRow[]; languages_used: number;
  daily: ({ date: string; count: number } & Record<StatGroup, number>)[];
  groups: StatGroup[];
  heatmap: number[][];
  records: {
    first_use: number | null; active_days: number; streak: number; longest_streak: number;
    busiest_day: { date: string; count: number } | null; longest_speech_s: number | null; fastest_speed: number | null;
    all_time_audio_s: number; all_time_operations: number;
  };
  errors: { message: string; count: number }[];
  library: {
    voices: number; cloned: number; designed: number; favorites: number; voice_languages: number; styles: number; custom_styles: number;
    projects: number; chapters: number; paragraphs: number; project_words: number; dictionary_rules: number; history_items: number;
    kept_renders: number; jobs: number; engines_ready: number; engines_total: number; tools_ready: number;
  };
  storage: { folders: Record<string, number>; data_total: number; home: string };
}
