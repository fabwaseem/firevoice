import type { ComponentType } from "react";
import { Link, NavLink, useMatch, useResolvedPath } from "react-router";
import {
  AudioLines,
  BarChart3,
  BookA,
  BookOpen,
  Cpu,
  History,
  Home,
  Languages,
  Library,
  ListChecks,
  MessagesSquare,
  Mic,
  Monitor,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Repeat2,
  Settings,
  Wrench,
  Sun,
  Waves,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings, type Theme } from "@/stores/settings";
import { useHealth, useSystem } from "@/lib/api/hooks";
import { Tooltip } from "@/components/ui";
import { ServerStatus } from "./ServerStatus";
import { Logo } from "./Logo";

type Item = { to: string; label: string; icon: ComponentType<{ className?: string; strokeWidth?: number }>; end?: boolean; badge?: "jobs" };

const GROUPS: { title?: string; items: Item[] }[] = [
  { items: [{ to: "/", label: "Home", icon: Home, end: true }] },
  {
    title: "Create",
    items: [
      { to: "/speak", label: "Speak", icon: AudioLines },
      { to: "/projects", label: "Projects", icon: BookOpen },
      { to: "/dialogue", label: "Dialogue", icon: MessagesSquare },
      { to: "/changer", label: "Voice changer", icon: Repeat2 },
      { to: "/dub", label: "Dubbing", icon: Languages },
      { to: "/sound", label: "Sound", icon: Waves },
      { to: "/transcribe", label: "Transcribe", icon: Mic },
      { to: "/tools", label: "Tools", icon: Wrench },
    ],
  },
  {
    title: "Library",
    items: [
      { to: "/history", label: "History", icon: History },
      { to: "/voices", label: "Voices", icon: Library },
      { to: "/styles", label: "Styles", icon: Palette },
      { to: "/dictionary", label: "Dictionary", icon: BookA },
    ],
  },
  {
    title: "Manage",
    items: [
      { to: "/jobs", label: "Jobs", icon: ListChecks, badge: "jobs" },
      { to: "/engines", label: "Engines", icon: Cpu },
      { to: "/stats", label: "Stats", icon: BarChart3 },
    ],
  },
];

const THEMES: { value: Theme; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/** Jobs queued or running right now, for the badge on Jobs. */
function useActiveJobs(): number {
  const online = useHealth().isSuccess;
  const jobs = useSystem(online).data?.jobs;
  return (jobs?.running ?? 0) + (jobs?.queued ?? 0);
}

function NavItem({ item, collapsed, count }: { item: Item; collapsed: boolean; count?: number }) {
  const Icon = item.icon;
  // the active state is worked out here, not through NavLink's className function: the tooltip's trigger
  // (Radix Slot) merges className as a string, which turned that function into text in compact mode
  const resolved = useResolvedPath(item.to);
  const isActive = !!useMatch({ path: resolved.pathname, end: item.end ?? false });
  return (
    <Tooltip content={item.label} side="right" disabled={!collapsed}>
      <Link
        to={item.to}
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

function ThemeSwitch({ collapsed }: { collapsed: boolean }) {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  if (collapsed) {
    const i = THEMES.findIndex((t) => t.value === theme);
    const cur = THEMES[i] ?? THEMES[2];
    const next = THEMES[(i + 1) % THEMES.length];
    const Icon = cur.icon;
    return (
      <Tooltip content={`Theme: ${cur.label}`} side="right">
        <button
          type="button"
          onClick={() => setTheme(next.value)}
          aria-label={`Theme: ${cur.label}. Switch to ${next.label}`}
          className="mx-auto flex size-10 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-surface-3/70 hover:text-ink"
        >
          <Icon className="size-[18px]" />
        </button>
      </Tooltip>
    );
  }
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-0.5 rounded-[10px] bg-surface-3/70 p-0.5">
      {THEMES.map((t) => {
        const on = t.value === theme;
        const Icon = t.icon;
        return (
          <Tooltip key={t.value} content={t.label} side="top">
            <button
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={t.label}
              onClick={() => setTheme(t.value)}
              className={cn(
                "flex h-7 items-center justify-center rounded-[8px] transition-[background,color,box-shadow]",
                on ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
              )}
            >
              <Icon className="size-[15px]" />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function Sidebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const set = useSettings((s) => s.set);
  const activeJobs = useActiveJobs();
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
      <div className={cn("flex h-16 shrink-0 items-center", collapsed ? "justify-center" : "justify-between pr-2.5 pl-4")}>
        <NavLink to="/" className="flex items-center gap-2.5 rounded-[10px] outline-none focus-visible:ring-2 focus-visible:ring-fire/50" aria-label="FireVoice home">
          <Logo size={30} className="shrink-0 drop-shadow-[0_4px_12px_rgba(255,90,45,0.35)]" />
          {!collapsed && <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">FireVoice</span>}
        </NavLink>
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
      {collapsed && (
        <Tooltip content="Expand sidebar" side="right">
          <button
            type="button"
            onClick={toggle}
            aria-label="Expand sidebar"
            className="mx-auto mb-1 flex size-10 shrink-0 items-center justify-center rounded-[10px] text-faint transition-colors hover:bg-surface-3/70 hover:text-ink"
          >
            <PanelLeftOpen className="size-[18px]" />
          </button>
        </Tooltip>
      )}

      {/* views: scrolls when the window is short */}
      <nav
        className={cn("sidebar-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden pt-1 pb-3", collapsed ? "no-scrollbar px-0" : "px-2.5")}
        aria-label="Views"
      >
        {GROUPS.map((g, gi) => (
          <div key={gi} className={cn(gi > 0 && "mt-4")}>
            {g.title &&
              (collapsed ? (
                <div className="mx-auto mb-2 h-px w-6 bg-line" aria-hidden />
              ) : (
                <div className="mb-1 px-3 text-[10.5px] font-semibold tracking-[0.12em] text-faint uppercase">{g.title}</div>
              ))}
            <div className="flex flex-col gap-0.5">
              {g.items.map((it) => (
                <NavItem key={it.to} item={it} collapsed={collapsed} count={it.badge === "jobs" ? activeJobs : undefined} />
              ))}
            </div>
          </div>
        ))}
      </nav>

      {/* settings, theme, connection */}
      <div className={cn("shrink-0 border-t border-line pt-2.5 pb-3", collapsed ? "px-2 space-y-1.5" : "px-2.5 space-y-2.5")}>
        <NavItem item={{ to: "/settings", label: "Settings", icon: Settings }} collapsed={collapsed} />
        <ThemeSwitch collapsed={collapsed} />
        <ServerStatus compact={collapsed} />
      </div>
    </aside>
  );
}
