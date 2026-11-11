import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { useHealth } from "@/lib/api/hooks";
import { inTauri } from "@/lib/backend";
import { dictation, onDictation, type DictationResultEvent, type DictationStateEvent, type DictationTextEvent } from "@/lib/dictation";
import { useDictation, useDictationLive } from "@/stores/dictation";
import { useSettings } from "@/stores/settings";

/**
 * Keeps the desktop shell and the app in step for dictation, for as long as the app runs (mounted once, in the
 * shell): the settings go to the shell whenever they change, the speech model is loaded ahead of the first use, and
 * what the shell reports (state, live text, finished dictations) lands in the stores the pages read.
 */
export function useDictationBridge() {
  const config = useDictation((s) => s.config);
  const server = useSettings((s) => s.serverUrl);
  const token = useSettings((s) => s.token);
  const online = useHealth().isSuccess;
  const qc = useQueryClient();

  // settings -> shell (also registers the hotkey)
  useEffect(() => {
    if (!inTauri()) return;
    let stale = false;
    dictation
      .configure(config, server, token)
      .then((s) => !stale && useDictationLive.getState().set({ hotkeyError: s.hotkey_error }))
      .catch((e) => console.error("dictation: configure failed", e));
    return () => {
      stale = true;
    };
  }, [config, server, token]);

  // the speech model, loaded before it is needed: the first dictation then starts at once
  useEffect(() => {
    if (!config.enabled || !online) return;
    const c = new AbortController();
    fetch(`${server}/api/v1/dictate/warm`, { method: "POST", signal: c.signal, headers: token ? { Authorization: `Bearer ${token}` } : undefined }).catch(
      () => {},
    );
    return () => c.abort();
  }, [config.enabled, online, server, token]);

  // the writing assistant, loaded before the first polished dictation (only when it is installed and wanted)
  const wantsAssistant = config.enabled && online && ((config.polish && config.mode === "onstop") || !!config.commandHotkey);
  useEffect(() => {
    if (!wantsAssistant) return;
    let gone = false;
    api
      .dictationAssistant()
      .then((s) => (!gone && s.installed && !s.loaded ? api.loadAssistant() : null))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [wantsAssistant]);

  // shell -> stores
  useEffect(() => {
    if (!inTauri()) return;
    const live = useDictationLive.getState();
    const subs = [
      onDictation<DictationStateEvent>("dictation", (e) => {
        live.set(e.state === "starting" ? { phase: e.state, message: null, text: "", tentative: "" } : { phase: e.state, message: e.message });
      }),
      onDictation<DictationTextEvent>("dictation-text", (e) => live.set({ text: e.text, tentative: e.tentative })),
      onDictation<DictationResultEvent>("dictation-result", (e) => {
        useDictation.getState().add({ text: e.text.trim(), seconds: e.seconds, language: e.language, mode: e.mode });
        void qc.invalidateQueries({ queryKey: ["dictation-history"] });
      }),
    ];
    return () => {
      for (const s of subs) s.then((off) => off()).catch(() => {});
    };
  }, [qc]);
}
