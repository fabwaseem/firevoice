import { create } from "zustand";

/** Finishing the setup after the welcome has already been seen: someone who skipped it in an older version and has no
 * voice model or voices yet. The app shows the setup screen again until it is done (or they say not now). */
interface ResumeState {
  resume: boolean;
  /** "Not now" was pressed this session: the banner stays quiet until the next start */
  dismissed: boolean;
  set: (p: Partial<ResumeState>) => void;
}

export const useResumeSetup = create<ResumeState>()((set) => ({ resume: false, dismissed: false, set: (p) => set(p) }));
