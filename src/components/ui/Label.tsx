import { forwardRef, type LabelHTMLAttributes } from "react";

import { cn } from "@/lib/cn";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...rest }, ref) => (
    <label
      ref={ref}
      className={cn("text-xs font-medium text-fg-muted", className)}
      {...rest}
    />
  ),
);
Label.displayName = "Label";
