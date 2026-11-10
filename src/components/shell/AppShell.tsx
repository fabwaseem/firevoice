import { Suspense, useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";
import { Toaster } from "sonner";
import { useSettings, applyTheme } from "@/stores/settings";
import { useJobFeed } from "@/lib/api/hooks";
import { TooltipProvider } from "@/components/ui";
import { Sidebar } from "./Sidebar";
import { PlayerBar } from "./PlayerBar";
import { OfflineBanner } from "./OfflineBanner";
import { BackendManager } from "./BackendManager";
import { usePlayer } from "@/stores/player";
import { useStagger } from "@/lib/stagger";
import { useDictationBridge } from "@/components/dictation/useDictationBridge";

export function AppShell() {
  const theme = useSettings((s) => s.theme);
  const hasTrack = usePlayer((s) => !!s.track);

  useEffect(() => {
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => theme === "system" && applyTheme(theme);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  useJobFeed();
  useDictationBridge();

  // Each view starts at the top; the scroll container is <main>, not the window.
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // each page eases in part by part (cards, rows, tiles), including content that loads after it opens
  const pageKey = pathname.split("/")[1] || "home";
  const pageRef = useRef<HTMLDivElement>(null);
  useStagger(pageRef, pageKey);
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <TooltipProvider>
      <div className="ambient relative flex h-full w-full overflow-hidden">
        <Sidebar />
        {/* content column: the player floats over it, never over the sidebar */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <main
            ref={mainRef}
            id="main"
            className="main-scroll relative min-h-0 flex-1 overflow-y-auto px-8 pt-7 pb-6 transition-[padding] duration-300"
            style={{ paddingBottom: hasTrack ? 116 : 28 }}
          >
            <BackendManager />
            <OfflineBanner />
            <Suspense fallback={<PageLoading />}>
              {/* keyed by page: each page (and its sections, staggered) eases in when opened */}
              <div key={pageKey} ref={pageRef} className="page-enter">
                <Outlet />
              </div>
            </Suspense>
          </main>
          <PlayerBar />
        </div>
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

/** Shown for the moment a page's code loads the first time it opens. */
function PageLoading() {
  return (
    <div className="mx-auto max-w-[1000px] animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="mb-2 h-8 w-48 rounded-lg bg-surface-3" />
      <div className="mb-6 h-4 w-80 rounded bg-surface-3/70" />
      <div className="h-64 rounded-xl bg-surface-3/50" />
    </div>
  );
}
