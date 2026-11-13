import * as React from "react";
import { Link } from "react-router-dom";
import { Plus, Workflow } from "lucide-react";
import type { Automation, DashboardStats } from "../../contracts";
import {
  Button,
  Card,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Skeleton,
  useToast,
} from "../../components/ui";
import { api, ApiClientError } from "../../lib/api";
import { useAuth } from "../auth/AuthContext";
import { AutomationCard } from "./AutomationCard";
import { StatsRow } from "./StatsRow";

export function DashboardPage() {
  const { user, organization } = useAuth();
  const { toast } = useToast();

  const [stats, setStats] = React.useState<DashboardStats | null>(null);
  const [automations, setAutomations] = React.useState<Automation[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [togglingIds, setTogglingIds] = React.useState<Record<string, boolean>>({});
  const [deleteTarget, setDeleteTarget] = React.useState<Automation | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const loadData = React.useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(null);
    try {
      const [dashboardData, automationsData] = await Promise.all([
        api.getDashboard(signal),
        api.listAutomations(signal),
      ]);
      setStats(dashboardData);
      setAutomations(automationsData.automations);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      const message =
        err instanceof ApiClientError
          ? err.message
          : "We couldn't load your workspace right now.";
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadData(controller.signal);
    return () => controller.abort();
  }, [loadData]);

  async function handleToggle(automation: Automation, nextActive: boolean) {
    if (togglingIds[automation.id]) return;

    const previousAutomation = automation;
    const previousStats = stats;
    const nextStatus = nextActive ? "active" : "paused";

    setTogglingIds((prev) => ({ ...prev, [automation.id]: true }));

    // Optimistic update
    setAutomations((prev) =>
      prev.map((item) =>
        item.id === automation.id ? { ...item, status: nextStatus } : item,
      ),
    );
    if (previousStats) {
      const delta = nextActive ? (automation.status === "active" ? 0 : 1) : -1;
      setStats({
        ...previousStats,
        activeAutomations: Math.max(0, previousStats.activeAutomations + delta),
      });
    }

    try {
      const updated = nextActive
        ? await api.activateAutomation(automation.id)
        : await api.pauseAutomation(automation.id);

      setAutomations((prev) =>
        prev.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (err) {
      // Rollback on failure
      setAutomations((prev) =>
        prev.map((item) =>
          item.id === previousAutomation.id ? previousAutomation : item,
        ),
      );
      if (previousStats) {
        setStats(previousStats);
      }

      const description =
        err instanceof ApiClientError
          ? err.message
          : "Please check your connections and try again.";

      toast({
        title: nextActive
          ? "Couldn't activate automation"
          : "Couldn't pause automation",
        description,
        variant: "error",
      });
    } finally {
      setTogglingIds((prev) => {
        const copy = { ...prev };
        delete copy[automation.id];
        return copy;
      });
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget || deleting) return;
    const target = deleteTarget;
    setDeleting(true);

    try {
      await api.deleteAutomation(target.id);
      setAutomations((prev) => prev.filter((item) => item.id !== target.id));
      if (target.status === "active") {
        setStats((prev) =>
          prev
            ? { ...prev, activeAutomations: Math.max(0, prev.activeAutomations - 1) }
            : prev,
        );
      }
      setDeleteTarget(null);
      toast({
        title: "Automation deleted",
        description: `“${target.name}” has been removed.`,
        variant: "success",
      });
    } catch (err) {
      const description =
        err instanceof ApiClientError
          ? err.message
          : "We couldn't delete that automation. Please try again.";
      toast({
        title: "Couldn't delete automation",
        description,
        variant: "error",
      });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">
            Welcome, {user?.name ?? "there"}
          </h1>
          <p className="mt-1 text-sm text-ink-secondary">
            {organization?.name
              ? `${organization.name} · Overview of your automations`
              : "Overview of your automations"}
          </p>
        </div>

        {automations.length > 0 && (
          <Link to="/automations/new" className="self-start sm:self-auto">
            <Button size="md">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New automation
            </Button>
          </Link>
        )}
      </div>

      <StatsRow stats={stats} loading={loading} />

      <section aria-label="Automations" className="space-y-3">
        {loading ? (
          <div className="space-y-3">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-24 w-full rounded-xl" />
          </div>
        ) : loadError ? (
          <Card className="p-6">
            <p className="text-sm font-medium text-ink">Unable to load automations</p>
            <p className="mt-1 text-sm text-ink-secondary">{loadError}</p>
            <div className="mt-4">
              <Button variant="outline" size="sm" onClick={() => void loadData()}>
                Try again
              </Button>
            </div>
          </Card>
        ) : automations.length === 0 ? (
          <EmptyState
            icon={<Workflow className="h-5 w-5" aria-hidden="true" />}
            title="No automations yet"
            description="Connect ClickUp to Slack in under 30 seconds. Pick what starts it, choose where it goes, and turn it on."
            action={
              <Link to="/automations/new">
                <Button size="lg">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Create your first automation
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-ink-secondary">
                Your automations ({automations.length})
              </h2>
            </div>
            {automations.map((automation) => (
              <AutomationCard
                key={automation.id}
                automation={automation}
                toggling={Boolean(togglingIds[automation.id])}
                onToggle={handleToggle}
                onDeleteRequest={setDeleteTarget}
              />
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
        labelledBy="delete-automation-title"
        describedBy="delete-automation-desc"
      >
        <DialogHeader>
          <DialogTitle id="delete-automation-title">Delete automation?</DialogTitle>
          <DialogDescription id="delete-automation-desc">
            {deleteTarget
              ? `“${deleteTarget.name}” will be permanently deleted and any active webhooks will be unsubscribed.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={deleting}
            onClick={() => setDeleteTarget(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={deleting}
            onClick={handleConfirmDelete}
          >
            Delete automation
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
