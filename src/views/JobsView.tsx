import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { ListChecks } from "lucide-react";
import { useCancelJob, useDeleteJob, useJob, useJobs, errMessage } from "@/lib/api/hooks";
import type { Job, JobKind } from "@/lib/api/types";
import { PageHeader, LoadError } from "@/components/shell/PageHeader";
import { Chip, ConfirmDialog, EmptyState, Segmented, Skeleton } from "@/components/ui";
import { JobRow } from "@/components/jobs/JobRow";
import { JobDetail } from "@/components/jobs/JobDetail";

type StatusFilter = "all" | "running" | "queued" | "done" | "failed";
type KindFilter = "all" | JobKind;

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "queued", label: "Queued" },
  { value: "done", label: "Done" },
  { value: "failed", label: "Failed" },
];

export function JobsView() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [pendingDelete, setPendingDelete] = useState<Job | null>(null);

  const jobs = useJobs({ limit: 200 });
  const selectedFromList = jobs.data?.jobs.find((j) => j.id === jobId);
  const selectedQuery = useJob(jobId && !selectedFromList ? jobId : null);
  const selected = selectedFromList ?? selectedQuery.data ?? null;

  const cancel = useCancelJob();
  const del = useDeleteJob();

  const counts = jobs.data?.counts ?? {};
  const total = jobs.data?.jobs.length ?? 0;

  const visible = useMemo(() => {
    const list = jobs.data?.jobs ?? [];
    return list
      .filter((j) => (status === "all" ? true : j.status === status))
      .filter((j) => (kind === "all" ? true : j.kind === kind))
      .sort((a, b) => b.created - a.created);
  }, [jobs.data, status, kind]);

  const select = (id: string | null) => navigate(id ? `/jobs/${id}` : "/jobs");

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Jobs"
        subtitle="Long scripts, batches and voice designs, with history kept on disk."
        actions={
          <Segmented
            size="sm"
            ariaLabel="Filter by kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: "all", label: "Any kind" },
              { value: "tts", label: "Speech" },
              { value: "batch", label: "Batch" },
              { value: "design", label: "Design" },
            ]}
          />
        }
      />

      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((f) => {
          const n = f.value === "all" ? total : (counts[f.value] ?? 0);
          return (
            <Chip key={f.value} active={status === f.value} onClick={() => setStatus(f.value)}>
              {f.label}
              <span className="rounded-full bg-current/10 px-1.5 text-[11px] tabular opacity-80">{n}</span>
            </Chip>
          );
        })}
      </div>

      {jobs.isError ? (
        <LoadError message={errMessage(jobs.error)} retry={() => void jobs.refetch()} />
      ) : (
        <div className={selected ? "grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]" : ""}>
          <div className="space-y-1">
            {jobs.isLoading &&
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-3 py-3">
                  <Skeleton className="size-12 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            {jobs.isSuccess && visible.length === 0 && (
              <EmptyState
                icon={<ListChecks />}
                title={total === 0 ? "No jobs yet" : "Nothing matches these filters"}
                description={
                  total === 0
                    ? "Queue one from Speak with “Render as job”. Long scripts, batches and voice designs run here in the background and stay in this history."
                    : "Try a different status or kind."
                }
              />
            )}
            {visible.map((job) => (
              <JobRow
                key={job.id}
                job={job}
                selected={job.id === jobId}
                onSelect={() => select(job.id === jobId ? null : job.id)}
                onCancel={() => cancel.mutate(job.id)}
                onDelete={() => setPendingDelete(job)}
              />
            ))}
          </div>
          {selected && (
            <aside aria-label="Job details">
              <JobDetail job={selected} onClose={() => select(null)} />
            </aside>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDelete}
        onOpenChange={(o) => !o && setPendingDelete(null)}
        title="Delete this job?"
        description={pendingDelete ? `“${pendingDelete.title || pendingDelete.kind}” and its rendered files will be removed from disk. This cannot be undone.` : undefined}
        confirmLabel="Delete"
        destructive
        loading={del.isPending}
        onConfirm={() => {
          if (!pendingDelete) return;
          del.mutate(pendingDelete.id, {
            onSuccess: () => {
              if (pendingDelete.id === jobId) select(null);
              setPendingDelete(null);
            },
          });
        }}
      />
    </div>
  );
}
