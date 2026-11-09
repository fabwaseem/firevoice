import { Heart, Search, X } from "lucide-react";
import { Chip, Input, Select } from "@/components/ui";
import { langName } from "@/lib/utils";
import { GENDERS } from "./helpers";

export interface VoiceFilterState {
  q: string;
  kind: "" | "cloned" | "designed";
  gender: string;
  language: string;
  favorites: boolean;
}

export const EMPTY_FILTERS: VoiceFilterState = { q: "", kind: "", gender: "", language: "", favorites: false };

export function VoiceFilters({
  value,
  onChange,
  languages,
}: {
  value: VoiceFilterState;
  onChange: (v: VoiceFilterState) => void;
  languages: string[];
}) {
  const set = (patch: Partial<VoiceFilterState>) => onChange({ ...value, ...patch });
  const active = value.q || value.kind || value.gender || value.language || value.favorites;

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2">
      <Input
        type="search"
        value={value.q}
        onChange={(e) => set({ q: e.target.value })}
        placeholder="Search voices, accents, tags…"
        aria-label="Search voices"
        leading={<Search />}
        className="w-[260px]"
      />

      <div role="group" aria-label="Voice kind" className="flex items-center gap-1.5">
        {(
          [
            ["", "All"],
            ["cloned", "Cloned"],
            ["designed", "Designed"],
          ] as const
        ).map(([k, label]) => (
          <Chip key={k} active={value.kind === k} onClick={() => set({ kind: k })}>
            {label}
          </Chip>
        ))}
      </div>

      <Select
        value={value.gender}
        onChange={(gender) => set({ gender })}
        options={GENDERS}
        ariaLabel="Gender"
        size="sm"
        className="w-[136px]"
      />

      <Select
        value={value.language}
        onChange={(language) => set({ language })}
        options={[{ value: "", label: "Any language" }, ...languages.map((l) => ({ value: l, label: langName(l) }))]}
        ariaLabel="Language"
        size="sm"
        className="w-[150px]"
      />

      <Chip active={value.favorites} onClick={() => set({ favorites: !value.favorites })} aria-label="Show favorites only">
        <Heart className={value.favorites ? "size-3.5 fill-current" : "size-3.5"} />
        Favorites
      </Chip>

      {active && (
        <button
          type="button"
          onClick={() => onChange(EMPTY_FILTERS)}
          className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium text-muted hover:text-ink"
        >
          <X className="size-3.5" /> Clear
        </button>
      )}
    </div>
  );
}
