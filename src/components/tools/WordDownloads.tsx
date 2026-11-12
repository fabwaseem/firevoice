import { useState } from "react";
import * as DM from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ListOrdered } from "@/components/icons";
import { toast } from "sonner";
import { saveBlob } from "@/lib/audio";
import { errMessage } from "@/lib/api/hooks";
import { WORD_FORMATS, wordsFile, type TimedWord, type WordFormat } from "@/lib/words";
import { Button } from "@/components/ui";

/** "Word timings" menu: every word with its start and end, as a spreadsheet, JSON, or word-by-word subtitles.
 * `words` can be a list, or a loader for when the words live on the server (a job, a kept render). */
export function WordDownloads({
  words,
  baseName,
  size = "sm",
  variant = "outline",
  label = "Word timings",
}: {
  words: TimedWord[] | (() => Promise<TimedWord[]>);
  baseName: string;
  size?: "sm" | "md";
  variant?: "outline" | "ghost";
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const empty = Array.isArray(words) && words.length === 0;

  const save = async (format: WordFormat) => {
    setBusy(true);
    try {
      const list = Array.isArray(words) ? words : await words();
      if (!list.length) {
        toast.error("There are no word timings for this one");
        return;
      }
      const f = wordsFile(list, format);
      const name = `${(baseName || "words").replace(/[^\w\- ]+/g, "").trim().slice(0, 60).replace(/\s+/g, "-") || "words"}-words.${f.ext}`;
      await saveBlob(new Blob([f.text], { type: f.mime }), name);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DM.Root>
      <DM.Trigger asChild>
        <Button size={size} variant={variant} disabled={empty} loading={busy} leading={<ListOrdered className="size-4" />} trailing={<ChevronDown className="size-3.5 opacity-70" />}>
          {label}
        </Button>
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="start" sideOffset={6} collisionPadding={12} className="surface-raised z-50 w-[300px] rounded-xl p-1.5 fade-up">
          {WORD_FORMATS.map((f) => (
            <DM.Item
              key={f.value}
              onSelect={() => void save(f.value)}
              className="flex cursor-default flex-col rounded-lg px-3 py-2 outline-none select-none data-[highlighted]:bg-surface-2"
            >
              <span className="text-[13px] font-medium text-ink">{f.label}</span>
              <span className="text-[11.5px] text-muted">{f.hint}</span>
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
