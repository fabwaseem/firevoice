import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Card, CardBody, CardHeader, Switch } from "@/components/ui";
import { inTauri } from "@/lib/backend";

/** The desktop shell's view of "start with the computer" (src-tauri/src/autostart.rs). */
interface AutostartStatus {
  supported: boolean;
  enabled: boolean;
  registered: boolean;
  dev: boolean;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

const isWindows = typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);

export function StartupSection() {
  const [status, setStatus] = useState<AutostartStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    // read it again when the window comes back: the user may have changed it in Windows' startup list meanwhile
    const read = () => call<AutostartStatus>("autostart_status").then(setStatus).catch(() => {});
    read();
    window.addEventListener("focus", read);
    return () => window.removeEventListener("focus", read);
  }, []);

  if (!status?.supported) return null;

  const change = async (enabled: boolean) => {
    setBusy(true);
    setStatus({ ...status, enabled });
    try {
      setStatus(await call<AutostartStatus>("autostart_set", { enabled }));
    } catch (e) {
      setStatus({ ...status });
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Startup" />
      <CardBody>
        <Switch
          checked={status.enabled}
          disabled={busy}
          onChange={change}
          label={isWindows ? "Start FireVoice with Windows" : "Start FireVoice when you sign in"}
          description={
            status.enabled
              ? "It opens quietly in the tray when you sign in, so dictation is ready. Click the tray icon to open the window."
              : "Open FireVoice yourself when you need it. Dictation works only while it is running."
          }
        />
      </CardBody>
    </Card>
  );
}
