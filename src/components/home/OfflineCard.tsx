import { useNavigate } from "react-router";
import { PlugZap, RefreshCw, Settings } from "lucide-react";
import { Button, Card } from "@/components/ui";
import { useSettings } from "@/stores/settings";

export function OfflineCard({ onRetry, retrying }: { onRetry: () => void; retrying?: boolean }) {
  const serverUrl = useSettings((s) => s.serverUrl);
  const navigate = useNavigate();
  return (
    <Card raised className="mx-auto mt-6 max-w-2xl overflow-hidden rounded-2xl fade-up">
      <div className="flex flex-col gap-6 p-7 sm:flex-row sm:items-start">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-bad-soft text-bad">
          <PlugZap className="size-7" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">The FireVoice server is offline</h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
            The app renders through the local HTTP API. Start it in the backend folder, then come back here.
          </p>
          <pre className="mt-4 overflow-x-auto rounded-lg border border-line bg-surface-2 px-4 py-3 font-mono text-[12.5px] text-ink-2">
            firevoice serve
          </pre>
          <p className="mt-3 text-[12.5px] text-muted">
            Waiting on <span className="font-mono text-ink-2">{serverUrl}</span>
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={onRetry} loading={retrying} leading={<RefreshCw className="size-4" />}>
              Retry
            </Button>
            <Button variant="outline" leading={<Settings className="size-4" />} onClick={() => navigate("/settings")}>
              Server settings
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
