import { type ReactNode } from "react";
import { openExternal } from "@/lib/external";
import { cn } from "@/lib/utils";

/* A small Markdown renderer for short texts such as release notes: paragraphs, bullet and numbered lists, headings,
 * **bold**, *italic*, `code` and [links](https://…). It builds React elements (never HTML strings), and only http(s)
 * links are made clickable, so text from outside can't inject anything. */

const INLINE = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\s][^*]*?)\*/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = n++;
    if (m[1] != null) out.push(<strong key={key} className="font-semibold text-ink">{inline(m[1])}</strong>);
    else if (m[2] != null) out.push(<code key={key} className="rounded bg-surface-3 px-1 py-px font-mono text-[0.92em] text-ink">{m[2]}</code>);
    else if (m[3] != null && m[4] != null) {
      const url = m[4];
      out.push(
        <a
          key={key}
          href={url}
          onClick={(e) => {
            e.preventDefault();
            void openExternal(url);
          }}
          className="text-fire underline-offset-2 hover:underline"
        >
          {m[3]}
        </a>,
      );
    } else if (m[5] != null) out.push(<em key={key}>{m[5]}</em>);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { type: "p"; text: string }
  | { type: "h"; text: string }
  | { type: "ul" | "ol"; items: string[] };

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", text: para.join(" ") });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: "h", text: heading[1] });
    } else if (bullet || numbered) {
      flushPara();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
    } else if (list && /^\s+/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`; // an indented line continues the item above it
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn("space-y-2 text-[12.5px] leading-relaxed text-ink-2", className)}>
      {parse(text).map((b, i) => {
        if (b.type === "h") return <h4 key={i} className="pt-1 text-[12.5px] font-semibold text-ink">{inline(b.text)}</h4>;
        if (b.type === "p") return <p key={i}>{inline(b.text)}</p>;
        const List = b.type === "ul" ? "ul" : "ol";
        return (
          <List key={i} className={cn("space-y-1.5 pl-4 marker:text-fire", b.type === "ul" ? "list-disc" : "list-decimal")}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
