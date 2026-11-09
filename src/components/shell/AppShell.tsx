import { useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { Toaster } from "sonner";
import { useSettings, applyTheme } from "@/stores/settings";
import { useJobFeed } from "@/lib/api/hooks";
import { TooltipProvider } from "@/components/ui";
import { Sidebar } from "./Sidebar";
import { PlayerBar } from "./PlayerBar";
import { OfflineBanner } from "./OfflineBanner";
import { usePlayer } from "@/stores/player";

export function AppShell() {
  const theme = useSettings((s) => s.theme);
  const hasTrack = usePlayer((s) => !!s.track);
  const [, setFeedOpen] = useState(true);

  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => theme === "system" && applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  useJobFeed(setFeedOpen);

  // Each view starts at the top; the scroll container is <main>, not the window.
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <TooltipProvider>
      <div className="ambient relative flex h-full w-full overflow-hidden">
        <Sidebar />
        <main
          ref={mainRef}
          id="main"
          className="relative min-w-0 flex-1 overflow-y-auto px-6 pt-6 pb-6 transition-[padding] duration-300"
          style={{ paddingBottom: hasTrack ? 112 : 24 }}
        >
          <OfflineBanner />
          <Outlet />
        </main>
        <PlayerBar />
        <Toaster
          position="top-right"
          offset={16}
          toastOptions={{
            classNames: {
              toast: "!surface-raised !rounded-xl !text-ink !text-[13px] !font-medium",
              description: "!text-muted",
            },
          }}
        />
      </div>
    </TooltipProvider>
  );
}
