import { useEffect, useState } from "react";
import { FileText, Play, RotateCcw, Square, Wrench } from "lucide-react";
import { backend, inTauri, localPort } from "@/lib/backend";
import { useBackend } from "@/stores/backend";
import { useSettings } from "@/stores/settings";
import { Badge, Button, Card, CardBody, CardHeader, Dialog, Switch } from "@/components/ui";

const MODE_LABEL = {
  bundled: "Included with the app",
  dev: "Developer copy",
  custom: "Your own copy",
  none: "Not found",
} as const;

/** Desktop only: the backend the app can start and stop for you. */
export function BackendSection() {
  const manage = useSettings((s) => s.manageBackend);
  const serverUrl = useSettings((s) => s.serverUrl);
  const set = useSettings((s) => s.set);
  const { info, phase, refresh, start, stop, runSetup } = useBackend();
  const [logOpen, setLogOpen] = useState(false);
  const [log, setLog] = useState("");

  // poll only while the window is visible
  useEffect(() => {
    let t: ReturnType<typeof setInterval> | null = null;
    const sync = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        if (!t) t = setInterval(() => void refresh(), 5000);
      } else if (t) {
        clearInterval(t);
        t = null;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      if (t) clearInterval(t);
    };
  }, [refresh]);

  if (!inTauri()) return null;
  const local = localPort(serverUrl) != null;

  const showLog = async () => {
    setLog(await backend.logs(400).catch((e) => String(e)));
    setLogOpen(true);
  };

  return (
    <Card>
      <CardHeader
        title="Voice engine"
        description="The part of FireVoice that makes the voices runs alongside the app. The app can start it for you, or connect to a FireVoice server you run yourself."
      />
      <CardBody className="space-y-4">
        <Switch
          checked={manage}
          onChange={(v) => set({ manageBackend: v })}
          label="Start the voice engine with the app"
          description={local ? "Stopped again when the app closes. A server you started yourself is left alone." : "Only for a server on this computer; the server address points somewhere else."}
          disabled={!local}
        />
        {info && (
          <dl className="space-y-1.5 text-[13px]">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Engine</dt>
              <dd className="text-ink">{MODE_LABEL[info.mode]}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Status</dt>
              <dd>
                {info.running ? (
                  <Badge tone="ok" dot>
                    Running
                  </Badge>
                ) : (
                  <Badge tone="neutral">Not started by the app</Badge>
                )}
              </dd>
            </div>
            {info.mode === "bundled" && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted">Version</dt>
                <dd className="text-ink tabular">
                  {info.installed_version ?? "Not set up"}
                  {info.bundled_version && info.installed_version !== info.bundled_version ? ` (update to ${info.bundled_version} available)` : ""}
                </dd>
              </div>
            )}
          </dl>
        )}
        <div className="flex flex-wrap gap-2">
          {info?.running ? (
            <>
              <Button size="sm" variant="soft" leading={<Square className="size-3.5" />} onClick={() => stop()}>
                Stop
              </Button>
              <Button size="sm" variant="ghost" leading={<RotateCcw className="size-3.5" />} onClick={async () => { await stop(); await start(); }}>
                Restart
              </Button>
            </>
          ) : (
            <Button size="sm" variant="soft" leading={<Play className="size-3.5" />} disabled={!info?.ready || !local} loading={phase === "starting"} onClick={() => start()}>
              Start
            </Button>
          )}
          {info?.mode === "bundled" && (
            <Button size="sm" variant="ghost" leading={<Wrench className="size-3.5" />} disabled={phase === "setting-up"} onClick={() => runSetup()}>
              {info.ready ? "Repair or update" : "Set up"}
            </Button>
          )}
          <Button size="sm" variant="ghost" leading={<FileText className="size-3.5" />} onClick={showLog}>
            Log
          </Button>
        </div>
      </CardBody>
      <Dialog open={logOpen} onOpenChange={setLogOpen} title="Engine log" description="Technical details that help explain what went wrong." size="xl">
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">{log || "(empty)"}</pre>
      </Dialog>
    </Card>
  );
}
