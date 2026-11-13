import * as React from "react";
import type { VariableDefinition } from "../../contracts";

export function insertVariableIntoInput(
  el: HTMLTextAreaElement | HTMLInputElement | null,
  currentValue: string,
  variablePath: string,
  onChange: (next: string) => void,
) {
  const token = `{{${variablePath}}}`;
  if (
    el &&
    typeof el.selectionStart === "number" &&
    (document.activeElement === el || el.selectionStart > 0 || el.selectionEnd !== el.selectionStart)
  ) {
    const start = el.selectionStart;
    const end = el.selectionEnd ?? start;
    const next = `${currentValue.slice(0, start)}${token}${currentValue.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const cursor = start + token.length;
      el.setSelectionRange(cursor, cursor);
    });
    return;
  }

  const separator =
    currentValue.length > 0 && !currentValue.endsWith(" ") && !currentValue.endsWith("\n")
      ? " "
      : "";
  onChange(`${currentValue}${separator}${token}`);
}

export interface VariableChipsProps {
  variables: VariableDefinition[];
  onInsert: (variablePath: string) => void;
  label?: string;
}

export const VariableChips: React.FC<VariableChipsProps> = ({
  variables,
  onInsert,
  label = "Insert trigger data",
}) => {
  if (variables.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="text-[11px] font-medium text-ink-muted">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {variables.map((v) => (
          <button
            key={v.path}
            type="button"
            data-testid={`var-chip-${v.path}`}
            onClick={() => onInsert(v.path)}
            title={`${v.label} — e.g. ${v.example}`}
            className="inline-flex items-center gap-1 rounded-md border border-accent/25 bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-medium text-accent transition-colors hover:border-accent/50 hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {`{{${v.path}}}`}
          </button>
        ))}
      </div>
    </div>
  );
};
