import { useState } from "react";
import { toast } from "sonner";
import { Button, Card, CardBody, CardHeader, ConfirmDialog, Switch } from "@/components/ui";
import { inTauri } from "@/lib/backend";
import { cloud, useCloud, useSetCloud } from "@/lib/cloud";

const SITE = "https://firevoice.fabwaseem.com";

/** Usage sharing: the switch, what it means, and erasing what this computer already sent. */
export function PrivacySection() {
  const status = useCloud();
  const set = useSetCloud();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  if (!inTauri() || !status.data) return null;
  const s = status.data;

  const change = async (on: boolean) => {
    setBusy(true);
    try {
      set(await cloud.consent(on));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const erase = async () => {
    setBusy(true);
    try {
      set(await cloud.erase());
      setConfirm(false);
      toast.success("Your usage data was deleted", { description: "Sharing is now off." });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Privacy" description="What you dictate, record or make never leaves this computer." />
      <CardBody className="space-y-4">
        <Switch
          checked={s.consent === true}
          disabled={busy}
          onChange={(on) => void change(on)}
          label="Share usage statistics"
          description={
            s.consent
              ? "FireVoice sends which features you use, app and computer details, crash reports. Never your text, recordings, voices or files."
              : "Nothing about how you use FireVoice is sent."
          }
        />
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-surface-2 px-3.5 py-3">
          <div className="min-w-0">
            <span className="block text-[13px] font-medium text-ink">Delete my usage data</span>
            <span className="block text-[12px] text-muted">Removes everything this computer sent from FireVoice's servers and turns sharing off.</span>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => window.open(`${SITE}/privacy`, "_blank")}>
              Privacy policy
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !s.registered} onClick={() => setConfirm(true)}>
              Delete
            </Button>
          </div>
        </div>
      </CardBody>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete your usage data?"
        description="Everything this computer has sent (activity, crash reports, computer details) is removed from FireVoice's servers, and sharing turns off. Your account, if you have one, stays."
        confirmLabel="Delete"
        destructive
        loading={busy}
        onConfirm={() => void erase()}
      />
    </Card>
  );
}
