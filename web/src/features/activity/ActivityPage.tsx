import * as React from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Filter as FilterIcon,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Skeleton,
  useToast,
} from "../../components/ui";
import type { Automation, Execution, ExecutionStatus } from "../../contracts";
import { api, ApiClientError } from "../../lib/api";
import { formatRelativeTime } from "../../lib/utils";

type StatusFilter = "all" | "succeeded" | "failed" | "needs_review";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "needs_review", label: "Needs review" },
];

const EXECUTION_STATUS_META: Record<
  ExecutionStatus,
  {
    label: string;
    variant: "success" | "danger" | "warning" | "neutral" | "accent";
    Icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
    iconClass: string;
  }
> = {
  succeeded: {
    label: "Succeeded",
    variant: "success",
    Icon: CheckCircle2,
    iconClass: "text-success",
  },
  failed: {
    label: "Failed",
    variant: "danger",
    Icon: XCircle,
    iconClass: "text-danger",
  },
  needs_review: {
    label: "Needs review",
    variant: "warning",
    Icon: AlertTriangle,
    iconClass: "text-warning",
  },
  queued: {
    label: "Queued",
    variant: "neutral",
    Icon: Clock,
    iconClass: "text-ink-muted",
  },
  running: {
    label: "Running",
    variant: "accent",
    Icon: Loader2,
    iconClass: "text-accent animate-spin",
  },
  sending: {
    label: "Sending",
    variant: "accent",
    Icon: Loader2,
    iconClass: "text-accent animate-spin",
  },
  filtered: {
    label: "Filtered",
    variant: "neutral",
    Icon: FilterIcon,
    iconClass: "text-ink-muted",
  },
};

function formatExactTimestamp(timestampMs: number | null): string {
  if (!timestampMs) return "Pending";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestampMs));
}

function formatDuration(durationMs: number | null): string | null {
  if (durationMs === null || durationMs === undefined) return null;
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(1)} s`;
}

export function ActivityPage() {
  const { toast } = useToast();

  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("all");
  const [automationFilter, setAutomationFilter] = React.useState<string>("");

  const [automations, setAutomations] = React.useState<Automation[]>([]);
  const [executions, setExecutions] = React.useState<Execution[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [retryingIds, setRetryingIds] = React.useState<Record<string, boolean>>({});

  React.useEffect(() => {
    const controller = new AbortController();
    api
      .listAutomations(controller.signal)
      .then((res) => setAutomations(res.automations))
      .catch(() => {
        // Non-blocking: automation filter list is optional helper UI
      });
    return () => controller.abort();
  }, []);

  const fetchExecutions = React.useCallback(
    async (cursor?: string, signal?: AbortSignal) => {
      const isAppending = Boolean(cursor);
      if (isAppending) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setLoadError(null);
      }

      try {
        const page = await api.listExecutions(
          {
            status: statusFilter === "all" ? undefined : statusFilter,
            automationId: automationFilter || undefined,
            cursor,
            limit: 25,
          },
          signal,
        );
        setExecutions((prev) =>
          isAppending ? [...prev, ...page.items] : page.items,
        );
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          return;
        }
        const message =
          err instanceof ApiClientError
            ? err.message
            : "We couldn't load execution history right now.";
        if (isAppending) {
          toast({
            title: "Couldn't load more runs",
            description: message,
            variant: "error",
          });
        } else {
          setLoadError(message);
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [automationFilter, statusFilter, toast],
  );

  React.useEffect(() => {
    const controller = new AbortController();
    void fetchExecutions(undefined, controller.signal);
    return () => controller.abort();
  }, [fetchExecutions]);

  async function handleRetry(execution: Execution) {
    if (retryingIds[execution.id]) return;

    const previous = execution;
    setRetryingIds((prev) => ({ ...prev, [execution.id]: true }));

    // Optimistic update to queued
    setExecutions((prev) =>
      prev.map((item) =>
        item.id === execution.id
          ? { ...item, status: "queued", errorMessage: null }
          : item,
      ),
    );

    try {
      const updated = await api.retryExecution(execution.id);
      setExecutions((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
      toast({
        title: "Retry queued",
        description: `Queued a new attempt for “${execution.automationName}”.`,
        variant: "success",
      });
    } catch (err) {
      // Rollback on failure
      setExecutions((prev) =>
        prev.map((item) => (item.id === previous.id ? previous : item)),
      );
      toast({
        title: "Couldn't retry run",
        description:
          err instanceof ApiClientError
            ? err.message
            : "Please try again in a moment.",
        variant: "error",
      });
    } finally {
      setRetryingIds((prev) => {
        const next = { ...prev };
        delete next[execution.id];
        return next;
      });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Activity
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            Track recent automation runs, delivery outcomes, and recovery actions.
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchExecutions()}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Refresh
        </Button>
      </div>

      {/* Filters bar */}
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="group"
          aria-label="Filter by status"
          className="flex flex-wrap items-center gap-1"
        >
          {STATUS_FILTERS.map((f) => {
            const active = statusFilter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                aria-pressed={active}
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-ink-secondary hover:bg-subtle hover:text-ink"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor="activity-automation-filter"
            className="text-xs font-medium text-ink-secondary whitespace-nowrap"
          >
            Automation
          </label>
          <select
            id="activity-automation-filter"
            aria-label="Filter by automation"
            value={automationFilter}
            onChange={(e) => setAutomationFilter(e.target.value)}
            className="h-8 rounded-lg border border-border bg-surface px-2.5 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <option value="">All automations</option>
            {automations.map((aut) => (
              <option key={aut.id} value={aut.id}>
                {aut.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Execution list */}
      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : loadError ? (
        <Card className="p-6">
          <p className="text-sm font-medium text-ink">Unable to load activity</p>
          <p className="mt-1 text-sm text-ink-secondary">{loadError}</p>
          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchExecutions()}
            >
              Try again
            </Button>
          </div>
        </Card>
      ) : executions.length === 0 ? (
        <EmptyState
          icon={<Activity className="h-5 w-5" aria-hidden="true" />}
          title={
            statusFilter === "all" && !automationFilter
              ? "No activity yet"
              : "No matching runs"
          }
          description={
            statusFilter === "all" && !automationFilter
              ? "Once your automations receive events or you run a test, every execution will appear here."
              : "Try clearing your status or automation filters to see more runs."
          }
          action={
            statusFilter !== "all" || automationFilter ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStatusFilter("all");
                  setAutomationFilter("");
                }}
              >
                Clear filters
              </Button>
            ) : (
              <Link to="/automations/new">
                <Button size="md">Create an automation</Button>
              </Link>
            )
          }
        />
      ) : (
        <div className="space-y-3">
          {executions.map((exec) => {
            const meta = EXECUTION_STATUS_META[exec.status];
            const StatusIcon = meta.Icon;
            const timestamp = exec.finishedAt ?? exec.startedAt;
            const duration = formatDuration(exec.durationMs);
            const showRetry =
              exec.recovery === "retry" ||
              exec.recovery === "reconnect_then_retry" ||
              exec.recovery === "edit_then_retry" ||
              exec.status === "failed" ||
              exec.status === "needs_review";

            return (
              <Card key={exec.id} data-testid={`execution-row-${exec.id}`}>
                <div className="p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="mt-0.5 shrink-0">
                        <StatusIcon
                          className={`h-4 w-4 ${meta.iconClass}`}
                          aria-hidden={true}
                        />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            to={`/automations/${exec.automationId}`}
                            className="truncate text-sm font-semibold text-ink hover:underline"
                          >
                            {exec.automationName}
                          </Link>
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                          <span className="text-xs text-ink-muted">
                            Attempt {exec.attempt}
                          </span>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 text-sm text-ink-secondary">
                          <span>
                            {exec.triggerSummary ?? "Trigger event received"}
                          </span>
                          <ArrowRight
                            className="h-3.5 w-3.5 shrink-0 text-ink-muted"
                            aria-hidden="true"
                          />
                          <span>
                            {exec.actionSummary ??
                              (exec.status === "filtered"
                                ? "Skipped by filter"
                                : exec.status === "failed" ||
                                    exec.status === "needs_review"
                                  ? "Action did not complete"
                                  : "Processing action")}
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-row items-center gap-3 text-xs text-ink-muted sm:flex-col sm:items-end sm:gap-1">
                      <span title={formatExactTimestamp(timestamp)}>
                        {timestamp
                          ? `${formatRelativeTime(timestamp)} · ${formatExactTimestamp(timestamp)}`
                          : "Queued"}
                      </span>
                      {duration && <span>Duration: {duration}</span>}
                    </div>
                  </div>

                  {(exec.errorMessage || showRetry) && (
                    <div className="mt-3 flex flex-col gap-3 rounded-lg border border-border bg-subtle/60 p-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs leading-relaxed text-danger-text">
                        {exec.errorMessage ??
                          "This run didn't complete. You can try running it again."}
                      </p>

                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        {exec.recovery === "reconnect_then_retry" && (
                          <Link to="/connections">
                            <Button variant="outline" size="sm">
                              Reconnect
                            </Button>
                          </Link>
                        )}
                        {exec.recovery === "edit_then_retry" && (
                          <Link to={`/automations/${exec.automationId}`}>
                            <Button variant="outline" size="sm">
                              Edit automation
                            </Button>
                          </Link>
                        )}
                        {showRetry && (
                          <Button
                            variant="primary"
                            size="sm"
                            loading={Boolean(retryingIds[exec.id])}
                            onClick={() => void handleRetry(exec)}
                          >
                            Try again
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}

          {nextCursor && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="md"
                loading={loadingMore}
                onClick={() => void fetchExecutions(nextCursor)}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
