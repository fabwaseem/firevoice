import { useCallback, useRef } from "react";
import { ClipboardPaste, Eraser, FileText, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button, Tooltip } from "@/components/ui";
import { SAMPLE_TEXT, useStudio } from "@/stores/studio";
import { cn } from "@/lib/utils";

const MARKUP: { label: string; insert: string; hint: string; needsTags?: boolean }[] = [
  { label: "Pause", insert: "[pause 500ms]", hint: "Silence of a given length" },
  { label: "Pace", insert: "[pace 0.9]", hint: "Change tempo from here on" },
  { label: "Style", insert: "[style dramatic]", hint: "Switch delivery style mid-script" },
  { label: "¶", insert: "\n\n", hint: "Paragraph break (longer pause)" },
  { label: "[laugh]", insert: "[laugh]", hint: "Paralinguistic tag", needsTags: true },
  { label: "[sigh]", insert: "[sigh]", hint: "Paralinguistic tag", needsTags: true },
  { label: "[gasp]", insert: "[gasp]", hint: "Paralinguistic tag", needsTags: true },
  { label: "[chuckle]", insert: "[chuckle]", hint: "Paralinguistic tag", needsTags: true },
  { label: "[cough]", insert: "[cough]", hint: "Paralinguistic tag", needsTags: true },
  { label: "[clear throat]", insert: "[clear throat]", hint: "Paralinguistic tag", needsTags: true },
  { label: "[groan]", insert: "[groan]", hint: "Paralinguistic tag", needsTags: true },
];

export function ScriptEditor({ supportsTags, disabled, className }: { supportsTags: boolean; disabled?: boolean; className?: string }) {
  const text = useStudio((s) => s.text);
  const set = useStudio((s) => s.set);
  const ref = useRef<HTMLTextAreaElement>(null);

  const insert = useCallback(
    (snippet: string) => {
      const ta = ref.current;
      if (!ta) return set({ text: text + snippet });
      const start = ta.selectionStart ?? text.length;
      const end = ta.selectionEnd ?? start;
      const before = text.slice(0, start);
      const after = text.slice(end);
      const pad = before && !/\s$/.test(before) && !snippet.startsWith("\n") ? " " : "";
      const next = before + pad + snippet + (after && !/^\s/.test(after) && !snippet.endsWith("\n") ? " " : "") + after;
      set({ text: next });
      requestAnimationFrame(() => {
        ta.focus();
        const pos = (before + pad + snippet).length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [text, set],
  );

  const words = text.trim() ? text.replace(/\[[^\]]*\]/g, " ").trim().split(/\s+/).length : 0;
  const estSeconds = Math.round(words / 2.6);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex flex-wrap items-center gap-1.5 px-1 pb-2">
        <span className="mr-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">Insert</span>
        {MARKUP.filter((m) => !m.needsTags || supportsTags).map((m) => (
          <Tooltip key={m.label} content={m.hint}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => insert(m.insert)}
              className="h-7 rounded-[8px] border border-line bg-surface px-2 font-mono text-[11.5px] text-ink-2 transition-colors hover:border-line-strong hover:text-ink disabled:opacity-50"
            >
              {m.label}
            </button>
          </Tooltip>
        ))}
        <Tooltip content="Switch the delivery from here until [normal]; works with every engine">
          <select
            aria-label="Insert a delivery tag"
            disabled={disabled}
            value=""
            onChange={(e) => { if (e.target.value) insert(e.target.value); }}
            className="h-7 rounded-[8px] border border-line bg-surface px-2 font-mono text-[11.5px] text-ink-2 hover:border-line-strong disabled:opacity-50"
          >
            <option value="">delivery…</option>
            {["whisper", "excited", "calm", "sad", "angry", "serious", "dramatic", "curious", "normal"].map((t) => <option key={t} value={`[${t}]`}>[{t}]</option>)}
          </select>
        </Tooltip>
        {!supportsTags && (
          <Tooltip content="This engine ignores [laugh] and [sigh]. Flash, Candle and Phoenix read them.">
            <span className="ml-1 inline-flex items-center gap-1 text-[11.5px] text-faint">
              <Sparkles className="size-3.5" /> tags off
            </span>
          </Tooltip>
        )}
        <span className="flex-1" />
        <Tooltip content="Paste from clipboard">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Paste from clipboard"
            disabled={disabled}
            onClick={async () => {
              try {
                const t = await navigator.clipboard.readText();
                if (t) set({ text: text ? text + (text.endsWith("\n") ? "" : "\n\n") + t : t });
              } catch {
                toast.error("Could not read the clipboard. Paste with Ctrl+V instead.");
              }
            }}
          >
            <ClipboardPaste className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content="Load the sample script">
          <Button variant="ghost" size="icon-sm" aria-label="Load sample script" disabled={disabled} onClick={() => set({ text: SAMPLE_TEXT })}>
            <FileText className="size-4" />
          </Button>
        </Tooltip>
        <Tooltip content="Clear">
          <Button variant="ghost" size="icon-sm" aria-label="Clear script" disabled={disabled || !text} onClick={() => set({ text: "" })}>
            <Eraser className="size-4" />
          </Button>
        </Tooltip>
      </div>

      <textarea
        ref={ref}
        value={text}
        disabled={disabled}
        onChange={(e) => set({ text: e.target.value })}
        placeholder="Write or paste what you want said. Blank lines become paragraph pauses; use [pause 500ms], [style horror] or [pace 0.9] anywhere."
        aria-label="Script"
        spellCheck
        className={cn(
          "min-h-[240px] flex-1 resize-none rounded-xl border border-transparent bg-transparent px-1 py-1 text-[17px] leading-[1.65] text-ink placeholder:text-faint",
          "focus:outline-none disabled:opacity-60",
        )}
      />

      <div className="flex items-center justify-between px-1 pt-2 text-[12px] text-faint tabular">
        <span>
          {words} words · {text.length} chars
        </span>
        <span>≈ {estSeconds < 60 ? `${estSeconds} s` : `${Math.floor(estSeconds / 60)}:${String(estSeconds % 60).padStart(2, "0")}`} of speech</span>
      </div>
    </div>
  );
}
