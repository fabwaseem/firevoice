import { NavLink } from "react-router";
import { AudioLines, Home, Library, ListChecks, Mic, Palette, Cpu, Settings, PanelLeftClose, PanelLeftOpen, Moon, Sun, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSettings } from "@/stores/settings";
import { Tooltip } from "@/components/ui";
import { ServerStatus } from "./ServerStatus";
import { Logo } from "./Logo";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/speak", label: "Speak", icon: AudioLines },
  { to: "/voices", label: "Voices", icon: Library },
  { to: "/transcribe", label: "Transcribe", icon: Mic },
  { to: "/jobs", label: "Jobs", icon: ListChecks },
  { to: "/engines", label: "Engines", icon: Cpu },
  { to: "/styles", label: "Styles", icon: Palette },
] as const;

export function Sidebar() {
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const theme = useSettings((s) => s.theme);
  const set = useSettings((s) => s.set);
  const setTheme = useSettings((s) => s.setTheme);

  const nextTheme = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col transition-[width] duration-200 ease-[var(--ease-out-quart)]",
        collapsed ? "w-[76px]" : "w-[108px]",
      )}
      aria-label="Primary"
    >
      <div className="flex flex-col items-center px-3 pt-5 pb-3">
        <Logo size={collapsed ? 34 : 40} />
        {!collapsed && <span className="mt-2 text-[10.5px] font-bold tracking-[0.22em] text-muted uppercase">FireVoice</span>}
      </div>

      <nav className="flex flex-1 flex-col items-stretch gap-1 px-3 py-2" aria-label="Views">
        {NAV.map(({ to, label, icon: Icon, ...rest }) => (
          <Tooltip key={to} content={label} side="right" disabled={!collapsed}>
            <NavLink
              to={to}
              end={"end" in rest ? rest.end : false}
              className={({ isActive }) =>
                cn(
                  "group relative flex flex-col items-center justify-center gap-1 rounded-xl py-2.5 text-[11.5px] font-medium transition-[background,color]",
                  isActive ? "bg-surface text-fire shadow-sm" : "text-muted hover:bg-surface/60 hover:text-ink",
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon className={cn("size-[21px] transition-transform group-active:scale-90", isActive && "drop-shadow-[0_2px_6px_rgba(255,90,45,0.35)]")} strokeWidth={isActive ? 2.2 : 1.9} />
                  {!collapsed && <span>{label}</span>}
                </>
              )}
            </NavLink>
          </Tooltip>
        ))}
      </nav>

      <div className="flex flex-col items-stretch gap-1 px-3 pb-4">
        <Tooltip content="Settings" side="right" disabled={!collapsed}>
          <NavLink
            to="/settings"
            className={({ isActive }) =>
              cn(
                "flex flex-col items-center justify-center gap-1 rounded-xl py-2.5 text-[11.5px] font-medium transition-[background,color]",
                isActive ? "bg-surface text-fire shadow-sm" : "text-muted hover:bg-surface/60 hover:text-ink",
              )
            }
          >
            <Settings className="size-[21px]" strokeWidth={1.9} />
            {!collapsed && <span>Settings</span>}
          </NavLink>
        </Tooltip>

        <div className="mt-2 flex items-center justify-center gap-1">
          <Tooltip content={`Theme: ${theme}`} side="right">
            <button
              type="button"
              onClick={() => setTheme(nextTheme)}
              aria-label={`Theme: ${theme}. Switch theme`}
              className="flex size-8 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              <ThemeIcon className="size-4" />
            </button>
          </Tooltip>
          <Tooltip content={collapsed ? "Expand sidebar" : "Collapse sidebar"} side="right">
            <button
              type="button"
              onClick={() => set({ sidebarCollapsed: !collapsed })}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex size-8 items-center justify-center rounded-[10px] text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            </button>
          </Tooltip>
        </div>
        <ServerStatus compact={collapsed} />
      </div>
    </aside>
  );
}
