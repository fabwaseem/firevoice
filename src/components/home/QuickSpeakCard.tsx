import { useNavigate } from "react-router";
import { ArrowRight, AudioLines, Mic2, Palette } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, Textarea } from "@/components/ui";
import { useStudio } from "@/stores/studio";
import { useStyles, useVoices } from "@/lib/api/hooks";
import { titleCase } from "@/lib/utils";

export function QuickSpeakCard() {
  const navigate = useNavigate();
  const text = useStudio((s) => s.text);
  const voice = useStudio((s) => s.voice);
  const style = useStudio((s) => s.style);
  const set = useStudio((s) => s.set);
  const voices = useVoices();
  const styles = useStyles();
  const voiceName = voice === "default" ? "Default voice" : (voices.data ?? []).find((v) => v.voice_id === voice)?.name || (voice.startsWith("design:") ? "Designed voice" : "Chosen voice");
  const styleName = (styles.data ?? []).find((s) => s.name === style)?.title || titleCase(style);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader
        title="Quick speak"
        description="Draft here, render in Speak."
        action={<Badge tone="neutral">{words} words</Badge>}
      />
      <CardBody className="flex flex-1 flex-col gap-3">
        <Textarea
          aria-label="Script"
          rows={3}
          value={text}
          onChange={(e) => set({ text: e.target.value })}
          placeholder="Type something to say… [pause 400ms] works too."
          className="min-h-[88px] flex-1 text-[14px]"
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="fire" className="gap-1.5">
              <Mic2 className="size-3" />
              {voiceName}
            </Badge>
            <Badge tone="neutral" className="gap-1.5">
              <Palette className="size-3" />
              {styleName}
            </Badge>
          </div>
          <Button variant="primary" size="sm" leading={<AudioLines className="size-4" />} trailing={<ArrowRight className="size-4" />} onClick={() => navigate("/speak")}>
            Open in Speak
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}
