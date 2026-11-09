import { Link, useLocation } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useHealth } from "@/lib/api/hooks";
import { useSettings } from "@/stores/settings";

/** Shown at the top of every view except Home (which has its own offline card) while the server is unreachable. */
export function OfflineBanner() {
  const health = useHealth();
  const server = useSettings((s) => s.serverUrl);
  const { pathname } = useLocation();
  const qc = useQueryClient();
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
              Can’t reach the FireVoice server at <span className="font-mono">{server}</span>. Start it with{" "}
              <code className="font-mono">firevoice serve</code> in the backend folder.
            </span>
            <button
              type="button"
              onClick={() => {
                void health.refetch();
                void qc.invalidateQueries();
              }}
              className="flex items-center gap-1.5 font-medium hover:underline"
            >
              <RefreshCw className="size-3.5" /> Retry
            </button>
            <Link to="/settings" className="font-medium hover:underline">
              Settings
            </Link>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
