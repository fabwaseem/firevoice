import * as RT from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

export const TooltipProvider = RT.Provider;

export function Tooltip({
  content,
  children,
  side = "top",
  shortcut,
  disabled,
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  shortcut?: string;
  disabled?: boolean;
}) {
  if (disabled || !content) return <>{children}</>;
  return (
    <RT.Root delayDuration={350}>
      <RT.Trigger asChild>{children}</RT.Trigger>
      <RT.Portal>
        <RT.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[60] flex items-center gap-2 rounded-[10px] bg-ink px-2.5 py-1.5 text-[12px] font-medium text-bg shadow-lg fade-up"
        >
          {content}
          {shortcut && <kbd className="rounded-[5px] bg-white/15 px-1.5 py-0.5 font-sans text-[10.5px] tracking-wide">{shortcut}</kbd>}
          <RT.Arrow className="fill-ink" />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}
