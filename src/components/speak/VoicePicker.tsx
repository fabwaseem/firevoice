import { useMemo, useState } from "react";
import * as RP from "@radix-ui/react-popover";
import { Check, ChevronDown, Heart, Play, Search, Star, Wand2 } from "lucide-react";
import { api } from "@/lib/api/client";
import { useVoices } from "@/lib/api/hooks";
import type { Engine, Voice } from "@/lib/api/types";
import { usePlayer } from "@/stores/player";
import { ArtTile, Badge, Input } from "@/components/ui";
import { cn, langName } from "@/lib/utils";
import { DesignVoiceDialog } from "@/components/voices/DesignVoiceDialog";

function initials(name: string) {
  return name.split(/[\s\-_]+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("");
}

/** Voice selector: library voices with search and preview, plus a “design from description” mode. */
export function VoicePicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; engine?: Engine; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const voices = useVoices();
  const load = usePlayer((s) => s.load);
  const isDesign = value.startsWith("design:");
  const [designOpen, setDesignOpen] = useState(false);

  const list = useMemo(() => {
    const all = voices.data ?? [];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? all.filter((v) => [v.name, v.voice_id, v.tagline, v.description, v.language, v.accent, v.gender, ...(v.tags ?? []), ...(v.use_cases ?? []), ...(v.traits ?? [])].join(" ").toLowerCase().includes(needle))
      : all;
    return [...filtered].sort((a, b) => Number(b.default) - Number(a.default) || Number(!!b.favorite) - Number(!!a.favorite) || a.name.localeCompare(b.name));
  }, [voices.data, q]);

  const selected: Voice | undefined = voices.data?.find((v) => v.voice_id === value);
  const defaultVoice = voices.data?.find((v) => v.default);
  const label = isDesign ? "Designed from description" : value === "default" ? (defaultVoice ? `${defaultVoice.name} (default)` : "Default voice") : (selected?.name ?? value);
  const sub = isDesign ? value.slice(7) : selected?.tagline || selected?.description || (value === "default" ? defaultVoice?.tagline || defaultVoice?.description : "") || "";

  const preview = (v: Voice) =>
    load({ id: v.voice_id, title: v.name, subtitle: v.has_preview ? "Introduction" : "Reference clip", src: v.has_preview ? api.voicePreviewUrl(v.voice_id) : api.voiceAudioUrl(v.voice_id), format: v.has_preview ? "mp3" : "wav", href: `/voices/${v.voice_id}` });

  return (
    <>
    <RP.Root open={open} onOpenChange={setOpen}>
      <RP.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label="Choose voice"
          className={cn(
            "group flex w-full items-center gap-3 rounded-xl border border-line bg-surface-2 p-2 pr-3 text-left transition-[border,box-shadow,background] hover:border-line-strong",
            "data-[state=open]:border-fire/60 data-[state=open]:shadow-[0_0_0_3px_var(--fire-soft)] disabled:opacity-50",
          )}
        >
          <ArtTile seed={isDesign ? "design" : value === "default" ? (defaultVoice?.voice_id ?? "default") : value}
            image={isDesign ? null : api.voiceAvatarUrl(value === "default" ? defaultVoice : selected)} className="size-11 shrink-0 text-[13px] font-bold">
            {isDesign ? <Wand2 className="size-5" /> : (value === "default" ? defaultVoice : selected)?.avatar ? null : initials(selected?.name ?? defaultVoice?.name ?? "FV")}
          </ArtTile>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13.5px] font-semibold text-ink">{label}</span>
            <span className="block truncate text-[12px] text-muted">{sub || "Pick from the library or describe a new one"}</span>
          </span>
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </RP.Trigger>
      <RP.Portal>
        <RP.Content align="start" sideOffset={6} collisionPadding={12} className="surface-raised z-50 w-[var(--radix-popover-trigger-width)] min-w-[340px] rounded-xl p-2 fade-up">
          <Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search voices…" aria-label="Search voices" autoFocus className="mb-2" />
          <div className="max-h-[340px] overflow-y-auto pr-1">
            <VoiceRow
              active={value === "default"}
              onSelect={() => { onChange("default"); setOpen(false); }}
              tile={<Star className="size-4" />}
              seed={defaultVoice?.voice_id ?? "default"}
              title={defaultVoice ? `${defaultVoice.name} · default` : "Default voice"}
              subtitle={defaultVoice?.tagline || defaultVoice?.description || "Whatever the server marks as default"}
            />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                // after the picker has closed, so its closing click doesn't count as a click outside the new window
                window.setTimeout(() => setDesignOpen(true), 60);
              }}
              className="mt-1 flex w-full items-center gap-3 rounded-lg border border-dashed border-line p-2 text-left transition-colors hover:border-fire/50 hover:bg-fire-soft/40"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-fire-soft text-fire"><Wand2 className="size-4" /></span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-ink">Design a new voice…</span>
                <span className="block truncate text-[12px] text-muted">Describe it, hear three takes, keep one in Voices</span>
              </span>
            </button>
            <div className="mt-2 mb-1 px-2 text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">Library · {list.length}</div>
            {voices.isLoading && <div className="px-2 py-4 text-[13px] text-muted">Loading voices…</div>}
            {voices.isError && <div className="px-2 py-4 text-[13px] text-bad">Could not load voices.</div>}
            {list.map((v) => (
              <VoiceRow
                key={v.voice_id}
                active={v.voice_id === value}
                onSelect={() => { onChange(v.voice_id); setOpen(false); }}
                onPreview={() => preview(v)}
                seed={v.voice_id}
                image={api.voiceAvatarUrl(v)}
                tile={v.avatar ? null : initials(v.name)}
                title={v.name}
                subtitle={v.tagline || [v.description, langName(v.language), v.gender, v.accent].filter(Boolean).join(" · ")}
                badges={
                  <>
                    {v.favorite && <Heart className="size-3.5 fill-fire text-fire" aria-label="favorite" />}
                    {v.quality?.tier === "S" && <Star className="size-3.5 fill-fire text-fire" aria-label="top pick" />}
                    {v.kind === "designed" && <Badge tone="info">Designed</Badge>}
                    {v.styles && v.styles.length > 0 && <Badge>{v.styles.length} style clips</Badge>}
                  </>
                }
              />
            ))}
            {!voices.isLoading && !list.length && <div className="px-2 py-6 text-center text-[13px] text-muted">No voices match.</div>}
          </div>
        </RP.Content>
      </RP.Portal>
    </RP.Root>
    <DesignVoiceDialog open={designOpen} onOpenChange={setDesignOpen} onKept={(v) => onChange(v.voice_id)} />
    </>
  );
}

function VoiceRow({
  active, onSelect, onPreview, seed, tile, title, subtitle, badges, image,
}: {
  active: boolean; onSelect: () => void; onPreview?: () => void; seed: string; tile: React.ReactNode; title: string; subtitle?: string; badges?: React.ReactNode; image?: string | null;
}) {
  return (
    <div className={cn("group/row flex items-center gap-2.5 rounded-lg p-1.5 pr-2 transition-colors hover:bg-surface-3", active && "bg-fire-soft/50")}>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
        <ArtTile seed={seed} image={image} className="size-9 shrink-0 text-[11px] font-bold">{tile}</ArtTile>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink"><span className="truncate">{title}</span>{badges}</span>
          {subtitle && <span className="block truncate text-[11.5px] text-muted">{subtitle}</span>}
        </span>
      </button>
      {onPreview && (
        <button type="button" onClick={onPreview} aria-label={`Preview ${title}`} className="flex size-7 items-center justify-center rounded-full text-muted opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-surface hover:text-ink focus-visible:opacity-100">
          <Play className="size-3.5 fill-current" />
        </button>
      )}
      {active && <Check className="size-4 text-fire" />}
    </div>
  );
}
