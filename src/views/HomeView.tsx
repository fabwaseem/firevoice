import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  Activity,
  ArrowRight,
  Keyboard,
  MessageSquareQuote,
  AudioLines,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  Clock,
  Cpu,
  Flame,
  Gauge,
  HardDrive,
  Languages,
  Library,
  Mic,
  Palette,
  Sparkles,
  Timer,
  Trophy,
  Type,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { useHealth, useStats, useSystem, errMessage } from "@/lib/api/hooks";
import type { DictationStats, StatGroup, StatRow, Stats } from "@/lib/api/types";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { Button, Card, Kbd, Segmented, Skeleton } from "@/components/ui";
import { GpuCard } from "@/components/home/GpuCard";
import { OfflineCard } from "@/components/home/OfflineCard";
import { greeting } from "@/lib/external";
import { hotkeyLabels } from "@/lib/dictation";
import { useDictation } from "@/stores/dictation";
import { cn, fmtBytes, fmtGB, langName } from "@/lib/utils";

type Icon = ComponentType<{ className?: string }>;

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "0", label: "All time" },
] as const;

// fixed categorical slots: a group keeps its colour whatever the range shows
const GROUP: Record<StatGroup, { label: string; color: string }> = {
  speech: { label: "Speech", color: "var(--series-1)" },
  dialogue: { label: "Dialogue", color: "var(--series-2)" },
  sound: { label: "Sound & music", color: "var(--series-3)" },
  changer: { label: "Voice changer", color: "var(--series-4)" },
  dub: { label: "Dubbing", color: "var(--series-5)" },
  transcript: { label: "Transcripts", color: "var(--series-6)" },
  tools: { label: "Audio tools", color: "var(--series-7)" },
};

const KIND_LABEL: Record<string, string> = {
  speech: "Speech", dialogue: "Dialogues", sound: "Sound effects", music: "Music", changer: "Voice changes", dub: "Dubs",
  transcript: "Transcripts", separate: "Separations", clean: "Clean-ups", voice: "Voices added", design: "Voices designed",
};

/** 3725 s -> "1 h 2 m"; 75 -> "1 m 15 s"; 9.4 -> "9.4 s" */
function dur(sec: number | null | undefined): string {
  const s = Math.max(0, sec ?? 0);
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${m} m`;
  return `${m} m ${Math.round(s % 60)} s`;
}
const num = (n: number | null | undefined) => (n ?? 0).toLocaleString();
/** Axis labels: 30 s, 10 m, 2 h */
const short = (sec: number) => (sec < 60 ? `${Math.round(sec)} s` : sec < 3600 ? `${Math.round(sec / 60)} m` : `${+(sec / 3600).toFixed(1)} h`);
const day = (iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) => new Date(iso + "T00:00:00").toLocaleDateString(undefined, opts);

/** One line on the machine: engines loaded, voices, the graphics card and its free memory. */
function Summary() {
  const s = useSystem().data;
  if (!s) return <Skeleton className="mt-1 h-4 w-96 max-w-full" />;
  const loaded = s.loaded_engines ?? [];
  const parts = [`${loaded.length} ${loaded.length === 1 ? "engine" : "engines"} loaded`, `${s.voices} ${s.voices === 1 ? "voice" : "voices"}`];
  if (s.gpu?.name) parts.push(`${s.gpu.name}, ${fmtGB(s.gpu.vram_free_gb)} of ${fmtGB(s.gpu.vram_total_gb)} free`);
  return <>{parts.join(" · ")}</>;
}

/** Home: what you have done with FireVoice, dictation first, and how the machine is doing. */
export function HomeView() {
  const health = useHealth();
  const navigate = useNavigate();
  const [range, setRange] = useState<(typeof RANGES)[number]["value"]>(() => {
    try {
      const v = localStorage.getItem("firevoice.home.range");
      return RANGES.some((r) => r.value === v) ? (v as (typeof RANGES)[number]["value"]) : "30";
    } catch {
      return "30";
    }
  });
  const pick = (v: (typeof RANGES)[number]["value"]) => {
    setRange(v);
    try {
      localStorage.setItem("firevoice.home.range", v);
    } catch {
      /* not remembered */
    }
  };
  const q = useStats(Number(range));
  const s = q.data;

  return (
    <div className="page-width fade-up">
      <PageHeader
        title={greeting()}
        subtitle={health.isSuccess ? <Summary /> : health.isLoading ? "Connecting to FireVoice…" : "FireVoice is not running"}
        actions={
          <>
            <Segmented value={range} onChange={pick} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} ariaLabel="Time range" />
            <Button variant="primary" size="sm" leading={<AudioLines className="size-4" />} onClick={() => navigate("/speak")}>
              New render
            </Button>
          </>
        }
      />
      {health.isError ? (
        <OfflineCard onRetry={() => void health.refetch()} retrying={health.isFetching} />
      ) : q.isError ? (
        <LoadError message={errMessage(q.error)} retry={() => void q.refetch()} />
      ) : !s ? (
        <HomeSkeleton />
      ) : (
        <StatsBody s={s} />
      )}
    </div>
  );
}

function StatsBody({ s }: { s: Stats }) {
  const t = s.totals;
  const rangeLabel = s.range.days ? `in the last ${s.range.days} days` : "all time";
  return (
    <div className="space-y-4">
      {/* dictation, the everyday feature, and the machine */}
      <div className="grid gap-4 lg:grid-cols-12">
        <div className="min-h-[308px] lg:col-span-8">
          <DictationHero d={s.dictation ?? null} daily={s.daily.map((x) => x.date)} rangeLabel={rangeLabel} />
        </div>
        <div className="min-h-[308px] lg:col-span-4">
          <GpuCard />
        </div>
      </div>

      {/* headline numbers */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <Tile icon={AudioLines} label="Audio made" value={dur(t.audio_made_s)} sub={`${num(t.done)} things made ${rangeLabel}`} accent />
        <Tile icon={Mic} label="Speech renders" value={num(t.speech_renders)} sub={`${dur(t.speech_s)} of speech`} />
        <Tile icon={Type} label="Words spoken" value={num(t.words_spoken)} sub={`${num(t.chars)} characters`} />
        <Tile icon={BookOpen} label="Transcribed" value={dur(t.transcribed_s)} sub={`${num(t.words_transcribed)} words in ${num(t.transcripts)} transcripts`} />
        <Tile
          icon={Zap}
          label="Speed"
          value={t.speed ? `${t.speed}×` : "–"}
          sub={!t.speed ? "shows after your next render" : t.speed >= 1 ? "faster than real time" : "slower than real time (includes engine start-up)"}
        />
        <Tile
          icon={CheckCircle2}
          label="Success rate"
          value={t.done + t.failed ? `${Math.round(t.success_rate * 100)}%` : "–"}
          sub={t.failed ? `${num(t.failed)} failed · ${num(t.cancelled)} cancelled` : t.cancelled ? `${num(t.cancelled)} cancelled` : "nothing failed"}
        />
      </div>

      <ActivityChart s={s} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel icon={Sparkles} title="What you made" note={`${num(s.by_kind.length)} kinds`}>
          <BarList
            rows={s.by_kind.map((k) => ({ key: k.kind, name: KIND_LABEL[k.kind] ?? k.kind, count: k.count, audio_s: k.audio_s, speed: null }))}
            value={(r) => r.count}
            right={(r) => `${num(r.count)}${r.audio_s ? ` · ${dur(r.audio_s)}` : ""}`}
            empty="Nothing made in this range yet."
          />
        </Panel>
        <Panel icon={Cpu} title="Engines" note={`${num(s.engines_used)} used`}>
          <BarList rows={s.engines} value={(r) => r.audio_s || r.count} right={(r) => `${num(r.count)} · ${dur(r.audio_s)}${r.speed ? ` · ${r.speed}×` : ""}`} empty="No engine used in this range." />
        </Panel>
        <Panel icon={Mic} title="Voices" note={`${num(s.voices_used)} used`}>
          <BarList rows={s.voices} value={(r) => r.count} right={(r) => `${num(r.count)} · ${dur(r.audio_s)}`} empty="No speech in this range." />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel icon={Palette} title="Styles" note={`${num(s.styles_used)} used`}>
          <BarList rows={s.styles} value={(r) => r.count} right={(r) => num(r.count)} empty="No speech in this range." />
        </Panel>
        <Panel icon={Languages} title="Languages" note={`${num(s.languages_used)} used`}>
          <BarList rows={s.languages.map((l) => ({ ...l, name: langName(l.key) }))} value={(r) => r.count} right={(r) => num(r.count)} empty="No language detected in this range." />
        </Panel>
        <Panel icon={CalendarDays} title="When you work" note="by weekday and hour">
          <Heatmap grid={s.heatmap} />
        </Panel>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel icon={Trophy} title="Records" note="all time">
          <Facts
            rows={[
              [Flame, "Current streak", `${num(s.records.streak)} day${s.records.streak === 1 ? "" : "s"}`],
              [Trophy, "Longest streak", `${num(s.records.longest_streak)} day${s.records.longest_streak === 1 ? "" : "s"}`],
              [CalendarDays, "Days active", num(s.records.active_days)],
              [Activity, "Busiest day", s.records.busiest_day ? `${day(s.records.busiest_day.date, { month: "short", day: "numeric", year: "numeric" })} · ${num(s.records.busiest_day.count)} things` : "–"],
              [Timer, "Longest render", s.records.longest_speech_s ? dur(s.records.longest_speech_s) : "–"],
              [Gauge, "Fastest render", s.records.fastest_speed ? `${s.records.fastest_speed}× real time` : "–"],
              [AudioLines, "Audio made, ever", dur(s.records.all_time_audio_s)],
              [Keyboard, "Words dictated, ever", s.dictation ? `${num(s.dictation.all_time.words)} · ${dur(s.dictation.all_time.saved_s)} saved` : "–"],
              [Flame, "Dictation streak", s.dictation ? `${num(s.dictation.streak)} day${s.dictation.streak === 1 ? "" : "s"}` : "–"],
              [Clock, "Using FireVoice since", s.records.first_use ? new Date(s.records.first_use * 1000).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "–"],
            ]}
          />
        </Panel>
        <Panel icon={Library} title="Library" note="right now">
          <Facts
            rows={[
              [Mic, "Voices", `${num(s.library.voices)} · ${num(s.library.cloned)} cloned · ${num(s.library.designed)} designed`],
              [Languages, "Voice languages", num(s.library.voice_languages)],
              [Palette, "Styles", `${num(s.library.styles)}${s.library.custom_styles ? ` · ${num(s.library.custom_styles)} yours` : ""}`],
              [BookOpen, "Projects", `${num(s.library.projects)} · ${num(s.library.chapters)} chapters · ${num(s.library.project_words)} words`],
              [Type, "Dictionary words", num(s.library.dictionary_rules)],
              [MessageSquareQuote, "Snippets", num(s.library.snippets ?? 0)],
              [Sparkles, "Saved in History", num(s.library.history_items + s.library.kept_renders)],
              [Cpu, "Voice engines installed", `${num(s.library.engines_ready)} of ${num(s.library.engines_total)}`],
              [Zap, "GPU time", dur(t.gpu_s)],
            ]}
          />
        </Panel>
        <Panel icon={HardDrive} title="On this computer" note={fmtBytes(s.storage.data_total)}>
          <Storage folders={s.storage.folders} total={s.storage.data_total} />
        </Panel>
      </div>

      {s.errors.length > 0 && (
        <Panel icon={TriangleAlert} title="What went wrong" note={`${num(t.failed)} failed ${rangeLabel}`}>
          <ul className="space-y-1.5">
            {s.errors.map((e) => (
              <li key={e.message} className="flex items-start gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]">
                <span className="mt-0.5 shrink-0 rounded-full bg-bad-soft px-2 text-[11px] font-semibold text-bad tabular">{e.count}×</span>
                <span className="text-ink-2">{e.message}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/** Home while its numbers load: every section in place at its size, so the page does not move when they arrive. */
function HomeSkeleton() {
  const card = (cls: string, children?: ReactNode) => <Card className={cn("p-4", cls)}>{children}</Card>;
  const lines = (n: number) => (
    <div className="space-y-4">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-1.5 w-full" />
        </div>
      ))}
    </div>
  );
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="grid gap-4 lg:grid-cols-12">
        {card(
          "min-h-[308px] lg:col-span-8",
          <div className="space-y-5">
            <Skeleton className="h-8 w-40" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-7 w-24" />
                  <Skeleton className="h-3 w-28" />
                </div>
              ))}
            </div>
            <Skeleton className="h-24 w-full" />
          </div>,
        )}
        {card(
          "min-h-[308px] lg:col-span-4",
          <div className="space-y-5">
            <Skeleton className="h-5 w-24" />
            <div className="flex items-center gap-4">
              <Skeleton className="size-[88px] rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-2/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
          </div>,
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i}>
            {card(
              "min-h-[120px]",
              <div className="space-y-3">
                <Skeleton className="h-6 w-28" />
                <Skeleton className="h-7 w-24" />
                <Skeleton className="h-3 w-36" />
              </div>,
            )}
          </div>
        ))}
      </div>
      {card("min-h-[314px]", <Skeleton className="h-full min-h-[260px] w-full" />)}
      {[0, 1, 2].map((row) => (
        <div key={row} className="grid gap-4 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i}>{card("min-h-[430px]", lines(7))}</div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- dictation
/** Dictation in numbers: words, time saved against typing, speaking speed, how often; words per day and where they
 * went. Before the first dictation, an invitation to try it. */
function DictationHero({ d, daily, rangeLabel }: { d: DictationStats | null; daily: string[]; rangeLabel: string }) {
  const enabled = useDictation((x) => x.config.enabled);
  const hotkey = useDictation((x) => x.config.hotkey);
  const [hover, setHover] = useState<number | null>(null);
  const keys = (
    <span className="inline-flex items-center gap-1 align-middle">
      {hotkeyLabels(hotkey).map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </span>
  );

  if (!d || d.all_time.count === 0) {
    return (
      <Card raised className="relative h-full overflow-hidden p-6">
        <div className="pointer-events-none absolute -top-28 -right-24 size-72 rounded-full bg-fire/12 blur-3xl" aria-hidden />
        <div className="relative flex h-full flex-col justify-between gap-6">
          <div>
            <span className="grid size-11 place-items-center rounded-[12px] fire-gradient text-white shadow-[0_8px_20px_-8px_rgba(255,90,45,0.8)]">
              <Keyboard className="size-5" />
            </span>
            <h2 className="mt-4 text-[20px] font-semibold tracking-[-0.01em] text-ink">Type with your voice, in any app</h2>
            <p className="mt-1.5 max-w-[52ch] text-[13.5px] leading-relaxed text-muted">
              {enabled ? (
                <>Press {keys} in a chat, an email or a document and speak. What you dictate is counted here: words, time saved and where they went.</>
              ) : (
                "Turn on dictation and speak where you would type. FireVoice writes what you meant, punctuated, on this computer."
              )}
            </p>
          </div>
          <Link to="/dictation" className="inline-flex w-fit items-center gap-1.5 text-[13px] font-medium text-fire hover:underline">
            {enabled ? "Dictation settings" : "Set up dictation"} <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </Card>
    );
  }

  const byDate = new Map(d.daily.map((x) => [x.date, x]));
  const days = daily.length ? daily : d.daily.map((x) => x.date);
  const series = days.map((date) => byDate.get(date)?.words ?? 0);
  const max = Math.max(1, ...series);
  const h = hover !== null ? days[hover] : null;
  const faster = d.wpm ? Math.round((d.wpm / d.typing_wpm) * 10) / 10 : null;
  const big: { label: string; value: string; sub: string }[] = [
    { label: "Words dictated", value: num(d.words), sub: `${num(d.count)} dictation${d.count === 1 ? "" : "s"} ${rangeLabel}` },
    { label: "Time saved", value: dur(d.saved_s), sub: `against typing at ${d.typing_wpm} words a minute` },
    { label: "Speaking speed", value: d.wpm ? `${d.wpm}` : "–", sub: d.wpm ? `words a minute${faster && faster > 1 ? `, ${faster}× typing` : ""}` : "after a few dictations" },
    {
      label: "Streak",
      value: `${num(d.streak)} day${d.streak === 1 ? "" : "s"}`,
      sub: [d.translations ? `${num(d.translations)} translated` : "", d.commands ? `${num(d.commands)} edits by voice` : ""].filter(Boolean).join(" · ") || "days in a row with a dictation",
    },
  ];

  return (
    <Card raised className="relative h-full overflow-hidden p-5">
      <div className="pointer-events-none absolute -top-28 -right-24 size-72 rounded-full bg-fire/10 blur-3xl" aria-hidden />
      <div className="relative">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2.5 text-[15px] font-semibold text-ink">
            <span className="grid size-8 place-items-center rounded-[9px] fire-gradient text-white">
              <Keyboard className="size-4" />
            </span>
            Dictation
          </h2>
          <Link to="/dictation" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-fire hover:underline">
            Open <ArrowRight className="size-3.5" />
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
          {big.map((b, i) => (
            <div key={b.label} className={cn("min-w-0", i > 0 && "sm:border-l sm:border-line sm:pl-4")}>
              <span className="block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">{b.label}</span>
              <span className={cn("mt-1 block text-[26px] leading-none font-semibold tracking-[-0.02em] tabular", i === 0 ? "text-fire" : "text-ink")}>{b.value}</span>
              <span className="mt-1 block text-[11.5px] leading-snug text-muted">{b.sub}</span>
            </div>
          ))}
        </div>
        <div className="mt-5 grid gap-5 sm:grid-cols-[1fr_200px]">
          <div>
            <div className="mb-1.5 flex h-4 items-baseline justify-between text-[11.5px] text-muted">
              <span>Words per day</span>
              {h && <span className="text-ink tabular">{day(h)} · {num(series[hover!])} words</span>}
            </div>
            <div className="flex h-20 items-end gap-[2px] border-b border-line" onMouseLeave={() => setHover(null)}>
              {series.map((v, i) => (
                <div key={days[i]} className="flex h-full flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)} aria-label={`${day(days[i])}: ${v} words`}>
                  <div
                    className={cn("rounded-t-[3px] bg-fire transition-opacity", hover !== null && hover !== i && "opacity-40", v === 0 && "bg-surface-3")}
                    style={{ height: v ? `${Math.max(6, (v / max) * 100)}%` : "2px" }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1.5 block text-[11.5px] text-muted">Where it went</span>
            {d.apps.length ? (
              <ul className="space-y-1.5">
                {d.apps.slice(0, 4).map((a) => (
                  <li key={a.key} className="flex items-center gap-2 text-[12.5px]">
                    <span className="truncate font-medium text-ink">{a.name}</span>
                    <span className="ml-auto shrink-0 text-muted tabular">{num(a.words)} words</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-faint">Nothing {rangeLabel}.</p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------- pieces
function Tile({ icon: I, label, value, sub, accent }: { icon: Icon; label: string; value: string; sub: string; accent?: boolean }) {
  return (
    <Card className="flex min-h-[120px] flex-col gap-2 p-4">
      <span className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        <span className={cn("flex size-7 items-center justify-center rounded-lg", accent ? "bg-fire-soft text-fire" : "bg-surface-3 text-ink-2")}>
          <I className="size-[15px]" />
        </span>
        {label}
      </span>
      <span className="text-[26px] leading-none font-semibold tracking-[-0.02em] text-ink tabular">{value}</span>
      <span className="text-[12px] leading-snug text-muted">{sub}</span>
    </Card>
  );
}

function Panel({ icon: I, title, note, children }: { icon: Icon; title: string; note?: string; children: ReactNode }) {
  return (
    <Card className="flex min-h-[430px] flex-col p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <I className="size-4 shrink-0 text-fire" />
          {title}
        </h3>
        {note && <span className="text-[12px] text-faint tabular">{note}</span>}
      </div>
      {children}
    </Card>
  );
}

/** Ranked horizontal bars: one series, so one colour and no legend; the value is printed beside each bar. */
function BarList({ rows, value, right, empty }: { rows: StatRow[]; value: (r: StatRow) => number; right: (r: StatRow) => string; empty: string }) {
  const max = Math.max(1, ...rows.map(value));
  if (!rows.length) return <p className="py-6 text-center text-[13px] text-muted">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} title={`${r.name ?? r.key}: ${right(r)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="truncate font-medium text-ink">{r.name ?? r.key}</span>
            <span className="shrink-0 text-muted tabular">{right(r)}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full rounded-full bg-fire transition-[width] duration-500" style={{ width: `${Math.max(2, (value(r) / max) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Facts({ rows }: { rows: [Icon, string, string][] }) {
  return (
    <dl className="divide-y divide-line/60">
      {rows.map(([I, k, v]) => (
        <div key={k} className="flex items-center gap-3 py-2 text-[13px]">
          <I className="size-4 shrink-0 text-faint" />
          <dt className="text-muted">{k}</dt>
          <dd className="ml-auto text-right font-medium text-ink tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Audio made per day, stacked by kind (fixed colours, legend above, a tooltip per day). */
function ActivityChart({ s }: { s: Stats }) {
  const [hover, setHover] = useState<number | null>(null);
  const groups = s.groups.filter((g) => s.daily.some((d) => d[g] > 0));
  const totals = s.daily.map((d) => groups.reduce((a, g) => a + d[g], 0));
  const max = Math.max(1, ...totals);
  const ticks = useMemo(() => {
    const step = niceStep(max / 3);
    return [step, step * 2, step * 3].filter((v) => v <= max * 1.05);
  }, [max]);
  const top = Math.max(max, ticks[ticks.length - 1] ?? max);
  const h = s.daily[hover ?? -1];
  const many = s.daily.length > 45;

  return (
    <Card className="min-h-[314px] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[14px] font-semibold text-ink">
          <Activity className="size-4 shrink-0 text-fire" />
          Audio made per day
        </h3>
        {groups.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Legend">
            {groups.map((g) => (
              <li key={g} className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <span className="size-2.5 rounded-[3px]" style={{ background: GROUP[g].color }} />
                {GROUP[g].label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {groups.length === 0 ? (
        <p className="py-16 text-center text-[13px] text-muted">Nothing made in this range yet. Your work shows up here day by day.</p>
      ) : (
        <div className="relative">
          <div className="relative ml-12 h-56" onMouseLeave={() => setHover(null)}>
            {/* recessive grid with labels */}
            {ticks.map((v) => (
              <div key={v} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `${(v / top) * 100}%` }}>
                <span className="absolute -top-2 -left-12 w-10 text-right text-[10.5px] whitespace-nowrap text-faint tabular">{short(v)}</span>
              </div>
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px] border-b border-line-strong">
              {s.daily.map((d, i) => (
                <div
                  key={d.date}
                  className="group relative flex h-full flex-1 cursor-default flex-col justify-end"
                  onMouseEnter={() => setHover(i)}
                  aria-label={`${day(d.date)}: ${dur(totals[i])}`}
                >
                  <div className={cn("flex flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px] transition-opacity", hover !== null && hover !== i && "opacity-45")} style={{ height: `${(totals[i] / top) * 100}%` }}>
                    {groups.map((g) =>
                      d[g] > 0 ? <div key={g} style={{ flexGrow: d[g], flexBasis: 0, background: GROUP[g].color, minHeight: 2 }} /> : null,
                    )}
                  </div>
                </div>
              ))}
            </div>
            {h && (
              <div
                className={cn(
                  "surface-raised pointer-events-none absolute z-10 w-52 rounded-xl p-3 text-[12px]",
                  // anchored inward near either edge so it never leaves the card
                  hover! / s.daily.length > 0.8 ? "-translate-x-full" : hover! / s.daily.length < 0.2 ? "" : "-translate-x-1/2",
                )}
                style={{ left: `${((hover! + 0.5) / s.daily.length) * 100}%`, bottom: "calc(100% + 8px)" }}
              >
                <p className="mb-1.5 font-semibold text-ink">{day(h.date, { weekday: "short", month: "short", day: "numeric" })}</p>
                {groups.filter((g) => h[g] > 0).map((g) => (
                  <p key={g} className="flex items-center gap-2 text-ink-2">
                    <span className="size-2 rounded-[2px]" style={{ background: GROUP[g].color }} />
                    {GROUP[g].label}
                    <span className="ml-auto text-ink tabular">{dur(h[g])}</span>
                  </p>
                ))}
                <p className="mt-1.5 flex border-t border-line pt-1.5 text-muted">
                  {num(h.count)} thing{h.count === 1 ? "" : "s"} made <span className="ml-auto font-medium text-ink tabular">{dur(totals[hover!])}</span>
                </p>
              </div>
            )}
          </div>
          <div className="mt-1.5 ml-12 flex justify-between text-[10.5px] text-faint tabular">
            {[0, Math.floor(s.daily.length / 2), s.daily.length - 1].map((i) => (
              <span key={i}>{s.daily[i] ? day(s.daily[i].date) : ""}</span>
            ))}
          </div>
          {many && <p className="mt-1 text-right text-[11px] text-faint">Showing the last {s.daily.length} days</p>}
        </div>
      )}
    </Card>
  );
}

function niceStep(raw: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000, 36000];
  return steps.find((v) => v >= raw) ?? Math.ceil(raw / 3600) * 3600;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** When you work: counts by weekday x hour on a one-hue ramp (darker is busier in light mode). */
function Heatmap({ grid }: { grid: number[][] }) {
  const [hover, setHover] = useState<[number, number] | null>(null);
  const max = Math.max(0, ...grid.flat());
  const level = (v: number) => (v === 0 || max === 0 ? 0 : Math.min(6, 1 + Math.floor((v / max) * 5.999)));
  if (max === 0) return <p className="py-6 text-center text-[13px] text-muted">No activity in this range yet.</p>;
  const hv = hover ? grid[hover[0]][hover[1]] : null;
  return (
    <div onMouseLeave={() => setHover(null)}>
      <div className="grid grid-cols-[28px_repeat(24,minmax(0,1fr))] gap-[2px]">
        {grid.map((row, d) => (
          <div key={d} className="contents">
            <span className="pr-1 text-right text-[10px] leading-[14px] text-faint">{d % 2 === 0 ? DAYS[d] : ""}</span>
            {row.map((v, hr) => (
              <span
                key={hr}
                onMouseEnter={() => setHover([d, hr])}
                className={cn("h-[14px] rounded-[3px]", hover && hover[0] === d && hover[1] === hr && "ring-2 ring-ink/40")}
                style={{ background: level(v) ? `var(--seq-${level(v)})` : "var(--surface-3)" }}
                aria-label={`${DAYS[d]} ${hr}:00, ${v}`}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-[28px_repeat(24,minmax(0,1fr))] text-[10px] text-faint tabular">
        <span />
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i} className="text-center">{i % 6 === 0 ? i : ""}</span>
        ))}
      </div>
      <p className="mt-2 h-4 text-[12px] text-muted">
        {hover ? `${DAYS[hover[0]]}s around ${hover[1]}:00 · ${hv} thing${hv === 1 ? "" : "s"}` : "Hover a square for the count"}
      </p>
    </div>
  );
}

const FOLDER: Record<string, string> = { voices: "Voices", speech: "Speech renders", history: "History", jobs: "Jobs", projects: "Projects", logs: "Logs" };

/** Disk use per folder: one stacked bar (fixed colours) and a list with sizes. */
function Storage({ folders, total }: { folders: Record<string, number>; total: number }) {
  const rows = Object.entries(folders).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const color = (k: string) => `var(--series-${["voices", "speech", "history", "jobs", "projects", "logs"].indexOf(k) + 1})`;
  if (!rows.length) return <p className="py-6 text-center text-[13px] text-muted">Nothing stored yet.</p>;
  return (
    <div>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-[4px]">
        {rows.map(([k, v]) => (
          <div key={k} title={`${FOLDER[k] ?? k}: ${fmtBytes(v)}`} style={{ flexGrow: v, flexBasis: 0, background: color(k), minWidth: 3 }} />
        ))}
      </div>
      <ul className="mt-3 space-y-1.5">
        {rows.map(([k, v]) => (
          <li key={k} className="flex items-center gap-2 text-[13px]">
            <span className="size-2.5 rounded-[3px]" style={{ background: color(k) }} />
            <span className="text-ink-2">{FOLDER[k] ?? k}</span>
            <span className="ml-auto font-medium text-ink tabular">{fmtBytes(v)}</span>
            <span className="w-10 text-right text-[11.5px] text-faint tabular">{Math.round((v / Math.max(1, total)) * 100)}%</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11.5px] text-faint">Engines and their models are not included.</p>
    </div>
  );
}
