import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/* The bottom-right corner of the window, where background work reports in (the app update, the setup still
 * downloading, engines installing). Cards stack upwards instead of covering each other. The host is mounted once at
 * the top of the app; AppShell raises it above the player bar with the --fv-corner-bottom variable. */

const ID = "fv-corner";

export function CornerHost() {
  return (
    <div
      id={ID}
      className="pointer-events-none fixed right-5 z-50 flex flex-col items-end gap-3 [&>*]:pointer-events-auto"
      style={{ bottom: "var(--fv-corner-bottom, 20px)", transition: "bottom 0.3s" }}
    />
  );
}

/** Render children in the corner stack; `order` puts them in place (smaller is higher up). */
export function InCorner({ children, order = 0 }: { children: ReactNode; order?: number }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById(ID)), []);
  if (!host) return null;
  return createPortal(<div style={{ order }}>{children}</div>, host);
}
