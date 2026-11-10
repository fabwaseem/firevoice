import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import type { PathSettingKey } from "@/lib/api/types";
import { usePaths, useSaveSettings } from "@/lib/api/hooks";
import { Button, Card, CardBody, CardHeader, Input, Label, Skeleton, Switch } from "@/components/ui";

const FIELDS: { key: Exclude<PathSettingKey, "watermark">; label: string; hint: string }[] = [
  { key: "engines_dir", label: "Engine folder", hint: "Installed engines (about 5 GB each)" },
  { key: "weights_dir", label: "Voice models", hint: "Downloaded voice models (3 to 8 GB each)" },
  { key: "ffmpeg", label: "Audio converter (ffmpeg)", hint: "Where ffmpeg.exe is on this computer" },
];

/** Where a folder setting comes from, in plain words. */
function sourceLabel(source: string, exists: boolean): string {
  const s = source === "default" ? "Default" : source === "settings" ? "Your choice" : source === "env" || source === "environment" ? "Set outside the app" : source ? source.charAt(0).toUpperCase() + source.slice(1) : "";
  return exists ? s : `${s}${s ? ", " : ""}not found`;
}

/** Where the backend keeps engines, models and ffmpeg. Stored by the backend (settings.json in its data folder), so
 * the CLI and any other client see the same settings. */
export function PathsSection() {
  const paths = usePaths();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<Partial<Record<PathSettingKey, string>>>({});
  const p = paths.data;

  useEffect(() => {
    if (p) setDraft({ ...p.settings });
  }, [p]);

  const changes = Object.fromEntries(
    FIELDS.map(({ key }) => [key, (draft[key] ?? "").trim()]).filter(([key, v]) => v !== (p?.settings[key as PathSettingKey] ?? "")),
  ) as Partial<Record<PathSettingKey, string>>;

  return (
    <Card>
      <CardHeader title="Engines and storage" description="Where FireVoice keeps its engines, voice models and audio converter. Leave a field empty for the default." />
      <CardBody>
        {paths.isLoading ? (
          <div className="space-y-3 py-1">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : p ? (
          <div className="space-y-4">
            <div>
              <Label>Data folder</Label>
              <Input value={p.home.path ?? ""} disabled />
            </div>
            {FIELDS.map(({ key, label, hint }) => (
              <div key={key}>
                <Label htmlFor={`path-${key}`} hint={sourceLabel(p[key].source, p[key].exists)}>
                  {label}
                </Label>
                <Input id={`path-${key}`} value={draft[key] ?? ""} placeholder={p[key].path ?? hint} title={hint} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
              </div>
            ))}
            {p.watermark && (
              <Switch
                checked={p.watermark.policy !== "off"}
                disabled={!p.watermark.available || save.isPending}
                onChange={(v) => save.mutate({ watermark: v ? "all" : "off" })}
                label="Mark every output as AI speech"
                description={p.watermark.available ? "An inaudible watermark that detectors can find, even after MP3 conversion and edits." : "The watermark is not available in this copy of FireVoice."}
              />
            )}
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={!Object.keys(changes).length} loading={save.isPending} onClick={() => save.mutate(changes)} leading={<Save className="size-3.5" />}>
                Save
              </Button>
              <span className="text-[12px] text-faint">New folders take effect after FireVoice restarts.</span>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted">Connect to FireVoice to see its folders.</p>
        )}
      </CardBody>
    </Card>
  );
}
