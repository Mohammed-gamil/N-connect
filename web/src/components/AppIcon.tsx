import type { AppId } from "../contracts";
import { cn, getAppName } from "../lib/utils";

export interface AppIconProps {
  appId: AppId;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses: Record<NonNullable<AppIconProps["size"]>, string> = {
  sm: "h-6 w-6",
  md: "h-8 w-8",
  lg: "h-10 w-10",
};

export function AppIcon({ appId, size = "md", className }: AppIconProps) {
  const name = getAppName(appId);
  return (
    <img
      src={`/icons/${appId}.svg`}
      alt={name}
      title={name}
      className={cn("shrink-0 rounded-lg border border-border/70 bg-subtle object-contain", sizeClasses[size], className)}
    />
  );
}
