import { useState } from "react";
import { FileText } from "lucide-react";
import { backend, inTauri } from "@/lib/backend";
import { Button, Dialog } from "@/components/ui";

/** "View engine log": what the voice engine wrote, for when something goes wrong. Desktop only. */
export function EngineLogButton({ size = "sm", variant = "ghost", label = "View engine log" }: { size?: "sm" | "md"; variant?: "ghost" | "outline"; label?: string }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState("");
  const [busy, setBusy] = useState(false);
  if (!inTauri()) return null;
  const show = async () => {
    setBusy(true);
    setLog(await backend.logs(400).catch((e) => String(e)));
    setBusy(false);
    setOpen(true);
  };
  return (
    <>
      <Button size={size} variant={variant} leading={<FileText className="size-4" />} loading={busy} onClick={() => void show()}>
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title="Engine log" description="Technical details that help explain what went wrong." size="xl">
        <pre className="max-h-[60vh] overflow-auto rounded-md bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 select-text">{log || "(empty)"}</pre>
      </Dialog>
    </>
  );
}
