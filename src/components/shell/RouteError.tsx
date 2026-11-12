import { isRouteErrorResponse, useNavigate, useRouteError } from "react-router";
import { Home, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui";
import { TitleBar } from "./TitleBar";

/** Friendly fallback for any error thrown while rendering a view. */
export function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  const message = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : error instanceof Error ? error.message : String(error);

  return (
    <div className="ambient flex h-full flex-col">
      <TitleBar />
      <div data-tauri-drag-region className="flex flex-1 items-center justify-center p-6">
      <div role="alert" className="surface-raised w-full max-w-md rounded-2xl p-6 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-bad-soft text-bad">
          <TriangleAlert className="size-6" />
        </div>
        <h1 className="text-[17px] font-semibold text-ink">Something went wrong</h1>
        <p className="mt-1 text-[13px] break-words text-muted">{message}</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button variant="ghost" onClick={() => navigate("/")} leading={<Home className="size-4" />}>Go home</Button>
          <Button variant="primary" leading={<RotateCcw className="size-4" />} onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
}
