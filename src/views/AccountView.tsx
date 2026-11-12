import { useState } from "react";
import { Navigate } from "react-router";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, LogOut, Mail, ShieldCheck, Sparkles } from "@/components/icons";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge, Button, Card, CardBody, CardHeader, Skeleton } from "@/components/ui";
import { inTauri } from "@/lib/backend";
import { cloud, useCloud, useSetCloud } from "@/lib/cloud";

/** The account this app is signed in to. Signing in, the password and deleting the account live on the website; the
 * app shows who it is, the plan, and signs out. Signed out, the page is not shown (the title bar's person button signs
 * in). */
export function AccountView() {
  const status = useCloud(true);
  const set = useSetCloud();
  const [busy, setBusy] = useState(false);
  const license = useQuery({ queryKey: ["cloud-license"], queryFn: cloud.license, staleTime: 5 * 60_000, retry: false, enabled: inTauri() });
  const s = status.data;

  if (!inTauri()) return <Navigate to="/" replace />;
  if (!s)
    return (
      <div className="page-width">
        <Skeleton className="mt-24 h-72 rounded-2xl" />
      </div>
    );
  if (!s.signedIn || !s.user) return <Navigate to="/" replace />;
  const u = s.user;
  const plan = license.data?.licensing ? (license.data.plan === "pro" ? "Pro" : license.data.plan === "team" ? "Team" : "Free") : "Free";

  const signOut = async () => {
    setBusy(true);
    try {
      set(await cloud.signOut());
      toast.success("Signed out");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-width fade-up">
      <PageHeader title="Account" subtitle="The FireVoice account this app is signed in to." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader
            title="Signed in"
            action={
              <Button size="sm" variant="ghost" leading={<LogOut className="size-4" />} loading={busy} onClick={() => void signOut()}>
                Sign out
              </Button>
            }
          />
          <CardBody className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="grid size-12 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-fire-2 to-fire text-[18px] font-semibold text-white">
                {u.avatarUrl ? <img src={u.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-full object-cover" /> : (u.name || u.email).slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium text-ink">{u.name || u.email}</div>
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted">
                  <span className="truncate">{u.email}</span>
                  {u.verified ? <Badge tone="ok">confirmed</Badge> : <Badge tone="warn">not confirmed</Badge>}
                  {u.google && <Badge>Google</Badge>}
                </div>
              </div>
            </div>
            {!u.verified && (
              <div className="flex items-center gap-2 rounded-[12px] bg-surface-2 px-3.5 py-3 text-[13px] text-ink-2">
                <Mail className="size-4 shrink-0 text-muted" />
                Confirm your email with the link we sent. You can send it again from your account on the website.
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-surface-2 px-3.5 py-3">
              <span className="text-[13px] text-ink-2">Your name, password and deleting the account are on the website.</span>
              <Button size="sm" variant="outline" leading={<ExternalLink className="size-3.5" />} onClick={() => void cloud.open("account")}>
                Manage account
              </Button>
            </div>
          </CardBody>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardBody className="space-y-2 pt-5">
              <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] text-muted uppercase">
                <Sparkles className="size-3.5" /> Plan
              </div>
              <div className="text-[22px] font-semibold tracking-tight text-ink">{plan}</div>
              <p className="text-[13px] leading-relaxed text-ink-2">FireVoice is free for everyone right now. Every feature is included, with no limits.</p>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="space-y-1.5 pt-5 text-[13px] text-ink-2">
              <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] text-muted uppercase">
                <ShieldCheck className="size-3.5" /> This computer
              </div>
              <p>{typeof s.installs === "number" ? `${s.installs} computer${s.installs === 1 ? "" : "s"} signed in to this account.` : "Signed in on this computer."}</p>
              <p className="text-[12px] text-faint">
                {s.consent ? "Usage statistics from this computer are linked to your account." : "Usage sharing is off on this computer (Settings, Privacy)."}
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
