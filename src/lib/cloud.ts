import { useQuery, useQueryClient } from "@tanstack/react-query";
import { inTauri } from "@/lib/backend";

/** FireVoice cloud, through the desktop shell (src-tauri/src/cloud.rs): usage sharing, the account, feedback and the
 * licence. The window never holds the account's token; it asks the shell. Outside the desktop app these do nothing. */

export interface CloudUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl?: string | null;
  verified: boolean;
  google?: boolean;
  createdAt: string;
}

export interface LoginEvent {
  state: "approved" | "denied" | "expired" | "error";
  message: string | null;
  status: CloudStatus;
}

export interface CloudStatus {
  /** null until the person answers the first-launch question */
  consent: boolean | null;
  registered: boolean;
  installId: string | null;
  signedIn: boolean;
  user: CloudUser | null;
  server: string;
  queued: number;
  installs?: number;
}

export interface License {
  licensing: boolean;
  plan: "free" | "pro" | "team";
  status?: "active" | "none";
  offline?: boolean;
  license?: { last4: string; plan: string; expiresAt: string | null; seats: number } | null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const cloud = {
  status: () => call<CloudStatus>("cloud_status"),
  me: () => call<CloudStatus>("cloud_me"),
  consent: (on: boolean) => call<CloudStatus>("cloud_consent", { on }),
  erase: () => call<CloudStatus>("cloud_erase"),
  /** Signing in happens in the browser: this returns the code to compare, and a "cloud-login" event says how it ended. */
  loginStart: () => call<{ code: string; url: string; expiresIn: number }>("cloud_login_start"),
  loginCancel: () => call<void>("cloud_login_cancel"),
  signOut: () => call<CloudStatus>("cloud_sign_out"),
  /** Opens the website's account, privacy or sign-up page in the browser. */
  open: (page: "account" | "privacy" | "signup") => call<void>("cloud_open", { page }),
  feedback: (f: { kind: "bug" | "idea" | "praise" | "other"; message: string; email?: string; rating?: number | null }) =>
    call<void>("cloud_feedback", { kind: f.kind, message: f.message, email: f.email || null, rating: f.rating ?? null }),
  license: () => call<License>("cloud_license"),
  activate: (key: string) => call<License>("cloud_activate", { key }),
};

export const CLOUD_KEY = ["cloud"] as const;

/** The cloud status (and the account, refreshed from the server when the page asks for it). */
export function useCloud(fresh = false) {
  return useQuery({
    queryKey: [...CLOUD_KEY, fresh ? "fresh" : "local"],
    queryFn: fresh ? cloud.me : cloud.status,
    enabled: inTauri(),
    staleTime: fresh ? 30_000 : 5_000,
    retry: false,
  });
}

/** After a change: every view of the status shows the new one. */
export function useSetCloud() {
  const qc = useQueryClient();
  return (s: CloudStatus) => {
    qc.setQueryData([...CLOUD_KEY, "local"], s);
    qc.setQueryData([...CLOUD_KEY, "fresh"], (old: CloudStatus | undefined) => ({ ...s, installs: old?.installs }));
  };
}

/** Counts something the app did, for usage statistics (sent only with sharing on; never content). */
export function track(name: string, props?: Record<string, string | number | boolean | null>) {
  if (!inTauri()) return;
  void call("cloud_track", { name, props: props ?? null }).catch(() => {});
}

/** Reports an error the window hit (sent only with sharing on). */
export function reportError(message: string, stack?: string) {
  if (!inTauri()) return;
  void call("cloud_error", { message: message.slice(0, 1900), stack: stack?.slice(0, 19_000) ?? null }).catch(() => {});
}

/** What only the window knows about the computer: language, time zone, screen and graphics card. */
export function hello(gpu?: string | null) {
  if (!inTauri()) return;
  const dpr = window.devicePixelRatio || 1;
  void call("cloud_hello", {
    info: {
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      screen: `${Math.round(screen.width * dpr)}x${Math.round(screen.height * dpr)}`,
      ...(gpu ? { gpu } : {}),
    },
  }).catch(() => {});
}

const ID_LIKE = /\d|%|^[a-f0-9-]{16,}$/i;

/** A feature used through the engine's API (any change: making speech, loading an engine, saving a voice...), named by
 * its route without ids ("use.tts", "use.engines.load"), with the engine and text length when the request says. */
export function trackUse(path: string, method: string, body: unknown) {
  if (!inTauri() || method === "GET") return;
  const parts = path
    .split("?")[0]
    .replace(/^\/api\/v1\//, "")
    .split("/")
    .filter((p) => p && !ID_LIKE.test(p))
    .slice(0, 3)
    .map((p) => p.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
  if (!parts.length) return;
  const props: Record<string, string | number> = { method: method.toLowerCase() };
  if (typeof body === "string" && body.startsWith("{")) {
    try {
      const b = JSON.parse(body) as Record<string, unknown>;
      if (typeof b.engine === "string") props.engine = b.engine.slice(0, 40);
      if (typeof b.text === "string") props.chars = b.text.length;
      if (typeof b.language === "string") props.language = b.language.slice(0, 12);
    } catch {
      /* not JSON */
    }
  }
  track(`use.${parts.join(".")}`, props);
}
