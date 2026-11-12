import { useLocation } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw, TriangleAlert } from "@/components/icons";
import { useHealth } from "@/lib/api/hooks";
import { inTauri } from "@/lib/backend";
import { useBackend } from "@/stores/backend";

/** Shown at the top of every view except Home (which has its own offline card) while the server is unreachable. */
export function OfflineBanner() {
  const retry = async () => {
    if (inTauri()) await useBackend.getState().start().catch(() => undefined);
    void health.refetch();
  };
  const health = useHealth();
  const { pathname } = useLocation();
  const show = health.isError && pathname !== "/";

  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          role="alert"
          initial={{ opacity: 0, height: 0, marginBottom: 0 }}
          animate={{ opacity: 1, height: "auto", marginBottom: 16 }}
          exit={{ opacity: 0, height: 0, marginBottom: 0 }}
          className="mx-auto max-w-[1400px] overflow-hidden"
        >
          <div className="flex items-center gap-3 rounded-xl bg-bad-soft px-4 py-3 text-[13px] text-bad">
            <TriangleAlert className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">
              FireVoice’s voice engine isn’t answering yet. It may still be starting; press Retry in a moment.
            </span>
            <button
              type="button"
              onClick={() => void retry()}
              className="flex items-center gap-1.5 font-medium hover:underline"
            >
              <RefreshCw className="size-3.5" /> Retry
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
