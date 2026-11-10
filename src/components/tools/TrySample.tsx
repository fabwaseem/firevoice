import { useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { authHeaders, url } from "@/lib/api/client";

/** Sample recordings that ship with the backend (GET /api/v1/samples): speech.mp3, conversation.mp3, speech-with-music.mp3. */
export type SampleName = "speech.mp3" | "conversation.mp3" | "speech-with-music.mp3";

export async function sampleFile(name: SampleName): Promise<File> {
  const r = await fetch(url(`/api/v1/samples/${name}`), { headers: authHeaders() });
  if (!r.ok) throw new Error("This sample is not available. Restart or update FireVoice, then try again.");
  return new File([await r.blob()], name, { type: "audio/mpeg" });
}

/** A small link that loads a sample recording into a tool, so it can be tried without recording anything. It sits
 * under the file picker, never beside it as a button of the same weight. */
export function TrySample({ name, onFile, label = "Try a sample", disabled }: { name: SampleName; onFile: (f: File) => void; label?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={disabled || busy}
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
      className="inline-flex items-center gap-1 rounded text-[12px] font-medium text-fire outline-none hover:underline focus-visible:ring-2 focus-visible:ring-fire/40 disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
      {label}
    </button>
  );
}
