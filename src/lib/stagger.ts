import { useEffect, type RefObject } from "react";

/**
 * Every screen eases in part by part, like the Styles list: cards, rows, list items and tiles slide up one after
 * another in page order. It also covers content that arrives later (a list that finishes loading, a new row), each
 * element only once. Uses the Web Animations API with `fill: "backwards"`, so nothing is left transformed afterwards.
 */
const PARTS = [
  "header",
  ".surface",
  ".surface-raised",
  "li",
  "tbody > tr",
  "[role=listitem]",
  ".divide-y > *",
  "[data-stagger]",
].join(",");

const STEP_MS = 28; // between one part and the next
const MAX_STEPS = 16; // long lists: the tail arrives together, never late

export function useStagger(root: RefObject<HTMLElement | null>, key: string) {
  useEffect(() => {
    const el = root.current;
    if (!el || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let pending: HTMLElement[] = [];
    let frame = 0;
    const run = () => {
      frame = 0;
      const batch = pending;
      pending = [];
      batch.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      batch.forEach((node, i) => {
        node.animate(
          [
            { opacity: 0, transform: "translateY(8px)" },
            { opacity: 1, transform: "none" },
          ],
          { id: "stagger", duration: 320, delay: Math.min(i, MAX_STEPS) * STEP_MS, easing: "cubic-bezier(0.25, 1, 0.5, 1)", fill: "backwards" },
        );
      });
    };
    const collect = (scope: ParentNode) => {
      const found: HTMLElement[] = [];
      if (scope instanceof HTMLElement && scope.matches(PARTS)) found.push(scope);
      scope.querySelectorAll<HTMLElement>(PARTS).forEach((n) => found.push(n));
      for (const n of found) {
        if (n.dataset.entered) continue;
        n.dataset.entered = "1";
        pending.push(n);
      }
      if (pending.length && !frame) frame = window.setTimeout(run, 0); // one batch per burst of changes (a timer also runs where frames are paused)
    };

    collect(el);
    const mo = new MutationObserver((records) => {
      for (const r of records) r.addedNodes.forEach((n) => n instanceof HTMLElement && collect(n));
    });
    mo.observe(el, { childList: true, subtree: true });
    // a batch already queued still plays: its parts are marked as entered, so dropping it would leave them unanimated
    // (React runs effects twice in development, cleaning up in between)
    return () => mo.disconnect();
  }, [root, key]);
}
