import { useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function TagsInput({ value, onChange, placeholder = "Add a tag and press Enter", disabled, id }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean; id?: string }) {
  const [text, setText] = useState("");

  const commit = () => {
    const t = text.trim().replace(/,+$/, "");
    if (t && !value.includes(t)) onChange([...value, t]);
    setText("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };

  return (
    <div
      className={cn(
        "flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 py-1 transition-[border,box-shadow] focus-within:border-fire/60 focus-within:bg-surface focus-within:shadow-[0_0_0_3px_var(--fire-soft)]",
        disabled && "opacity-60",
      )}
    >
      {value.map((t) => (
        <span key={t} className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-3 pr-1 pl-2.5 text-[12px] font-medium text-ink-2">
          {t}
          {!disabled && (
            <button type="button" onClick={() => onChange(value.filter((x) => x !== t))} aria-label={`Remove tag ${t}`} className="flex size-4 items-center justify-center rounded-full hover:bg-line-strong">
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      <input
        id={id}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
        placeholder={value.length ? "" : placeholder}
        aria-label="Add tag"
        className="h-6 min-w-[120px] flex-1 bg-transparent px-1 text-[13px] text-ink placeholder:text-faint focus:outline-none"
      />
    </div>
  );
}
