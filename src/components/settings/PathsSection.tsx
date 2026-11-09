import { useEffect, useState } from "react";
import type { PathSettingKey } from "@/lib/api/types";
import { usePaths, useSaveSettings } from "@/lib/api/hooks";
import { Button, Card, CardBody, CardHeader, Input, Label, Skeleton, Switch } from "@/components/ui";

const FIELDS: { key: Exclude<PathSettingKey, "watermark">; label: string; hint: string }[] = [
  { key: "engines_dir", label: "Engine folder", hint: "Python environments, one per engine (about 5 GB each)" },
  { key: "weights_dir", label: "Model weights", hint: "Downloaded models (3 to 8 GB each)" },
  { key: "ffmpeg", label: "ffmpeg", hint: "Full path to ffmpeg.exe" },
];

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
      <CardHeader title="Engines and storage" description="Where the backend keeps engine environments, models and ffmpeg. Leave a field empty for the default." />
      <CardBody>
        {paths.isLoading ? (
          <div className="space-y-3 py-1">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : p ? (
          <div className="space-y-4">
            <div>
              <Label hint="FIREVOICE_HOME">Data folder</Label>
              <Input value={p.home.path ?? ""} disabled />
            </div>
            {FIELDS.map(({ key, label, hint }) => (
              <div key={key}>
                <Label htmlFor={`path-${key}`} hint={`${p[key].source}${p[key].exists ? "" : ", missing"}`}>
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
                description={p.watermark.available ? "An inaudible watermark (AudioSeal) that detectors can find, even after MP3 and edits." : "Needs the audioseal package in the backend."}
              />
            )}
            <div className="flex items-center gap-3">
              <Button size="sm" disabled={!Object.keys(changes).length} loading={save.isPending} onClick={() => save.mutate(changes)}>
                Save
              </Button>
              <span className="text-[12px] text-faint">Environment variables override these. Engine folders apply after the backend restarts.</span>
            </div>
          </div>
        ) : (
          <p className="text-[13px] text-muted">Connect to a backend to see its folders.</p>
        )}
      </CardBody>
    </Card>
  );
}
