import { useState } from "react";
import { toast } from "sonner";
import { Bug, Heart, Lightbulb, MessageCircle } from "@/components/icons";
import { Button, Dialog, Input, Label, Textarea } from "@/components/ui";
import { cloud, useCloud } from "@/lib/cloud";
import { cn } from "@/lib/utils";

const KINDS = [
  { value: "bug", label: "Something broke", icon: Bug },
  { value: "idea", label: "An idea", icon: Lightbulb },
  { value: "praise", label: "I like it", icon: Heart },
  { value: "other", label: "Something else", icon: MessageCircle },
] as const;
type Kind = (typeof KINDS)[number]["value"];

/** Send feedback from inside the app: sent with the app version (and the account, when signed in). */
export function FeedbackDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const status = useCloud();
  const [kind, setKind] = useState<Kind>("idea");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const signedIn = status.data?.signedIn;

  const send = async () => {
    setBusy(true);
    try {
      await cloud.feedback({ kind, message: message.trim(), email: signedIn ? undefined : email.trim() });
      toast.success("Thank you, it is with us");
      setMessage("");
      onOpenChange(false);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Send feedback"
      description="A bug, an idea, or something you like. Every message is read."
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={busy} disabled={busy || message.trim().length < 3} onClick={() => void send()}>
            Send
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div role="radiogroup" aria-label="What is it about?" className="grid grid-cols-2 gap-2">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              role="radio"
              aria-checked={kind === k.value}
              onClick={() => setKind(k.value)}
              className={cn(
                "flex items-center gap-2.5 rounded-[12px] border px-3 py-2.5 text-left text-[13px] font-medium transition-colors",
                kind === k.value ? "border-fire/50 bg-fire-soft text-ink" : "border-line text-ink-2 hover:bg-surface-2",
              )}
            >
              <k.icon className={cn("size-4", kind === k.value ? "text-fire" : "text-muted")} />
              {k.label}
            </button>
          ))}
        </div>
        <div>
          <Label htmlFor="fb-msg">Your message</Label>
          <Textarea
            id="fb-msg"
            value={message}
            maxLength={5000}
            rows={5}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={kind === "bug" ? "What happened, and what did you expect?" : "Tell us…"}
          />
        </div>
        {!signedIn && (
          <div>
            <Label htmlFor="fb-email" hint="optional, for a reply">
              Email
            </Label>
            <Input id="fb-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
        )}
        <p className="text-[12px] text-faint">Sent with your FireVoice version{signedIn ? " and your account" : ""}. Nothing else from this computer is attached.</p>
      </div>
    </Dialog>
  );
}
