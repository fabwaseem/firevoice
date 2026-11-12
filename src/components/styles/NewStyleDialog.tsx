import { ArrowRight } from "@/components/icons";
import { useState } from "react";
import type { Style } from "@/lib/api/types";
import { Button, Dialog, Input, Label, Select } from "@/components/ui";
import { slugify } from "./helpers";

export function NewStyleDialog({ open, onOpenChange, styles, onCreate }: { open: boolean; onOpenChange: (v: boolean) => void; styles: Style[]; onCreate: (base: string, name: string) => void }) {
  const [base, setBase] = useState("conversational");
  const [name, setName] = useState("");
  const slug = slugify(name);
  const taken = styles.some((s) => s.name === slug);
  const valid = slug.length > 0 && !taken;

  const sorted = [...styles].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New style"
      description="Start from an existing style and tune it to your liking."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => {
              onCreate(base, slug);
              setName("");
              onOpenChange(false);
            }}
           trailing={<ArrowRight className="size-4" />}>
            Continue
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <Label htmlFor="ns-name" hint={slug && slug !== name ? `saved as ${slug}` : undefined}>
            Name
          </Label>
          <Input id="ns-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="late-night-radio" autoFocus aria-invalid={taken} />
          {taken && <p className="mt-1 text-[12px] text-bad">A style with that name already exists.</p>}
        </div>
        <div>
          <Label>Start from</Label>
          <Select
            value={base}
            onChange={setBase}
            ariaLabel="Base style"
            options={sorted.map((s) => ({ value: s.name, label: s.title || s.name, description: s.description, group: s.builtin ? "Built-in" : "Custom" }))}
          />
        </div>
      </div>
    </Dialog>
  );
}
