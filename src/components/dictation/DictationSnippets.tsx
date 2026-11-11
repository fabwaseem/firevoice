import { useState } from "react";
import { MessageSquareQuote, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import { errMessage } from "@/lib/api/hooks";
import type { DictationSnippet } from "@/lib/api/types";
import { Button, Card, CardBody, CardHeader, Dialog, EmptyState, Input, Textarea, Tooltip } from "@/components/ui";
import { VOCAB_KEY, useVocabulary } from "./DictationVocabulary";

/** Short phrases that type longer text: "my address", "sign off", "calendar link". */
export function DictationSnippetsPanel() {
  const qc = useQueryClient();
  const vocab = useVocabulary();
  const [edit, setEdit] = useState<Partial<DictationSnippet> | null>(null);
  const rows = vocab.data?.snippets ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: VOCAB_KEY });
  const save = useMutation({
    mutationFn: api.saveSnippet,
    onSuccess: () => {
      setEdit(null);
      void refresh();
    },
    onError: (e) => toast.error(errMessage(e)),
  });
  const del = useMutation({ mutationFn: api.deleteSnippet, onSuccess: () => void refresh(), onError: (e) => toast.error(errMessage(e)) });

  return (
    <Card>
      <CardHeader
        title="Snippets"
        description="Say a short phrase anywhere in a dictation and FireVoice types the full text instead."
        action={
          <Button size="sm" variant="soft" leading={<Plus className="size-4" />} onClick={() => setEdit({ trigger: "", text: "" })}>
            New snippet
          </Button>
        }
      />
      <CardBody>
        {rows.length === 0 ? (
          <EmptyState
            icon={<MessageSquareQuote />}
            title="No snippets yet"
            description="For example: say “my email” to type your address, or “sign off” for your usual closing."
          />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((s) => (
              <li key={s.id} className="group flex items-start gap-4 py-3">
                <span className="w-40 shrink-0 truncate pt-0.5 text-[13.5px] font-medium text-ink">“{s.trigger}”</span>
                <p className="line-clamp-3 min-w-0 flex-1 text-[13px] leading-relaxed whitespace-pre-wrap text-muted">{s.text}</p>
                <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <Tooltip content="Edit">
                    <button type="button" aria-label={`Edit ${s.trigger}`} onClick={() => setEdit(s)} className="grid size-8 place-items-center rounded-[9px] text-faint hover:bg-surface-3 hover:text-ink">
                      <Pencil className="size-4" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Remove">
                    <button type="button" aria-label={`Remove ${s.trigger}`} onClick={() => del.mutate(s.id)} className="grid size-8 place-items-center rounded-[9px] text-faint hover:bg-bad-soft hover:text-bad">
                      <Trash2 className="size-4" />
                    </button>
                  </Tooltip>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <Dialog
        open={edit != null}
        onOpenChange={(v) => !v && setEdit(null)}
        title={edit?.id ? "Edit snippet" : "New snippet"}
        description="Say the phrase while dictating, and the text goes in instead."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>
              Cancel
            </Button>
            <Button
              loading={save.isPending}
              disabled={!edit?.trigger?.trim() || !edit?.text?.trim()}
              onClick={() => edit && save.mutate({ id: edit.id, trigger: edit.trigger ?? "", text: edit.text ?? "" })}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">When I say</span>
            <Input autoFocus value={edit?.trigger ?? ""} onChange={(e) => setEdit((x) => ({ ...x, trigger: e.target.value }))} placeholder="my address" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-ink-2">Type this</span>
            <Textarea rows={5} value={edit?.text ?? ""} onChange={(e) => setEdit((x) => ({ ...x, text: e.target.value }))} placeholder={"221B Baker Street\nLondon NW1 6XE"} />
          </label>
        </div>
      </Dialog>
    </Card>
  );
}
