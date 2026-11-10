import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";

/**
 * Page state that outlives the page: what you typed, picked, uploaded or got back stays put when you switch screens
 * and come back, for as long as the app is open (finished results are also kept on disk, in History).
 *
 *   const [script, setScript] = useSessionState("dialogue.script", "");
 *
 * The setter works after the page has closed too, so a render that finishes while you are elsewhere is waiting
 * when you return.
 */
interface SessionStore {
  values: Record<string, unknown>;
}

const useSession = create<SessionStore>(() => ({ values: {} }));

type Setter<T> = (next: T | ((prev: T) => T)) => void;

/** Read a session value outside React (async code, event handlers). */
export function getSession<T>(key: string, fallback: T): T {
  const v = useSession.getState().values;
  return (key in v ? v[key] : fallback) as T;
}

/** Write a session value outside React. */
export function setSession<T>(key: string, next: T | ((prev: T) => T), fallback: T): void {
  useSession.setState((s) => {
    const prev = (key in s.values ? s.values[key] : fallback) as T;
    const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
    return { values: { ...s.values, [key]: value } };
  });
}

export function useSessionState<T>(key: string, initial: T | (() => T)): [T, Setter<T>] {
  // the first value is computed once per key; later mounts read what is stored
  const [first] = useState<T>(() => (typeof initial === "function" ? (initial as () => T)() : initial));
  const stored = useSession((s) => (key in s.values ? (s.values[key] as T) : undefined));
  const has = useSession((s) => key in s.values);
  const value = has ? (stored as T) : first;
  const set = useCallback<Setter<T>>((next) => setSession(key, next, first), [key, first]);
  return [value, set];
}

/** Release a blob: URL when a newer one replaces it. Unlike a cleanup on unmount, this keeps a preview that lives in
 * session state playable after leaving the page and coming back. */
export function useReleaseOnReplace(url: string | null | undefined) {
  const last = useRef(url);
  useEffect(() => {
    const prev = last.current;
    if (prev && prev !== url && prev.startsWith("blob:")) URL.revokeObjectURL(prev);
    last.current = url;
  }, [url]);
}
