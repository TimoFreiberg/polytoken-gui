import type { PermissionMonitorMode } from "@pantoken/protocol";

export const PERMISSION_MODES: {
  id: PermissionMonitorMode;
  label: string;
  desc: string;
}[] = [
  { id: "standard", label: "Standard", desc: "Prompt for each permission" },
  { id: "bypass", label: "Bypass", desc: "Auto-approve all permissions" },
  {
    id: "bypass_plus",
    label: "Bypass+",
    desc: "Auto-approve except deny rules",
  },
  {
    id: "autonomous",
    label: "Autonomous",
    desc: "Classifier-driven auto-approval",
  },
];

export function permissionModeLabel(mode: PermissionMonitorMode): string {
  return (
    PERMISSION_MODES.find((option) => option.id === mode)?.label ?? "Standard"
  );
}
