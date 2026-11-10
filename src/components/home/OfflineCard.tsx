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
          <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">FireVoice is not running yet</h2>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted">
            The part of FireVoice that makes the voices is not answering. It normally starts with the app, so give it a moment and press Retry.
            If it still does not come up, open Settings to start or repair it.
          </p>
          <p className="mt-3 text-[12.5px] text-muted">
            Trying to reach <span className="font-mono text-ink-2">{serverUrl}</span>
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={onRetry} loading={retrying} leading={<RefreshCw className="size-4" />}>
              Retry
            </Button>
            <Button variant="outline" leading={<Settings className="size-4" />} onClick={() => navigate("/settings")}>
              Open Settings
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
