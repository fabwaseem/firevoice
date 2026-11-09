import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "sonner";
import { api, ApiError, subscribeJobEvents } from "./client";
import type { Job, Style, Voice } from "./types";
import { useSettings } from "@/stores/settings";

export const qk = {
  health: ["health"] as const,
  system: ["system"] as const,
  options: ["options"] as const,
  engines: ["engines"] as const,
  voices: (f?: Record<string, string | undefined>) => ["voices", f ?? {}] as const,
  voice: (id: string) => ["voice", id] as const,
  styles: ["styles"] as const,
  jobs: (f?: Record<string, string | number | undefined>) => ["jobs", f ?? {}] as const,
  job: (id: string) => ["job", id] as const,
};

export function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof TypeError) return "Cannot reach the FireVoice server. Is `firevoice serve` running?";
  if (e instanceof Error) return e.message;
  return String(e);
}

export function useHealth() {
  const server = useSettings((s) => s.serverUrl);
  return useQuery({
    queryKey: [...qk.health, server],
    queryFn: api.health,
    refetchInterval: (q) => (q.state.status === "error" ? 3000 : 15000),
    retry: false,
    staleTime: 5000,
  });
}

export function useSystem(enabled = true) {
  return useQuery({ queryKey: qk.system, queryFn: api.system, refetchInterval: 8000, enabled, retry: 1 });
}

export function useOptions() {
  return useQuery({ queryKey: qk.options, queryFn: api.options, staleTime: 60_000, retry: 1 });
}

export function useEngines() {
  return useQuery({ queryKey: qk.engines, queryFn: api.engines, refetchInterval: 10_000, retry: 1 });
}

export function useVoices(filters?: { language?: string; gender?: string; kind?: string; tag?: string; q?: string }) {
  const clean = Object.fromEntries(Object.entries(filters ?? {}).filter(([, v]) => v)) as Record<string, string>;
  return useQuery({ queryKey: qk.voices(clean), queryFn: () => api.voices(clean), staleTime: 30_000, retry: 1 });
}

export function useVoiceCollections() {
  return useQuery({ queryKey: ["voice-collections"], queryFn: api.voiceCollections, staleTime: 60_000, retry: 1 });
}

export function useVoice(id: string | null) {
  return useQuery({ queryKey: qk.voice(id ?? ""), queryFn: () => api.voice(id!), enabled: !!id, retry: 1 });
}

export function useStyles() {
  return useQuery({ queryKey: qk.styles, queryFn: api.styles, staleTime: 60_000, retry: 1 });
}

export function useJobs(filters?: { status?: string; kind?: string; limit?: number }) {
  return useQuery({ queryKey: qk.jobs(filters), queryFn: () => api.jobs(filters), staleTime: 5000, retry: 1 });
}

export function useJob(id: string | null) {
  return useQuery({ queryKey: qk.job(id ?? ""), queryFn: () => api.job(id!), enabled: !!id, retry: 1 });
}

/** Keeps every cached job list and job in sync with the server's SSE feed. Mount once in the shell. */
export function useJobFeed(onConnection?: (open: boolean) => void) {
  const qc = useQueryClient();
  const server = useSettings((s) => s.serverUrl);
  const token = useSettings((s) => s.token);
  useEffect(() => {
    const unsub = subscribeJobEvents((e) => {
      const job = e.job;
      qc.setQueryData(qk.job(job.id), job);
      qc.setQueriesData<{ jobs: Job[]; counts: Record<string, number> }>({ queryKey: ["jobs"] }, (old) => {
        if (!old) return old;
        const idx = old.jobs.findIndex((j) => j.id === job.id);
        const jobs = idx >= 0 ? old.jobs.map((j) => (j.id === job.id ? job : j)) : [job, ...old.jobs];
        return { ...old, jobs };
      });
      if (e.type === "done" || e.type === "failed" || e.type === "cancelled" || ["done", "failed", "cancelled"].includes(job.status)) {
        qc.invalidateQueries({ queryKey: ["jobs"] });
        qc.invalidateQueries({ queryKey: qk.system });
        if (job.kind === "design") qc.invalidateQueries({ queryKey: ["voices"] });
      }
    }, onConnection);
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qc, server, token]);
}

// ---------------------------------------------------------------- mutations
export function useLoadEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, workers }: { name: string; workers?: number }) => api.loadEngine(name, workers),
    onSuccess: (_, v) => {
      toast.success(`${v.name} is loaded`);
      qc.invalidateQueries({ queryKey: qk.engines });
      qc.invalidateQueries({ queryKey: qk.system });
      qc.invalidateQueries({ queryKey: qk.options });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useUnloadEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.unloadEngine(name),
    onSuccess: (_, name) => {
      toast.success(`${name} unloaded`);
      qc.invalidateQueries({ queryKey: qk.engines });
      qc.invalidateQueries({ queryKey: qk.system });
      qc.invalidateQueries({ queryKey: qk.options });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useUpdateVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.updateVoice>[1] }) => api.updateVoice(id, patch),
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: ["voices"] });
      const prev = qc.getQueriesData<Voice[]>({ queryKey: ["voices"] });
      qc.setQueriesData<Voice[]>({ queryKey: ["voices"] }, (old) => old?.map((v) => (v.voice_id === id ? { ...v, ...patch } : v)));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      ctx?.prev.forEach(([k, d]) => qc.setQueryData(k, d));
      toast.error(errMessage(e));
    },
    onSettled: (_d, _e, { id }) => {
      qc.invalidateQueries({ queryKey: ["voices"] });
      qc.invalidateQueries({ queryKey: qk.voice(id) });
    },
  });
}

export function useDeleteVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteVoice(id),
    onSuccess: () => {
      toast.success("Voice removed");
      qc.invalidateQueries({ queryKey: ["voices"] });
      qc.invalidateQueries({ queryKey: qk.options });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useSetDefaultVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.setDefaultVoice(id),
    onSuccess: () => {
      toast.success("Default voice updated");
      qc.invalidateQueries({ queryKey: ["voices"] });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useAddVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.addVoice(form),
    onSuccess: (v) => {
      toast.success(`Added voice “${v.name}”`);
      qc.invalidateQueries({ queryKey: ["voices"] });
      qc.invalidateQueries({ queryKey: qk.options });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useDesignVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof api.designVoice>[0]) => api.designVoice(body, false) as Promise<Job>,
    onSuccess: (job) => {
      toast.success(`Designing “${job.title || "voice"}” in the background`);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function usePutStyle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: Partial<Style> }) => api.putStyle(name, body),
    onSuccess: (_, { name }) => {
      toast.success(`Style “${name}” saved`);
      qc.invalidateQueries({ queryKey: qk.styles });
      qc.invalidateQueries({ queryKey: qk.options });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useDeleteStyle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.deleteStyle(name),
    onSuccess: () => {
      toast.success("Style removed");
      qc.invalidateQueries({ queryKey: qk.styles });
      qc.invalidateQueries({ queryKey: qk.options });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useCreateJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, payload, title }: { kind: Job["kind"]; payload: Record<string, unknown>; title?: string }) => api.createJob(kind, payload, title),
    onSuccess: (job) => {
      toast.success(`Queued “${job.title || job.kind}”`);
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useCancelJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
    onError: (e) => toast.error(errMessage(e)),
  });
}

export function useDeleteJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteJob(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["jobs"] }),
    onError: (e) => toast.error(errMessage(e)),
  });
}
