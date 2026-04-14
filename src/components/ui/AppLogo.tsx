/**
 * ProSSH app logo — inline SVG so it scales and inherits currentColor.
 * Matches the bundle icon at src-tauri/icons/icon.png (terminal prompt `>_`).
 */
export function AppLogo({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <rect
        x="2"
        y="3.5"
        width="20"
        height="17"
        rx="3"
        fill="currentColor"
        fillOpacity="0.12"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="1.25"
      />
      <path
        d="M6.5 9.5l3 2.5-3 2.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        x1="11.5"
        y1="15"
        x2="16"
        y2="15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
