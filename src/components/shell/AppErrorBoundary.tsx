import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * The last line of defence for the whole window. Pages have their own error screen (RouteError, inside the router),
 * but the screens before the router (starting, first run, updating the engine) and the gates around it have none: an
 * error there used to leave the window blank. This shows what went wrong and a way out instead.
 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("FireVoice could not draw its window:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-bg p-8 text-center">
        <div className="text-[18px] font-semibold text-ink">FireVoice ran into a problem</div>
        <p className="max-w-[520px] text-[13.5px] leading-relaxed text-muted">
          Something went wrong while drawing this window. Reloading usually fixes it. If it keeps happening, send this
          message from Send feedback.
        </p>
        <pre className="max-h-[160px] max-w-[640px] overflow-auto rounded-xl bg-surface-2 px-4 py-3 text-left text-[12px] whitespace-pre-wrap text-muted select-text">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-xl bg-fire px-5 py-2.5 text-[13.5px] font-semibold text-white transition-opacity hover:opacity-90"
        >
          Reload FireVoice
        </button>
      </div>
    );
  }
}
