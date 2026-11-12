import { Check, GraduationCap, Sparkles } from "@/components/icons";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { WakeTeaching } from "@/lib/api/types";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

const KEY = ["dictation-wake"];
const ATTEMPTS = 5;

/** Teaching "Hey FireVoice" your voice: say it a few times; the forms the speech model hears for your voice ("Hey
 * Fireboys") that did not wake it yet are kept, and wake it from then on. The listener that is already running hears
 * the attempts (so it learns from exactly what it hears), and while teaching it does not start dictations. */
export function DictationWakeTeach() {
  const qc = useQueryClient();
  const state = useQuery({
    queryKey: KEY,
    queryFn: api.dictationWake,
    refetchInterval: (q) => ((q.state.data as WakeTeaching | undefined)?.active ? 600 : false),
  });
  const set = (d: WakeTeaching) => qc.setQueryData(KEY, d);
  const teach = useMutation({ mutationFn: api.teachWake, onSuccess: set, onError: (e) => toast.error(errMessage(e)) });
  const forget = useMutation({ mutationFn: api.forgetWake, onSuccess: set, onError: (e) => toast.error(errMessage(e)) });

  const d = state.data;
  const attempts = (d?.attempts ?? []).filter((a) => a.heard);
  const forms = d?.forms ?? [];
  const learnable = attempts.filter((a) => a.form && !a.wakes).length;

  if (!d?.active) {
    return (
      <div className="ml-12 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-surface-2 px-3.5 py-3">
        <div className="min-w-0">
          <span className="block text-[13px] font-medium text-ink">Not waking every time?</span>
          <span className="block text-[12px] text-muted">
            {forms.length
              ? `Learned from your voice: ${forms.join(", ")}.`
              : "Say it a few times and FireVoice learns how it sounds in your voice and accent."}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {forms.length > 0 && (
            <Button size="sm" variant="ghost" disabled={forget.isPending} onClick={() => forget.mutate()}>
              Forget
            </Button>
          )}
          <Button size="sm" variant="soft" leading={<GraduationCap className="size-4" />} disabled={teach.isPending} onClick={() => teach.mutate("start")}>
            Teach it your voice
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ml-12 space-y-3 rounded-[12px] border border-fire/25 bg-fire-soft/40 px-3.5 py-3">
      <div>
        <span className="block text-[13px] font-medium text-ink">Say “Hey FireVoice” {ATTEMPTS} times, with a short pause after each</span>
        <span className="block text-[12px] text-muted">Say it the way you normally would. Nothing is typed while it listens.</span>
      </div>
      <div className="flex gap-1.5" aria-label={`${Math.min(attempts.length, ATTEMPTS)} of ${ATTEMPTS}`}>
        {Array.from({ length: ATTEMPTS }, (_, i) => (
          <span key={i} className={cn("h-1.5 flex-1 rounded-full transition-colors", i < attempts.length ? "bg-fire" : "bg-surface-3")} />
        ))}
      </div>
      {attempts.length > 0 && (
        <ul className="space-y-1">
          {attempts.map((a, i) => (
            <li key={i} className="flex items-center gap-2 text-[12.5px]">
              {a.wakes ? <Check className="size-3.5 text-ok" /> : a.form ? <Sparkles className="size-3.5 text-fire" /> : <span className="size-3.5" />}
              <span className="text-ink-2">“{a.heard}”</span>
              <span className="text-faint">{a.wakes ? "already wakes it" : a.form ? "will be learned" : "not the phrase"}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={teach.isPending} onClick={() => teach.mutate("cancel")}>
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={teach.isPending || attempts.length === 0}
          onClick={() =>
            teach.mutate("save", {
              onSuccess: () =>
                toast.success(learnable ? "FireVoice learned how you say it" : "It already understands how you say it", {
                  description: learnable ? undefined : "Nothing new to learn: every attempt woke it.",
                }),
            })
          }
        >
          Done
        </Button>
      </div>
    </div>
  );
}
