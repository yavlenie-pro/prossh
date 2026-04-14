import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "icon" | "icon-sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    "bg-accent text-bg hover:bg-accent-hover disabled:bg-accent/50",
  secondary:
    "border border-border-subtle bg-bg-overlay text-fg hover:bg-border",
  ghost:
    "text-fg-muted hover:bg-bg-overlay hover:text-fg",
  danger:
    "border border-danger/30 bg-danger/15 text-danger hover:bg-danger/25",
};

const SIZE_CLASSES: Record<Size, string> = {
  sm: "h-7 px-2 text-xs",
  md: "h-9 px-4 text-sm",
  icon: "h-9 w-9",
  "icon-sm": "h-7 w-7",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "secondary", size = "md", type = "button", ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        "disabled:cursor-not-allowed disabled:opacity-60",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className,
      )}
      {...rest}
    />
  ),
);
Button.displayName = "Button";
