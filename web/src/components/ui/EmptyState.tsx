import * as React from "react";
import { cn } from "../../lib/utils";

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-border bg-surface px-6 py-14 text-center shadow-2xs",
        className,
      )}
      {...props}
    >
      {icon && (
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-subtle text-ink-secondary">
          {icon}
        </div>
      )}
      <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm leading-relaxed text-ink-secondary">
        {description}
      </p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
