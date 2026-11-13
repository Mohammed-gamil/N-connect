import * as React from "react";
import { cn } from "../../lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", error = false, ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        aria-invalid={error || undefined}
        className={cn(
          "flex h-10 w-full rounded-lg border bg-surface px-3 py-2 text-sm text-ink transition-colors duration-150",
          "placeholder:text-ink-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
          "disabled:cursor-not-allowed disabled:bg-subtle disabled:opacity-60",
          error
            ? "border-danger focus-visible:ring-danger"
            : "border-border hover:border-border-strong focus-visible:ring-accent",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
