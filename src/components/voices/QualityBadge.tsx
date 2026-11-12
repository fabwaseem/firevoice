import { Star } from "@/components/icons";
import type { Voice } from "@/lib/api/types";
import { Badge, Tooltip } from "@/components/ui";

const LABEL = { S: "Top pick", A: "Excellent", B: "Great", C: "Good" } as const;

/** Listening-test tier (SpeechJudge naturalness, same sentence for every voice). */
export function QualityBadge({ voice }: { voice: Voice }) {
  const q = voice.quality;
  if (!q) return null;
  const tone = q.tier === "S" ? "fire" : q.tier === "A" ? "ok" : "neutral";
  return (
    <Tooltip content={`Listening test: #${q.rank} of ${q.of}${q.naturalness ? ` · naturalness ${q.naturalness}/9` : ""}`}>
      <Badge tone={tone}>
        {q.tier === "S" && <Star className="size-3 fill-current" />}
        {LABEL[q.tier]}
      </Badge>
    </Tooltip>
  );
}
