import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { url } from "@/lib/api/client";
import { Button } from "@/components/ui";

/** Sample recordings that ship with the backend (web/samples): speech.mp3, conversation.mp3, speech-with-music.mp3. */
export type SampleName = "speech.mp3" | "conversation.mp3" | "speech-with-music.mp3";

export async function sampleFile(name: SampleName): Promise<File> {
  const r = await fetch(url(`/web/samples/${name}`));
  if (!r.ok) throw new Error(`The sample ${name} is not on this backend (${r.status}); restart or update it.`);
  return new File([await r.blob()], name, { type: "audio/mpeg" });
}

/** A small button that loads a sample recording into a tool, so it can be tried without recording anything. */
export function TrySample({ name, onFile, label = "Try a sample", disabled }: { name: SampleName; onFile: (f: File) => void; label?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      leading={<Sparkles className="size-3.5" />}
      loading={busy}
      disabled={disabled}
      onClick={async () => {
        setBusy(true);
        try {
          onFile(await sampleFile(name));
        } catch (e) {
          toast.error(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {label}
    </Button>
  );
}
