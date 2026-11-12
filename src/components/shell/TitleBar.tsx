import { useEffect, useState } from "react";
import { inTauri } from "@/lib/backend";
import { cn } from "@/lib/utils";

/** The window's own controls: FireVoice draws its title bar (the system one is turned off, tauri.conf.json). The bar
 * moves the window when dragged and maximizes it on a double click; close does what the system button did (with
 * dictation kept running it goes to the tray). Only in the desktop app. */
export function TitleBar({ overlay, scrolled }: { overlay?: boolean; scrolled?: boolean } = {}) {
  const [max, setMax] = useState(false);
  const [focused, setFocused] = useState(true);

  useEffect(() => {
    if (!inTauri()) return;
    let gone = false;
    const offs: (() => void)[] = [];
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const w = getCurrentWindow();
      const sync = async () => !gone && setMax(await w.isMaximized());
      await sync();
      offs.push(await w.onResized(() => void sync()));
      offs.push(await w.onFocusChanged(({ payload }) => !gone && setFocused(payload)));
    })();
    return () => {
      gone = true;
      offs.forEach((off) => off());
    };
  }, []);

  if (!inTauri()) return null;
  const act = async (what: "min" | "max" | "close") => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (what === "min") await w.minimize();
    else if (what === "max") await w.toggleMaximize();
    else await w.close();
  };

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "z-30 flex h-9 shrink-0 items-stretch justify-end select-none",
        // over the page: frosted glass, so what scrolls under it blurs away instead of being cut off; a hairline and
        // a little more frost once something is underneath
        overlay ? "titlebar-glass absolute inset-x-0 top-0" : "relative",
        overlay && scrolled && "is-scrolled",
      )}
    >
      <div className={cn("flex", !focused && "opacity-60")}>
      <Control label="Minimize" onClick={() => void act("min")}>
        <path d="M2 6h8" />
      </Control>
      <Control label={max ? "Restore" : "Maximize"} onClick={() => void act("max")}>
        {max ? (
          <>
            <rect x="2" y="3.5" width="6.5" height="6.5" rx="1.2" />
            <path d="M4 3.5V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-.5" />
          </>
        ) : (
          <rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1.4" />
        )}
      </Control>
      <Control label="Close" danger onClick={() => void act("close")}>
        <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
      </Control>
      </div>
    </div>
  );
}

function Control({ label, danger, onClick, children }: { label: string; danger?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid w-[46px] place-items-center text-muted outline-none transition-[color,background,opacity] duration-100 focus-visible:bg-surface-3",
        danger ? "hover:bg-[#e5373a] hover:text-white active:bg-[#c42b2e]" : "hover:bg-surface-3 hover:text-ink active:bg-line-strong",
      )}
    >
      <svg viewBox="0 0 12 12" className="size-[11px]" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
