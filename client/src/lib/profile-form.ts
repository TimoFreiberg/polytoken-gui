// Pure validation logic for the RemoteProfileForm. Extracted so it can be
// unit-tested without a DOM, and shared between the form component and tests.
//
// No Svelte, no DOM — pure functions.

import type { ExecutionTargetProfile } from "./hosts/types.js";

export interface ProfileFormDraft {
  label: string;
  sshDestination: string;
  port: string;
  remoteRootOverride: string;
  serverPath: string;
  executionTarget: ExecutionTargetProfile;
  dockerContainerName: string;
  dockerUser: string;
  dockerWorkdir: string;
  dockerPantokenRoot: string;
}

function isAbsolutePath(p: string): boolean {
  return p.startsWith("/");
}

/** Validate a profile form draft. Returns an error message, or null if valid. */
export function validateProfileDraft(draft: ProfileFormDraft): string | null {
  if (!draft.label.trim()) return "Name is required";
  if (!draft.sshDestination.trim()) return "SSH destination is required";
  const port = draft.port.trim();
  if (port) {
    const n = Number(port);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return "Port must be an integer between 1 and 65535";
    }
  }
  const rootOverride = draft.remoteRootOverride.trim();
  if (rootOverride && !isAbsolutePath(rootOverride)) {
    return "Remote-root override must be an absolute path (starting with /)";
  }
  const serverPath = draft.serverPath.trim();
  if (serverPath && !isAbsolutePath(serverPath)) {
    return "Server path must be an absolute path (starting with /)";
  }
  if (draft.executionTarget.kind === "dockerContainer") {
    if (!draft.dockerContainerName.trim()) return "Container name is required for Docker targets";
    if (!draft.dockerUser.trim()) return "User is required for Docker targets";
    if (!draft.dockerPantokenRoot.trim()) return "Pantoken root is required for Docker targets";
    const root = draft.dockerPantokenRoot.trim();
    if (!isAbsolutePath(root)) return "Pantoken root must be an absolute path (starting with /)";
    const workdir = draft.dockerWorkdir.trim();
    if (workdir && !isAbsolutePath(workdir)) return "Workdir must be an absolute path (starting with /)";
  }
  return null;
}
