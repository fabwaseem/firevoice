import { useEffect, useState } from "react";
import { inTauri } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { MotionIcon } from "@/vendor/motion-icons/MotionIcon";
import { windowClose, windowMaximize, windowMinimize, windowRestore } from "@/vendor/motion-icons";
import type { IconDef } from "@/vendor/motion-icons/types";
import { AccountButton } from "@/components/cloud/AccountButton";
import { isMac } from "@/lib/platform";

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
      {/* sign in (through the browser), or the account when signed in */}
      <AccountButton />
      {/* macOS has its own window buttons (top left, drawn by the system) */}
      {!isMac && <div className={cn("flex", !focused && "opacity-60")}>
      {/* the kit's window controls: minimize bends into an arrow, maximize opens into corners, restore folds into
          one, close turns a quarter */}
      <Control label="Minimize" icon={windowMinimize} onClick={() => void act("min")} />
      <Control label={max ? "Restore" : "Maximize"} icon={max ? windowRestore : windowMaximize} onClick={() => void act("max")} />
      <Control label="Close" icon={windowClose} danger corner={!max} onClick={() => void act("close")} />
      </div>}
    </div>
  );
}

function Control({ label, icon, danger, corner, onClick }: { label: string; icon: IconDef; danger?: boolean; corner?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "grid w-[46px] place-items-center text-muted outline-none transition-[color,background,opacity] duration-100 focus-visible:bg-surface-3",
        danger ? "hover:bg-[#e5373a] hover:text-white active:bg-[#c42b2e]" : "hover:bg-surface-3 hover:text-ink active:bg-line-strong",
        // the window's own rounded corner (Windows 11: 8 px), so the red never pokes out of it; square when maximized
        corner && "rounded-tr-[8px]",
      )}
    >
      <MotionIcon icon={icon} size={12} />
    </button>
  );
}
