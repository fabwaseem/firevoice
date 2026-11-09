export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" className={className} aria-hidden>
      <defs>
        <linearGradient id="fv-logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--fire-2)" />
          <stop offset="1" stopColor="var(--fire)" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="120" fill="url(#fv-logo-g)" />
      <g fill="none" stroke="#fff" strokeWidth="40" strokeLinecap="round">
        <line x1="136" y1="236" x2="136" y2="276" />
        <line x1="196" y1="176" x2="196" y2="336" />
        <line x1="256" y1="124" x2="256" y2="388" />
        <line x1="316" y1="176" x2="316" y2="336" />
        <line x1="376" y1="236" x2="376" y2="276" />
      </g>
    </svg>
  );
}
