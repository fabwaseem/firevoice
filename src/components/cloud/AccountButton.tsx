import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { CircleUser, Loader2, X } from "@/components/icons";
import { Button } from "@/components/ui";
import { inTauri } from "@/lib/backend";
import { cloud, useCloud, useSetCloud, type LoginEvent } from "@/lib/cloud";
import { cn } from "@/lib/utils";

/** The person button in the title bar. Signed out: signs in through the browser (the code shown here must match the
 * one on the site). Signed in: their initial, opening the Account page.
 *
 * The title bar is also drawn on the screens before the app's router exists (starting, first run, updating the
 * engine), so this must not use router hooks: useNavigate there throws and blanks the whole window. The app routes by
 * the address's hash (createHashRouter), so setting it opens the Account page from anywhere. */
export function AccountButton() {
  const status = useCloud();
  const set = useSetCloud();
  const [pending, setPending] = useState<{ code: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // how the sign-in in the browser ended
  useEffect(() => {
    if (!inTauri()) return;
    let off: (() => void) | undefined;
    let gone = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<LoginEvent>("cloud-login", ({ payload }) => {
        set(payload.status);
        setPending(null);
        if (payload.state === "approved") toast.success(`Signed in as ${payload.status.user?.email ?? "you"}`);
        else if (payload.state === "denied") toast("Sign-in declined in the browser");
        else toast.error(payload.message ?? "Sign-in did not finish");
      }).then((u) => (gone ? u() : (off = u))),
    );
    return () => {
      gone = true;
      off?.();
    };
  }, [set]);

  // the waiting panel closes on Escape
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!inTauri() || !status.data) return null;
  const s = status.data;

  const start = async () => {
    setStarting(true);
    try {
      setPending(await cloud.loginStart());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setStarting(false);
    }
  };
  const cancel = () => {
    void cloud.loginCancel();
    setPending(null);
  };

  if (s.signedIn && s.user) {
    const u = s.user;
    return (
      <button
        type="button"
        onClick={() => (window.location.hash = "#/account")}
        title={`Account: ${u.email}`}
        aria-label={`Account: ${u.email}`}
        className="mx-1.5 my-auto grid size-[26px] place-items-center overflow-hidden rounded-full bg-gradient-to-br from-fire-2 to-fire text-[12px] font-semibold text-white ring-2 ring-transparent outline-none transition hover:ring-fire/30 focus-visible:ring-fire/50"
      >
        {u.avatarUrl ? <img src={u.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-full object-cover" /> : (u.name || u.email).slice(0, 1).toUpperCase()}
      </button>
    );
  }

  return (
    <div className="relative flex items-stretch">
      <button
        type="button"
        onClick={() => (pending ? cancel() : void start())}
        disabled={starting}
        aria-label="Sign in"
        title="Sign in"
        aria-expanded={!!pending}
        className={cn(
          "grid w-[42px] place-items-center text-muted outline-none transition-colors duration-100 hover:bg-surface-3 hover:text-ink focus-visible:bg-surface-3",
          pending && "text-fire",
        )}
      >
        {starting ? <Loader2 className="size-[15px] animate-spin" /> : <CircleUser className="size-[16px]" />}
      </button>
      {pending && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Finish signing in"
          className="surface-raised absolute top-[calc(100%+6px)] right-0 z-50 w-[300px] rounded-2xl p-4 shadow-lg data-[state=open]:animate-[fade-up_0.2s_ease-out]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="text-[14px] font-semibold text-ink">Finish in your browser</div>
            <button type="button" onClick={cancel} aria-label="Cancel sign-in" className="-m-1 rounded-md p-1 text-faint hover:text-ink">
              <X className="size-4" />
            </button>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">
            Sign in on the page that opened (with email or Google), then approve. Check it shows this code:
          </p>
          <div className="mt-3 rounded-xl bg-surface-2 py-2.5 text-center font-mono text-[20px] font-semibold tracking-[0.18em] text-ink">{pending.code}</div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-[12px] text-faint">
              <Loader2 className="size-3.5 animate-spin" /> Waiting…
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" onClick={() => void cloud.open("signup")}>
                Create account
              </Button>
              <Button size="sm" variant="outline" onClick={() => void start()}>
                Open again
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
