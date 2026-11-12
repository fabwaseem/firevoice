import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { CircleUser, LogOut, Mail, ShieldCheck, Sparkles } from "@/components/icons";
import { PageHeader } from "@/components/shell/PageHeader";
import { Badge, Button, Card, CardBody, CardHeader, Dialog, Input, Label, Segmented, Skeleton } from "@/components/ui";
import { inTauri } from "@/lib/backend";
import { cloud, useCloud, useSetCloud, type CloudStatus } from "@/lib/cloud";

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The FireVoice account: optional. Sign in to keep your computers together and send feedback as you; FireVoice is
 * free for everyone right now, so there is no plan to buy. */
export function AccountView() {
  const status = useCloud(true);
  const s = status.data;
  return (
    <div className="page-width fade-up">
      <PageHeader title="Account" subtitle="Optional. FireVoice works the same without one, and it is free for everyone right now." />
      {!inTauri() ? (
        <Card>
          <CardBody className="pt-5 text-[13.5px] text-muted">Accounts are available in the desktop app.</CardBody>
        </Card>
      ) : !s ? (
        <Skeleton className="h-72 rounded-2xl" />
      ) : s.signedIn && s.user ? (
        <SignedIn s={s} />
      ) : (
        <SignInCard />
      )}
    </div>
  );
}

function SignInCard() {
  const set = useSetCloud();
  const [mode, setMode] = useState<"login" | "signup" | "forgot">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "").trim();
    const password = String(f.get("password") ?? "");
    setBusy(true);
    setError(null);
    try {
      if (mode === "forgot") {
        await cloud.forgot(email);
        setSent(true);
      } else {
        const s = await cloud.signIn(mode, email, password, String(f.get("name") ?? "").trim() || undefined);
        set(s);
        toast.success(mode === "signup" ? "Your account is ready" : "Signed in", {
          description: mode === "signup" ? "We sent you an email to confirm your address." : undefined,
        });
      }
    } catch (e) {
      setError(err(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card>
        <CardHeader
          title={mode === "signup" ? "Create your account" : mode === "forgot" ? "Reset your password" : "Sign in"}
          description={mode === "forgot" ? "We will email you a link to choose a new password." : "With your email and a password."}
          action={
            mode !== "forgot" && (
              <Segmented<"login" | "signup">
                ariaLabel="Sign in or create an account"
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  setError(null);
                }}
                options={[
                  { value: "login", label: "Sign in" },
                  { value: "signup", label: "Create account" },
                ]}
              />
            )
          }
        />
        <CardBody>
          {mode === "forgot" && sent ? (
            <div role="status" className="space-y-3">
              <p className="text-[13.5px] text-ink-2">If there is an account for that email, a link is on its way. It works for one hour.</p>
              <Button variant="outline" onClick={() => (setMode("login"), setSent(false))}>
                Back to sign in
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} className="max-w-md space-y-4">
              {mode === "signup" && (
                <div>
                  <Label htmlFor="acc-name" hint="optional">
                    Name
                  </Label>
                  <Input id="acc-name" name="name" autoComplete="name" maxLength={80} />
                </div>
              )}
              <div>
                <Label htmlFor="acc-email">Email</Label>
                <Input id="acc-email" name="email" type="email" required autoComplete="email" maxLength={254} />
              </div>
              {mode !== "forgot" && (
                <div>
                  <Label htmlFor="acc-pw" hint={mode === "signup" ? "at least 10 characters" : undefined}>
                    Password
                  </Label>
                  <Input
                    id="acc-pw"
                    name="password"
                    type="password"
                    required
                    minLength={mode === "signup" ? 10 : 1}
                    maxLength={200}
                    autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  />
                </div>
              )}
              <p aria-live="polite" className="min-h-5 text-[13px] text-fire">
                {error}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit" loading={busy} disabled={busy}>
                  {mode === "signup" ? "Create account" : mode === "forgot" ? "Send link" : "Sign in"}
                </Button>
                {mode === "login" && (
                  <button type="button" className="text-[13px] text-muted underline-offset-4 hover:text-ink hover:underline" onClick={() => setMode("forgot")}>
                    Forgot password?
                  </button>
                )}
                {mode === "forgot" && (
                  <button type="button" className="text-[13px] text-muted underline-offset-4 hover:text-ink hover:underline" onClick={() => setMode("login")}>
                    Back to sign in
                  </button>
                )}
              </div>
            </form>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardBody className="space-y-3 pt-5 text-[13px] leading-relaxed text-ink-2">
          <div className="grid size-10 place-items-center rounded-[12px] bg-fire-soft text-fire">
            <CircleUser className="size-5" variant="duotone" />
          </div>
          <p className="font-medium text-ink">Why make an account?</p>
          <ul className="list-disc space-y-1.5 pl-4">
            <li>Keep your computers together under one name.</li>
            <li>Send feedback as you, so we can write back.</li>
            <li>Be ready for what comes next. FireVoice is free for everyone now, with no plan to buy.</li>
          </ul>
          <p className="text-[12px] text-faint">Your voices, recordings and text stay on this computer either way.</p>
        </CardBody>
      </Card>
    </div>
  );
}

function SignedIn({ s }: { s: CloudStatus }) {
  const set = useSetCloud();
  const user = s.user!;
  const [name, setName] = useState(user.name ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [delOpen, setDelOpen] = useState(false);
  const license = useQuery({ queryKey: ["cloud-license"], queryFn: cloud.license, staleTime: 5 * 60_000, retry: false });

  const run = async (what: string, fn: () => Promise<CloudStatus | void>, done?: string) => {
    setBusy(what);
    try {
      const r = await fn();
      if (r) set(r);
      if (done) toast.success(done);
    } catch (e) {
      toast.error(err(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader
            title="Your account"
            action={
              <Button size="sm" variant="ghost" leading={<LogOut className="size-4" />} loading={busy === "out"} onClick={() => void run("out", cloud.signOut)}>
                Sign out
              </Button>
            }
          />
          <CardBody className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="grid size-12 place-items-center rounded-full bg-gradient-to-br from-fire-2 to-fire text-[18px] font-semibold text-white">
                {(user.name || user.email).slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium text-ink">{user.name || user.email}</div>
                <div className="flex items-center gap-2 text-[12.5px] text-muted">
                  <span className="truncate">{user.email}</span>
                  {user.verified ? <Badge tone="ok">confirmed</Badge> : <Badge tone="warn">not confirmed</Badge>}
                </div>
              </div>
            </div>
            {!user.verified && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-surface-2 px-3.5 py-3">
                <span className="flex items-center gap-2 text-[13px] text-ink-2">
                  <Mail className="size-4 text-muted" />
                  Confirm your email with the link we sent.
                </span>
                <Button size="sm" variant="outline" loading={busy === "resend"} onClick={() => void run("resend", cloud.resend, "Email sent again")}>
                  Resend email
                </Button>
              </div>
            )}
            <form
              className="flex max-w-md items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run("name", () => cloud.updateAccount({ name: name.trim() || null }), "Name saved");
              }}
            >
              <div className="flex-1">
                <Label htmlFor="acc-name2">Name</Label>
                <Input id="acc-name2" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button type="submit" variant="outline" disabled={name.trim() === (user.name ?? "")} loading={busy === "name"}>
                Save
              </Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Security" />
          <CardBody className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setPwOpen(true)}>
              Change password
            </Button>
            <Button variant="ghost" className="text-fire" onClick={() => setDelOpen(true)}>
              Delete account
            </Button>
          </CardBody>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <Card>
          <CardBody className="space-y-2 pt-5">
            <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] text-muted uppercase">
              <Sparkles className="size-3.5" /> Plan
            </div>
            <div className="text-[22px] font-semibold tracking-tight text-ink">
              {license.data?.licensing ? (license.data.plan === "free" ? "Free" : license.data.plan === "pro" ? "Pro" : "Team") : "Free"}
            </div>
            <p className="text-[13px] leading-relaxed text-ink-2">
              {license.data?.licensing
                ? license.data.license
                  ? `Key ending ${license.data.license.last4}${license.data.license.expiresAt ? `, until ${new Date(license.data.license.expiresAt).toLocaleDateString()}` : ""}.`
                  : "Everything in FireVoice is included."
                : "FireVoice is free for everyone right now. Every feature is included, with no limits."}
            </p>
            {license.data?.licensing && <LicenseKey />}
          </CardBody>
        </Card>
        <Card>
          <CardBody className="space-y-1.5 pt-5 text-[13px] text-ink-2">
            <div className="flex items-center gap-2 text-[12px] font-semibold tracking-[0.08em] text-muted uppercase">
              <ShieldCheck className="size-3.5" /> This computer
            </div>
            <p>
              {typeof s.installs === "number" ? `${s.installs} computer${s.installs === 1 ? "" : "s"} signed in to this account.` : "Signed in on this computer."}
            </p>
            <p className="text-[12px] text-faint">
              {s.consent ? "Usage statistics from this computer are linked to your account." : "Usage sharing is off on this computer (Settings, Privacy)."}
            </p>
          </CardBody>
        </Card>
      </div>

      <PasswordDialog open={pwOpen} onOpenChange={setPwOpen} />
      <DeleteDialog open={delOpen} onOpenChange={setDelOpen} />
    </div>
  );
}

function LicenseKey() {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex gap-2 pt-1"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await cloud.activate(key.trim());
          toast.success("Key added to this computer");
          setKey("");
        } catch (er) {
          toast.error(err(er));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="FV-XXXXX-XXXXX-XXXXX-XXXXX" aria-label="Licence key" className="font-mono" />
      <Button type="submit" variant="outline" loading={busy} disabled={key.trim().length < 20}>
        Add
      </Button>
    </form>
  );
}

function PasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const set = useSetCloud();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const next = String(f.get("next") ?? "");
    if (next !== String(f.get("again") ?? "")) return setError("The two new passwords are not the same.");
    setBusy(true);
    setError(null);
    try {
      set(await cloud.updateAccount({ currentPassword: String(f.get("current") ?? ""), newPassword: next }));
      toast.success("Password changed", { description: "Other computers were signed out." });
      onOpenChange(false);
    } catch (er) {
      setError(err(er));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Change password" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor="pw-cur">Current password</Label>
          <Input id="pw-cur" name="current" type="password" required autoComplete="current-password" />
        </div>
        <div>
          <Label htmlFor="pw-new" hint="10+ characters">
            New password
          </Label>
          <Input id="pw-new" name="next" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
        </div>
        <div>
          <Label htmlFor="pw-again">New password again</Label>
          <Input id="pw-again" name="again" type="password" required minLength={10} maxLength={200} autoComplete="new-password" />
        </div>
        <p aria-live="polite" className="min-h-5 text-[13px] text-fire">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const set = useSetCloud();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      set(await cloud.deleteAccount(String(new FormData(e.currentTarget).get("password") ?? "")));
      toast.success("Your account was deleted");
      onOpenChange(false);
    } catch (er) {
      setError(err(er));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete your account?"
      description="Your account and sign-ins are removed for good. FireVoice keeps working on this computer, and nothing on it is touched."
      size="sm"
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <Label htmlFor="del-pw">Your password</Label>
          <Input id="del-pw" name="password" type="password" required autoComplete="current-password" />
        </div>
        <p aria-live="polite" className="min-h-5 text-[13px] text-fire">
          {error}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy}>
            Delete account
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
