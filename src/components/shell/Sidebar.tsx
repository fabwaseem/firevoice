import { useState, type ComponentType } from "react";
import { Link, NavLink, useLocation, useMatch, useResolvedPath } from "react-router";
import {
  AudioLines,
  BookA,
  BookOpen,
  ChevronRight,
  Cpu,
  History,
  Home,
  Languages,
  Library,
  ListChecks,
  MessagesSquare,
  Mic,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Repeat2,
  Settings,
  Wrench,
  Waves,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { FEATURES_VERSION, useDictation, useDictationLive } from "@/stores/dictation";
import { useHealth, useSystem } from "@/lib/api/hooks";
import { Tooltip } from "@/components/ui";
import { ServerStatus } from "./ServerStatus";
import { UpdatePill } from "./UpdateGate";
import { Logo } from "./Logo";

type Item = { to: string; label: string; icon: ComponentType<{ className?: string; strokeWidth?: number }>; end?: boolean; badge?: "jobs" };

// a few short lists, each a kind of work; Dictation, the everyday feature, has its own place above them
const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: "Create",
    items: [
      { to: "/speak", label: "Speak", icon: AudioLines },
      { to: "/projects", label: "Projects", icon: BookOpen },
      { to: "/dialogue", label: "Dialogue", icon: MessagesSquare },
      { to: "/dub", label: "Dubbing", icon: Languages },
    ],
  },
  {
    title: "Audio",
    items: [
      { to: "/changer", label: "Voice changer", icon: Repeat2 },
      { to: "/sound", label: "Sound", icon: Waves },
      { to: "/transcribe", label: "Transcribe", icon: Mic },
      { to: "/tools", label: "Tools", icon: Wrench },
    ],
  },
  {
    title: "Library",
    items: [
      { to: "/voices", label: "Voices", icon: Library },
      { to: "/styles", label: "Styles", icon: Palette },
      { to: "/dictionary", label: "Dictionary", icon: BookA },
      { to: "/history", label: "History", icon: History },
    ],
  },
];

GROUPS.push({
  title: "System",
  items: [
    { to: "/jobs", label: "Jobs", icon: ListChecks, badge: "jobs" },
    { to: "/engines", label: "Engines", icon: Cpu },
    { to: "/settings", label: "Settings", icon: Settings },
  ],
});

/** Jobs queued or running right now, for the badge on Jobs. */
function useActiveJobs(): number {
  const online = useHealth().isSuccess;
  const jobs = useSystem(online).data?.jobs;
  return (jobs?.running ?? 0) + (jobs?.queued ?? 0);
}

function NavItem({ item, collapsed, count, fresh }: { item: Item; collapsed: boolean; count?: number; fresh?: boolean }) {
  const Icon = item.icon;
  // the active state is worked out here, not through NavLink's className function: the tooltip's trigger
  // (Radix Slot) merges className as a string, which turned that function into text in compact mode
  const resolved = useResolvedPath(item.to);
  const isActive = !!useMatch({ path: resolved.pathname, end: item.end ?? false });
  return (
    <Tooltip content={item.label} side="right" disabled={!collapsed}>
      <Link
        to={item.to}
        data-tour={`nav-${item.to}`}
        aria-label={collapsed ? item.label : undefined}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "group relative flex h-9 shrink-0 items-center rounded-[10px] text-[13.5px] font-medium outline-none transition-[background,color] duration-150",
          collapsed ? "mx-auto w-10 justify-center" : "gap-3 px-3",
          isActive ? "bg-fire-soft text-fire" : "text-muted hover:bg-surface-3/70 hover:text-ink",
          "focus-visible:ring-2 focus-visible:ring-fire/50",
        )}
      >
        <Icon className="size-[18px] shrink-0 transition-transform duration-150 group-active:scale-90" strokeWidth={isActive ? 2.2 : 1.85} />
        {!collapsed && <span className="truncate">{item.label}</span>}
        {fresh && !count && (
          <span
            className={cn(
              "rounded-full fire-gradient font-semibold text-white",
              collapsed ? "absolute top-0.5 right-0.5 size-2" : "ml-auto px-1.5 py-px text-[10px] tracking-wide uppercase",
            )}
            aria-label="New features"
          >
            {!collapsed && "New"}
          </span>
        )}
        {!!count && (
          <span
            className={cn(
              "flex items-center justify-center rounded-full bg-fire font-semibold text-white tabular",
              collapsed ? "absolute -top-0.5 -right-0.5 size-4 text-[9.5px]" : "ml-auto h-[18px] min-w-[18px] px-1 text-[10.5px]",
            )}
            aria-label={`${count} active`}
          >
            {count}
          </span>
        )}
      </Link>
    </Tooltip>
  );
}

/** Dictation, FireVoice's everyday feature: a nav item like the others, highlighted so it stands out; a quiet dot
 * while it is listening. */
function DictationFeature({ collapsed }: { collapsed: boolean }) {
  const resolved = useResolvedPath("/dictation");
  const isActive = !!useMatch({ path: resolved.pathname, end: false });
  const fresh = useDictation((s) => s.config.featuresVisited < FEATURES_VERSION);
  const phase = useDictationLive((s) => s.phase);
  const live = phase === "starting" || phase === "listening" || phase === "finishing";

  return (
    <Tooltip content={live ? "Dictation: listening" : "Dictation"} side="right" disabled={!collapsed}>
      <Link
        to="/dictation"
        data-tour="nav-/dictation"
        aria-label={collapsed ? "Dictation" : undefined}
        aria-current={isActive ? "page" : undefined}
        className={cn(
          "group relative flex h-10 shrink-0 items-center rounded-[11px] text-[13.5px] font-semibold outline-none transition-[background,box-shadow,color] duration-150 focus-visible:ring-2 focus-visible:ring-fire/50",
          collapsed ? "mx-auto w-10 justify-center" : "gap-2.5 pr-3 pl-1.5",
          isActive
            ? "fire-gradient text-white shadow-[0_8px_20px_-10px_rgba(255,90,45,0.9)]"
            : "bg-[linear-gradient(135deg,rgba(255,156,94,0.14),rgba(255,90,45,0.05))] text-ink ring-1 ring-fire/15 hover:ring-fire/35",
        )}
      >
        <span
          className={cn(
            "relative grid size-7 shrink-0 place-items-center rounded-[8px] transition-colors",
            isActive ? "bg-white/20 text-white" : "fire-gradient text-white shadow-[0_4px_10px_-4px_rgba(255,90,45,0.8)]",
          )}
        >
          <Mic className="size-[15px]" strokeWidth={2.3} />
        </span>
        {!collapsed && <span className="truncate">Dictation</span>}
        {live ? (
          <span className={cn("flex size-2 rounded-full", isActive ? "bg-white" : "bg-fire", collapsed ? "absolute top-1 right-1" : "ml-auto")} aria-label="Listening">
            <span className={cn("size-2 animate-ping rounded-full", isActive ? "bg-white" : "bg-fire")} />
          </span>
        ) : (
          fresh && (
            <span
              className={cn(
                "rounded-full font-semibold",
                isActive ? "bg-white/25 text-white" : "fire-gradient text-white",
                collapsed ? "absolute top-0.5 right-0.5 size-2" : "ml-auto px-1.5 py-px text-[9.5px] tracking-wide uppercase",
              )}
              aria-label="New features"
            >
              {!collapsed && "New"}
            </span>
          )
        )}
      </Link>
    </Tooltip>
  );
}

const FOLD_KEY = "firevoice.sidebar.folded";

function useFolded(): [Record<string, boolean>, (title: string) => void] {
  const [folded, setFolded] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(FOLD_KEY) ?? "{}") ?? {};
    } catch {
      return {};
    }
  });
  const toggle = (title: string) =>
    setFolded((f) => {
      const next = { ...f, [title]: !f[title] };
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(next));
      } catch {
        /* not remembered */
      }
      return next;
    });
  return [folded, toggle];
}

/** A section of the sidebar that folds: open by default, the user's choice remembered, and never folded over the page
 * that is shown. Folded, it shows how many jobs are running when it holds Jobs. */
function Group({ g, collapsed, folded, onToggle, activeJobs }: { g: (typeof GROUPS)[number]; collapsed: boolean; folded: boolean; onToggle: () => void; activeJobs: number }) {
  const { pathname } = useLocation();
  const here = g.items.some((i) => pathname === i.to || pathname.startsWith(i.to + "/"));
  const open = !folded || here;
  const jobs = g.items.some((i) => i.badge === "jobs") ? activeJobs : 0;
  if (collapsed) {
    return (
      <div className="mt-4">
        <div className="mx-auto mb-2 h-px w-6 bg-line" aria-hidden />
        <div className="flex flex-col gap-0.5">
          {g.items.map((it) => (
            <NavItem key={it.to} item={it} collapsed count={it.badge === "jobs" ? activeJobs : undefined} />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group/h mb-1 flex w-full items-center gap-1 rounded-[8px] px-3 py-0.5 text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase transition-colors hover:text-muted"
      >
        {g.title}
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {!open && jobs > 0 && (
          <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-fire px-1 text-[9.5px] font-semibold tracking-normal text-white tabular" aria-label={`${jobs} jobs running`}>
            {jobs}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-0.5">
          {g.items.map((it) => (
            <NavItem key={it.to} item={it} collapsed={false} count={it.badge === "jobs" ? activeJobs : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const set = useSettings((s) => s.set);
  const activeJobs = useActiveJobs();
  const [folded, fold] = useFolded();
  const toggle = () => set({ sidebarCollapsed: !collapsed });

  return (
    <aside
      className={cn(
        "relative z-20 flex h-full shrink-0 flex-col border-r border-line bg-bg-elev/80 backdrop-blur-xl transition-[width] duration-200 ease-[var(--ease-out-quart)]",
        collapsed ? "w-[68px]" : "w-[232px]",
      )}
      aria-label="Primary"
    >
      {/* brand + collapse */}
      <div data-tauri-drag-region className={cn("flex h-16 shrink-0 items-center", collapsed ? "justify-center" : "justify-between pr-2.5 pl-4")}>
        {collapsed ? (
          // compact: the logo is the button that opens the sidebar; pointing at it (or focusing it) shows the open icon
          <Tooltip content="Expand sidebar" side="right">
            <button
              type="button"
              onClick={toggle}
              aria-label="Expand sidebar"
              className="group relative flex size-10 items-center justify-center rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-fire/50"
            >
              <Logo
                size={30}
                className="shrink-0 drop-shadow-[0_4px_12px_rgba(255,90,45,0.35)] transition-opacity duration-150 group-hover:opacity-0 group-focus-visible:opacity-0"
              />
              <span
                className="absolute inset-0 flex items-center justify-center rounded-[10px] bg-surface-3/70 text-ink opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-hidden
              >
                <PanelLeftOpen className="size-[18px]" />
              </span>
            </button>
          </Tooltip>
        ) : (
          <NavLink to="/" className="flex items-center gap-2.5 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-fire/50" aria-label="FireVoice home">
            <Logo size={30} className="shrink-0 drop-shadow-[0_4px_12px_rgba(255,90,45,0.35)]" />
            <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">FireVoice</span>
          </NavLink>
        )}
        {!collapsed && (
          <Tooltip content="Collapse sidebar" side="right">
            <button
              type="button"
              onClick={toggle}
              aria-label="Collapse sidebar"
              className="flex size-8 items-center justify-center rounded-[9px] text-faint transition-colors hover:bg-surface-3/70 hover:text-ink"
            >
              <PanelLeftClose className="size-[17px]" />
            </button>
          </Tooltip>
        )}
      </div>

      {/* views: scrolls when the window is short */}
      <nav
        className={cn("sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-1 pb-3", collapsed ? "no-scrollbar px-0" : "px-2.5")}
        aria-label="Views"
      >
        <div className="flex flex-col gap-2">
          <NavItem item={{ to: "/", label: "Home", icon: Home, end: true }} collapsed={collapsed} />
          <DictationFeature collapsed={collapsed} />
        </div>
        {GROUPS.map((g) => (
          <Group key={g.title} g={g} collapsed={collapsed} folded={!!folded[g.title]} onToggle={() => fold(g.title)} activeJobs={activeJobs} />
        ))}
      </nav>

      {/* updates and the engine's state */}
      <div className={cn("shrink-0 border-t border-line pt-2.5 pb-3", collapsed ? "px-2 space-y-1.5" : "px-2.5 space-y-2.5")}>
        <UpdatePill collapsed={collapsed} />
        <ServerStatus compact={collapsed} />
      </div>
    </aside>
  );
}
