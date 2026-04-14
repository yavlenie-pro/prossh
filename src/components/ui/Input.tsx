import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg",
        "placeholder:text-fg-subtle",
        "focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...rest}
    />
  ),
);
Input.displayName = "Input";
