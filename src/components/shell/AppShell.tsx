import { Suspense, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router";
import { Toaster } from "sonner";
import { useSettings, applyTheme } from "@/stores/settings";
import { useJobFeed } from "@/lib/api/hooks";
import { TooltipProvider } from "@/components/ui";
import { inTauri } from "@/lib/backend";
import { cn } from "@/lib/utils";
import { Sidebar } from "./Sidebar";
import { PlayerBar } from "./PlayerBar";
import { OfflineBanner } from "./OfflineBanner";
import { BackendManager } from "./BackendManager";
import { FinishSetupBanner } from "./FinishSetupBanner";
import { BackgroundSetup } from "./BackgroundSetup";
import { usePlayer } from "@/stores/player";
import { useStagger } from "@/lib/stagger";
import { TitleBar } from "./TitleBar";
import { Tour } from "@/components/tour/Tour";
import { ConsentDialog } from "@/components/cloud/ConsentDialog";
import { hello, reportError, track } from "@/lib/cloud";
import { useSystem } from "@/lib/api/hooks";

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

  // the corner cards (update, setup) sit above the player bar while it shows
  useEffect(() => {
    document.documentElement.style.setProperty("--fv-corner-bottom", hasTrack ? "112px" : "20px");
    return () => void document.documentElement.style.removeProperty("--fv-corner-bottom");
  }, [hasTrack]);

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
  // usage statistics: which page was opened (its name only), and the computer details only the window knows
  useEffect(() => track("page.view", { route: `/${pageKey === "home" ? "" : pageKey}` }), [pageKey]);
  const gpu = useSystem().data?.gpu?.name;
  useEffect(() => hello(gpu), [gpu]);
  // errors in the window are reported like crashes (with sharing on)
  useEffect(() => {
    const onError = (e: ErrorEvent) => reportError(e.message || "error", e.error instanceof Error ? e.error.stack : undefined);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      // a failed request is already shown to the person; only real faults are reported
      if (r && typeof r === "object" && "status" in r) return;
      reportError(r instanceof Error ? r.message : String(r), r instanceof Error ? r.stack : undefined);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  // the title bar floats over the page: once the page has scrolled under it, it frosts a little more
  const [scrolled, setScrolled] = useState(false);

  return (
    <TooltipProvider>
      <div className="ambient relative flex h-full w-full overflow-hidden">
        <Sidebar />
        {/* content column: the player floats over it, never over the sidebar */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <TitleBar overlay scrolled={scrolled} />
          <main
            ref={mainRef}
            id="main"
            onScroll={(e) => {
              const s = e.currentTarget.scrollTop > 2;
              if (s !== scrolled) setScrolled(s);
            }}
            className={cn("main-scroll relative min-h-0 flex-1 overflow-y-auto px-8 pb-6 transition-[padding] duration-300", inTauri() ? "pt-12" : "pt-7")}
            style={{ paddingBottom: hasTrack ? 116 : 28 }}
          >
            <FinishSetupBanner />
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
        {/* torch and the voice libraries still installing after the first run, and engines installing */}
        <BackgroundSetup />
        <Tour />
        <ConsentDialog />

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
