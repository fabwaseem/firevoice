import { Monitor, Moon, Sun } from "@/components/icons";
import { Card, CardBody, CardHeader, Label, Segmented, Select, Switch } from "@/components/ui";
import { useSettings, type Settings, type Theme } from "@/stores/settings";

const FORMATS: Settings["format"][] = ["mp3", "wav", "flac", "ogg", "opus", "m4a"];

export function AppearanceSection() {
  const theme = useSettings((s) => s.theme);
  const setTheme = useSettings((s) => s.setTheme);
  const collapsed = useSettings((s) => s.sidebarCollapsed);
  const set = useSettings((s) => s.set);
  return (
    <Card>
      <CardHeader title="Appearance" />
      <CardBody className="space-y-5">
        <div>
          <Label>Theme</Label>
          <Segmented<Theme>
            ariaLabel="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: "System", icon: <Monitor className="size-3.5" /> },
              { value: "light", label: "Light", icon: <Sun className="size-3.5" /> },
              { value: "dark", label: "Dark", icon: <Moon className="size-3.5" /> },
            ]}
          />
        </div>
        <Switch checked={collapsed} onChange={(v) => set({ sidebarCollapsed: v })} label="Compact sidebar" description="Icons only, labels on hover." />
      </CardBody>
    </Card>
  );
}

export function RenderingSection() {
  const format = useSettings((s) => s.format);
  const autoPlay = useSettings((s) => s.autoPlay);
  const advanced = useSettings((s) => s.showAdvanced);
  const set = useSettings((s) => s.set);
  return (
    <Card>
      <CardHeader title="Rendering defaults" description="Starting points for new renders in Speak." />
      <CardBody className="space-y-5">
        <div className="flex items-center justify-between gap-6">
          <div>
            <span className="block text-[13px] font-medium text-ink">Output format</span>
            <span className="block text-[12px] text-muted">Saved files and downloads.</span>
          </div>
          <Select
            ariaLabel="Output format"
            value={format}
            onChange={(v) => set({ format: v as Settings["format"] })}
            className="w-32"
            size="sm"
            options={FORMATS.map((f) => ({ value: f, label: f.toUpperCase() }))}
          />
        </div>
        <Switch checked={autoPlay} onChange={(v) => set({ autoPlay: v })} label="Auto-play finished renders" />
        <Switch checked={advanced} onChange={(v) => set({ showAdvanced: v })} label="Open Quality and Output in Speak" description="Show these sections of Speak's settings expanded instead of folded away." />
      </CardBody>
    </Card>
  );
}
