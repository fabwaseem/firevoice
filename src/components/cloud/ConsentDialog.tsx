import { useState } from "react";
import { toast } from "sonner";
import * as RD from "@radix-ui/react-dialog";
import { Check, ShieldCheck, X } from "@/components/icons";
import { Button } from "@/components/ui";
import { cloud, useCloud, useSetCloud } from "@/lib/cloud";

const SITE = "https://firevoice.fabwaseem.com";

/** Asked once, on the first launch: may FireVoice send usage statistics? Until it is answered nothing is sent; the
 * answer can be changed any time in Settings, Privacy. */
export function ConsentDialog() {
  const status = useCloud();
  const set = useSetCloud();
  const [busy, setBusy] = useState<null | "yes" | "no">(null);
  const open = status.data?.consent === null;

  const answer = async (on: boolean) => {
    setBusy(on ? "yes" : "no");
    try {
      set(await cloud.consent(on));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <RD.Root open={open}>
      <RD.Portal>
        <RD.Overlay className="fixed inset-0 z-[60] bg-ink/30 backdrop-blur-[3px] dark:bg-black/55" />
        <RD.Content
          onEscapeKeyDown={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className="surface-raised fixed top-1/2 left-1/2 z-[60] w-[calc(100vw-32px)] max-w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-2xl p-6 shadow-lg focus:outline-none data-[state=open]:animate-[fade-up_0.3s_var(--ease-out-quart)]"
        >
          <div className="grid size-11 place-items-center rounded-[14px] bg-fire-soft text-fire">
            <ShieldCheck className="size-6" variant="duotone" />
          </div>
          <RD.Title className="mt-4 text-[19px] font-semibold tracking-[-0.01em] text-ink">Help make FireVoice better?</RD.Title>
          <RD.Description className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
            FireVoice can send usage statistics so we can see what to fix and improve next. You can change this any time in
            Settings, Privacy.
          </RD.Description>

          <div className="mt-4 grid gap-3 rounded-xl bg-surface-2 p-4 text-[13px] leading-relaxed">
            <div className="flex gap-2.5">
              <Check className="mt-0.5 size-4 shrink-0 text-ok" />
              <span className="text-ink-2">
                <b className="font-medium text-ink">Sent:</b> features you use, app and computer details, crash reports.
              </span>
            </div>
            <div className="flex gap-2.5">
              <X className="mt-0.5 size-4 shrink-0 text-fire" />
              <span className="text-ink-2">
                <b className="font-medium text-ink">Never sent:</b> what you dictate or type, your recordings, your voices, or your files.
                Those stay on this computer.
              </span>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <a href={`${SITE}/privacy`} target="_blank" rel="noreferrer" className="text-[12.5px] text-muted underline-offset-4 hover:text-ink hover:underline">
              Privacy policy
            </a>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={!!busy} loading={busy === "no"} onClick={() => void answer(false)}>
                No thanks
              </Button>
              <Button disabled={!!busy} loading={busy === "yes"} onClick={() => void answer(true)}>
                Share usage
              </Button>
            </div>
          </div>
        </RD.Content>
      </RD.Portal>
    </RD.Root>
  );
}
