import { Link } from "react-router-dom";
import { ArrowRight, Pencil, Trash2 } from "lucide-react";
import type { Automation, AutomationStatus, ExecutionStatus } from "../../contracts";
import { AppIcon } from "../../components/AppIcon";
import { Badge, Button, Card, Switch } from "../../components/ui";
import { cn, formatRelativeTime } from "../../lib/utils";

interface AutomationCardProps {
  automation: Automation;
  toggling: boolean;
  onToggle: (automation: Automation, nextActive: boolean) => void;
  onDeleteRequest: (automation: Automation) => void;
}

function getStatusBadge(status: AutomationStatus): {
  label: string;
  variant: "success" | "neutral" | "danger";
} {
  switch (status) {
    case "active":
      return { label: "Active", variant: "success" };
    case "paused":
      return { label: "Paused", variant: "neutral" };
    case "error":
      return { label: "Needs attention", variant: "danger" };
    case "draft":
    default:
      return { label: "Draft", variant: "neutral" };
  }
}

function getExecutionStatusMeta(status: ExecutionStatus | null): {
  label: string;
  dotClass: string;
} | null {
  if (!status) return null;
  switch (status) {
    case "succeeded":
      return { label: "Last run succeeded", dotClass: "bg-success" };
    case "failed":
      return { label: "Last run failed", dotClass: "bg-danger" };
    case "needs_review":
      return { label: "Needs review", dotClass: "bg-warning" };
    case "filtered":
      return { label: "Filtered", dotClass: "bg-ink-muted" };
    case "running":
    case "sending":
    case "queued":
      return { label: "Running", dotClass: "bg-accent" };
  }
}

export function AutomationCard({
  automation,
  toggling,
  onToggle,
  onDeleteRequest,
}: AutomationCardProps) {
  const isActive = automation.status === "active";
  const statusBadge = getStatusBadge(automation.status);
  const execMeta = getExecutionStatusMeta(automation.lastExecutionStatus);
  const relativeTime = formatRelativeTime(automation.lastExecutionAt);

  return (
    <Card className="transition-colors duration-150 hover:border-border-strong">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3.5">
          <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
            <AppIcon appId={automation.definition.trigger.application} size="md" />
            <ArrowRight className="h-3.5 w-3.5 text-ink-muted" aria-hidden="true" />
            <AppIcon appId={automation.definition.action.application} size="md" />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to={`/automations/${automation.id}`}
                className="truncate text-sm font-semibold text-ink hover:text-accent focus-visible:outline-none focus-visible:underline"
              >
                {automation.name}
              </Link>
              <Badge variant={statusBadge.variant}>{statusBadge.label}</Badge>
            </div>

            <p className="mt-1 text-sm leading-relaxed text-ink-secondary">
              {automation.summary}
            </p>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
              {execMeta ? (
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", execMeta.dotClass)}
                    aria-hidden="true"
                  />
                  <span>{execMeta.label}</span>
                  <span aria-hidden="true">·</span>
                  <span>{relativeTime}</span>
                </span>
              ) : (
                <span>No runs yet</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3 sm:justify-end sm:border-t-0 sm:pt-0">
          <div className="flex items-center gap-2">
            <Switch
              checked={isActive}
              disabled={toggling}
              aria-label={`Toggle ${automation.name}`}
              onCheckedChange={(nextChecked) => onToggle(automation, nextChecked)}
            />
          </div>

          <div className="flex items-center gap-1">
            <Link to={`/automations/${automation.id}`}>
              <Button variant="outline" size="sm">
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                Edit
              </Button>
            </Link>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${automation.name}`}
              onClick={() => onDeleteRequest(automation)}
              className="text-ink-muted hover:bg-danger-soft hover:text-danger-text"
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
