/** Dictation (Tauri only): the desktop shell listens for the hotkey, reads the microphone and types the text
 * (src-tauri/src/dictation.rs). This is the web side's view of it: commands, events and key names. */
import type { DictationConfig, DictationPhase } from "@/stores/dictation";

export interface DictationStatus {
  enabled: boolean;
  hotkey: string;
  hotkey_error: string | null;
  active: boolean;
}

export interface DictationStateEvent {
  state: DictationPhase;
  message: string | null;
  mode: string;
}
export interface DictationTextEvent {
  text: string;
  tentative: string;
}
export interface DictationResultEvent {
  text: string;
  seconds: number;
  language: string | null;
  mode: string;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** The languages this computer is set up for (Windows' language list), as base codes: ["en", "ur"]. */
export function systemLanguages(): string[] {
  const out: string[] = [];
  for (const l of typeof navigator !== "undefined" ? (navigator.languages ?? [navigator.language]) : []) {
    const c = String(l).split("-")[0].toLowerCase();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export const dictation = {
  configure: (config: DictationConfig, server: string, token: string) =>
    call<DictationStatus>("dictation_configure", {
      config: {
        enabled: config.enabled,
        hotkey: config.hotkey,
        activation: config.activation,
        mode: config.mode,
        language: config.language,
        insert: config.insert,
        commands: config.commands,
        fillers: config.fillers,
        keyterms: config.keyterms,
        mic: config.mic,
        keep_in_tray: config.keepInTray,
        wake: config.wake,
        boost_quiet: config.boostQuiet,
        history: config.history,
        command_hotkey: config.commandHotkey,
        // the first-dictation guide, until one dictation has gone in
        spotlight: !config.spotlightDone,
        // passed on to the server as they are
        // the computer's own language list: a hint for automatic language when no languages are listed
        extra: { polish: config.polish, styles: config.styles, languages: config.languages, language_hints: systemLanguages(), translate_to: config.translateTo || null },
        server,
        token,
      },
    }),
  toggle: () => call<void>("dictation_toggle"),
  cancel: () => call<void>("dictation_cancel"),
  mics: () => call<string[]>("dictation_mics"),
};

/** Listen to one of the shell's dictation events; -> a function that stops listening. */
export async function onDictation<T>(event: "dictation" | "dictation-level" | "dictation-text" | "dictation-result" | "spotlight", fn: (payload: T) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<T>(event, (e) => fn(e.payload));
}

const MODIFIER_CODES = new Set(["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

/** The combination a key press describes, in the form the shell registers ("Ctrl+Alt+Space"), or null while only
 * modifier keys are down. A plain letter or digit alone is refused (it would swallow ordinary typing). */
export function hotkeyFromEvent(e: KeyboardEvent): { hotkey: string | null; reason?: string } {
  if (MODIFIER_CODES.has(e.code) || !e.code) return { hotkey: null };
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
  const functionKey = /^F([1-9]|1\d|2[0-4])$/.test(e.code);
  if (!mods.length && !functionKey) return { hotkey: null, reason: "Add Ctrl, Alt or Shift, or use a function key." };
  if (mods.length === 1 && mods[0] === "Shift" && !functionKey) return { hotkey: null, reason: "Shift alone is not enough: add Ctrl or Alt." };
  return { hotkey: [...mods, e.code].join("+") };
}

/** "Ctrl+Alt+KeyD" -> ["Ctrl", "Alt", "D"], for showing a hotkey as key caps. */
export function hotkeyLabels(hotkey: string): string[] {
  return hotkey
    .split("+")
    .filter(Boolean)
    .map((k) =>
      k
        .replace(/^Key([A-Z])$/, "$1")
        .replace(/^Digit(\d)$/, "$1")
        .replace(/^Super$/, "Win")
        .replace(/^Arrow/, "")
        .replace(/^Numpad/, "Num "),
    );
}
