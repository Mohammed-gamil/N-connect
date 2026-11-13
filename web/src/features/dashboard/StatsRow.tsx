import type { DashboardStats } from "../../contracts";
import { Skeleton } from "../../components/ui";

interface StatsRowProps {
  stats: DashboardStats | null;
  loading: boolean;
}

export function StatsRow({ stats, loading }: StatsRowProps) {
  const items = [
    { label: "Active automations", value: stats?.activeAutomations ?? 0 },
    { label: "Successful runs (30d)", value: stats?.successfulExecutions ?? 0 },
    { label: "Failed runs", value: stats?.failedExecutions ?? 0 },
    { label: "Connected apps", value: stats?.connectedApps ?? 0 },
  ];

  return (
    <section aria-label="Workspace summary" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {items.map((item) => (
        <div
          key={item.label}
          className="rounded-xl border border-border bg-surface px-4 py-3.5 shadow-2xs"
        >
          <p className="text-xs font-medium text-ink-muted">{item.label}</p>
          {loading ? (
            <Skeleton className="mt-2 h-7 w-12" />
          ) : (
            <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-ink">
              {item.value.toLocaleString()}
            </p>
          )}
        </div>
      ))}
    </section>
  );
}
