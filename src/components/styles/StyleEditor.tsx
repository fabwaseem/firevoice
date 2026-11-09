import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Copy, Lock, Play, Save, Trash2 } from "lucide-react";
import type { Style } from "@/lib/api/types";
import { useDeleteStyle, usePutStyle } from "@/lib/api/hooks";
import { useStudio } from "@/stores/studio";
import { Badge, Button, ConfirmDialog, Input, Label } from "@/components/ui";
import { EmotionFields, SampleField, SliderFields, TextFields } from "./StyleFields";
import { isDirty, slugify, toBody, toDraft, type StyleDraft } from "./helpers";

export interface EditorTarget {
  /** Existing style, or the base a new / duplicated style starts from */
  style: Style;
  /** Set when creating a new custom style: it does not exist on the server yet */
  newName?: string;
}

export function StyleEditor({ target, onSaved, onDeleted }: { target: EditorTarget; onSaved: (name: string) => void; onDeleted: () => void }) {
  const navigate = useNavigate();
  const put = usePutStyle();
  const del = useDeleteStyle();
  const setStudio = useStudio((s) => s.set);
  const currentText = useStudio((s) => s.text);

  const isNew = !!target.newName;
  const readOnly = target.style.builtin && !isNew;
  const base = useMemo(() => toDraft(target.style), [target.style]);
  const [draft, setDraft] = useState<StyleDraft>(() => ({ ...base, name: target.newName ?? base.name }));
  const [confirm, setConfirm] = useState(false);

  useEffect(() => setDraft({ ...base, name: target.newName ?? base.name }), [base, target.newName]);

  const patch = (p: Partial<StyleDraft>) => setDraft((d) => ({ ...d, ...p }));
  const dirty = isNew || isDirty(draft, base);
  const nameValid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(draft.name);

  const save = () => {
    if (!nameValid) return;
    put.mutate({ name: draft.name, body: toBody(draft) }, { onSuccess: () => onSaved(draft.name) });
  };

  const tryIt = () => {
    setStudio({ style: isNew ? base.name : draft.name, text: draft.sample || currentText });
    navigate("/speak");
  };

  const duplicate = () => onSaved(`__dup__:${slugify("my-" + draft.name)}`);

  return (
    <div className="flex flex-col gap-4">
      <div className="surface flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          {isNew ? (
            <div className="flex items-center gap-2">
              <Label htmlFor="st-name" className="mb-0">
                Name
              </Label>
              <Input id="st-name" value={draft.name} onChange={(e) => patch({ name: slugify(e.target.value) || e.target.value.toLowerCase() })} aria-invalid={!nameValid} className="h-8 w-48 font-mono text-[13px]" placeholder="my-style" />
              {!nameValid && <span className="text-[12px] text-bad">lowercase letters, digits, dashes</span>}
            </div>
          ) : (
            <>
              <h2 className="truncate text-[17px] font-semibold tracking-[-0.01em] text-ink">{draft.title || draft.name}</h2>
              <code className="font-mono text-[12px] text-muted">{draft.name}</code>
              {readOnly ? (
                <Badge>
                  <Lock className="size-3" /> built-in
                </Badge>
              ) : (
                <Badge tone="fire">custom</Badge>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" leading={<Play className="size-3.5" />} onClick={tryIt}>
            Try it
          </Button>
          {readOnly ? (
            <Button size="sm" variant="primary" leading={<Copy className="size-3.5" />} onClick={duplicate}>
              Duplicate as custom
            </Button>
          ) : (
            <>
              {!isNew && (
                <Button size="sm" variant="danger" leading={<Trash2 className="size-3.5" />} onClick={() => setConfirm(true)} aria-label="Delete style">
                  Delete
                </Button>
              )}
              <Button size="sm" variant="primary" leading={<Save className="size-3.5" />} disabled={!dirty || !nameValid} loading={put.isPending} onClick={save}>
                {isNew ? "Create style" : "Save"}
              </Button>
            </>
          )}
        </div>
      </div>

      {readOnly && <p className="px-1 text-[12.5px] text-muted">Built-in styles are read-only. Duplicate one to tune it; a custom style with the same name overrides the built-in.</p>}

      <TextFields draft={draft} patch={patch} readOnly={readOnly} />
      <SliderFields draft={draft} patch={patch} readOnly={readOnly} base={base} />
      <EmotionFields draft={draft} patch={patch} readOnly={readOnly} />
      <SampleField draft={draft} patch={patch} readOnly={readOnly} />

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete “${draft.title || draft.name}”?`}
        description={`The custom style file is removed from ~/.firevoice/styles. ${target.style.builtin ? "" : "Renders that used it are kept."}`}
        confirmLabel="Delete style"
        destructive
        loading={del.isPending}
        onConfirm={() => del.mutate(draft.name, { onSuccess: () => { setConfirm(false); onDeleted(); } })}
      />
    </div>
  );
}
