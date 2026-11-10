import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ArrowLeft, Palette, Plus } from "lucide-react";
import { errMessage, useStyles } from "@/lib/api/hooks";
import { Button, EmptyState, Skeleton } from "@/components/ui";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { StyleList, StyleListSkeleton } from "@/components/styles/StyleList";
import { StyleEditor, type EditorTarget } from "@/components/styles/StyleEditor";
import { NewStyleDialog } from "@/components/styles/NewStyleDialog";

export function StylesView() {
  const { styleName } = useParams();
  const navigate = useNavigate();
  const styles = useStyles();
  const [newOpen, setNewOpen] = useState(false);
  /** Pending creation: base style name + new name, until saved */
  const [creating, setCreating] = useState<{ base: string; name: string } | null>(null);

  const list = styles.data ?? [];
  const selected = styleName ?? null;

  // Default to the first style when nothing is selected.
  useEffect(() => {
    if (!selected && !creating && list.length) navigate(`/styles/${list.find((s) => s.name === "conversational")?.name ?? list[0].name}`, { replace: true });
  }, [selected, creating, list, navigate]);

  const target = useMemo<EditorTarget | null>(() => {
    if (creating) {
      const base = list.find((s) => s.name === creating.base);
      return base ? { style: base, newName: creating.name } : null;
    }
    const s = list.find((x) => x.name === selected);
    return s ? { style: s } : null;
  }, [creating, list, selected]);

  const select = (name: string) => {
    setCreating(null);
    navigate(`/styles/${name}`);
  };

  const onSaved = (name: string) => {
    if (name.startsWith("__dup__:")) {
      const base = selected ?? list[0]?.name;
      if (base) setCreating({ base, name: name.slice(8) });
      return;
    }
    setCreating(null);
    navigate(`/styles/${name}`);
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Styles"
        subtitle="Delivery styles: pacing, pauses, sampling and the instruction given to instruction-following engines."
        actions={
          <Button variant="primary" leading={<Plus className="size-4" />} onClick={() => setNewOpen(true)} disabled={!list.length}>
            New style
          </Button>
        }
      />

      {styles.error ? (
        <LoadError message={errMessage(styles.error)} retry={() => void styles.refetch()} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
          <div className="lg:sticky lg:top-0 lg:max-h-[calc(100vh-140px)] lg:overflow-y-auto lg:pr-1">
            {styles.isLoading ? <StyleListSkeleton /> : list.length ? <StyleList styles={list} selected={creating ? null : selected} onSelect={select} /> : null}
          </div>

          <div className="min-w-0">
            {styles.isLoading ? (
              <div className="flex flex-col gap-4" aria-hidden>
                <Skeleton className="h-14 w-full rounded-xl" />
                <Skeleton className="h-64 w-full rounded-xl" />
                <Skeleton className="h-48 w-full rounded-xl" />
              </div>
            ) : !list.length ? (
              <EmptyState icon={<Palette />} title="No styles" description="The server returned no delivery styles. Built-in styles ship with FireVoice, so check the server." className="surface rounded-xl" />
            ) : target ? (
              <StyleEditor key={creating ? `new:${creating.name}` : target.style.name} target={target} onSaved={onSaved} onDeleted={() => navigate("/styles")} />
            ) : (
              <EmptyState icon={<Palette />} title="Style not found" description={`There is no style named “${selected}”.`} action={<Button onClick={() => navigate("/styles")} leading={<ArrowLeft className="size-4" />}>Back to styles</Button>} className="surface rounded-xl" />
            )}
          </div>
        </div>
      )}

      <NewStyleDialog open={newOpen} onOpenChange={setNewOpen} styles={list} onCreate={(base, name) => { setCreating({ base, name }); navigate("/styles"); }} />
    </div>
  );
}
