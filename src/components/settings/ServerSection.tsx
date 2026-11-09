import { useEffect, useState } from "react";
import { Eye, EyeOff, RefreshCw } from "lucide-react";
import { Button, Card, CardBody, CardHeader, Input, Label } from "@/components/ui";
import { useHealth } from "@/lib/api/hooks";
import { useSettings } from "@/stores/settings";
import { cn } from "@/lib/utils";

export function ServerSection() {
  const serverUrl = useSettings((s) => s.serverUrl);
  const token = useSettings((s) => s.token);
  const setServerUrl = useSettings((s) => s.setServerUrl);
  const setToken = useSettings((s) => s.setToken);
  const health = useHealth();

  const [draftUrl, setDraftUrl] = useState(serverUrl);
  const [showToken, setShowToken] = useState(false);
  useEffect(() => setDraftUrl(serverUrl), [serverUrl]);

  const commitUrl = () => {
    const v = draftUrl.trim();
    if (v && v !== serverUrl) setServerUrl(v);
    else setDraftUrl(serverUrl);
  };

  const online = health.isSuccess;
  const status = online ? "online" : health.isLoading || health.isFetching ? "connecting" : "offline";

  return (
    <Card>
      <CardHeader title="Server" description="Where the app sends its requests." />
      <CardBody className="space-y-5">
        <div>
          <Label htmlFor="server-url">Server URL</Label>
          <Input
            id="server-url"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            onBlur={commitUrl}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            placeholder="http://127.0.0.1:8787"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-[13px]"
          />
        </div>

        <div>
          <Label htmlFor="server-token" hint="only if the server was started with --token">
            API token
          </Label>
          <Input
            id="server-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="none"
            autoComplete="off"
            className="font-mono text-[13px]"
            trailing={
              <button
                type="button"
                aria-label={showToken ? "Hide token" : "Show token"}
                onClick={() => setShowToken((v) => !v)}
                className="flex size-7 items-center justify-center rounded-sm text-muted hover:text-ink"
              >
                {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            }
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-4 py-3">
          <div className="flex items-center gap-2.5 text-[13px]">
            <span
              className={cn(
                "size-2 rounded-full",
                online ? "bg-ok shadow-[0_0_0_3px_var(--ok-soft)]" : status === "connecting" ? "bg-warn animate-pulse" : "bg-bad shadow-[0_0_0_3px_var(--bad-soft)]",
              )}
              aria-hidden
            />
            <span className="font-medium text-ink capitalize">{status}</span>
            {online && (
              <span className="text-muted">
                · FireVoice {health.data.version} · auth {health.data.auth ? "on" : "off"}
              </span>
            )}
            {health.isError && <span className="text-muted">· no response from {serverUrl}</span>}
          </div>
          <Button size="sm" variant="outline" leading={<RefreshCw className="size-3.5" />} loading={health.isFetching} onClick={() => void health.refetch()}>
            Test connection
          </Button>
        </div>

        <p className="text-[12.5px] leading-relaxed text-muted">
          In development the app talks to <code className="rounded-sm bg-surface-3 px-1 py-0.5 font-mono text-[12px] text-ink-2">firevoice serve</code> from the
          sibling firevoice repo. Packaged builds will embed the server.
        </p>
      </CardBody>
    </Card>
  );
}
