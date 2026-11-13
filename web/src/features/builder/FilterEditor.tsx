import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button, Input } from "../../components/ui";
import type { Filter, FilterOp, VariableDefinition } from "../../contracts";

const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
];

export interface FilterEditorProps {
  filters: Filter[];
  variables: VariableDefinition[];
  fieldErrors?: Record<string, string>;
  onChange: (next: Filter[]) => void;
}

export const FilterEditor: React.FC<FilterEditorProps> = ({
  filters,
  variables,
  fieldErrors = {},
  onChange,
}) => {
  const defaultPath = variables[0]?.path ?? "task.status";

  function handleAdd() {
    onChange([
      ...filters,
      { path: defaultPath, op: "equals", value: "" },
    ]);
  }

  function handleUpdate(index: number, patch: Partial<Filter>) {
    const next = filters.map((item, idx) => {
      if (idx !== index) return item;
      const merged = { ...item, ...patch };
      if (merged.op === "is_empty" || merged.op === "is_not_empty") {
        delete merged.value;
      } else if (merged.value === undefined) {
        merged.value = "";
      }
      return merged;
    });
    onChange(next);
  }

  function handleRemove(index: number) {
    onChange(filters.filter((_, idx) => idx !== index));
  }

  return (
    <div
      data-testid="filter-editor"
      className="space-y-3 rounded-xl border border-border bg-subtle/40 p-3.5"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold text-ink">
            Filter conditions (optional)
          </h3>
          <p className="text-[11px] text-ink-secondary">
            Only run the action when all conditions match.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAdd}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
          Add filter
        </Button>
      </div>

      {filters.length > 0 && (
        <div className="space-y-2.5">
          {filters.map((filter, idx) => {
            const hideValue =
              filter.op === "is_empty" || filter.op === "is_not_empty";
            const pathErr = fieldErrors[`filters.${idx}.path`];
            const valErr = fieldErrors[`filters.${idx}.value`];

            return (
              <div
                key={idx}
                data-testid={`filter-row-${idx}`}
                className="space-y-2 rounded-lg border border-border bg-surface p-2.5"
              >
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Filter ${idx + 1} field`}
                    value={filter.path}
                    onChange={(e) =>
                      handleUpdate(idx, { path: e.target.value })
                    }
                    className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {!variables.some((v) => v.path === filter.path) &&
                      filter.path && (
                        <option value={filter.path}>{filter.path}</option>
                      )}
                    {variables.map((v) => (
                      <option key={v.path} value={v.path}>
                        {v.label} ({v.path})
                      </option>
                    ))}
                  </select>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove filter ${idx + 1}`}
                    onClick={() => handleRemove(idx)}
                    className="h-8 w-8 p-0 text-ink-muted hover:text-danger-text"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                </div>

                <div className="grid gap-2 sm:grid-cols-2">
                  <select
                    aria-label={`Filter ${idx + 1} condition`}
                    value={filter.op}
                    onChange={(e) =>
                      handleUpdate(idx, { op: e.target.value as FilterOp })
                    }
                    className="h-8 w-full rounded-lg border border-border bg-surface px-2 text-xs text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  >
                    {FILTER_OPS.map((op) => (
                      <option key={op.value} value={op.value}>
                        {op.label}
                      </option>
                    ))}
                  </select>

                  {!hideValue && (
                    <Input
                      aria-label={`Filter ${idx + 1} value`}
                      placeholder="Comparison value"
                      value={filter.value ?? ""}
                      error={Boolean(valErr)}
                      onChange={(e) =>
                        handleUpdate(idx, { value: e.target.value })
                      }
                      className="h-8 text-xs"
                    />
                  )}
                </div>

                {pathErr && (
                  <p className="text-[11px] text-danger-text">{pathErr}</p>
                )}
                {valErr && (
                  <p className="text-[11px] text-danger-text">{valErr}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
