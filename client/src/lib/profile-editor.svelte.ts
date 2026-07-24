import type { RemoteProfile } from "./hosts/types.js";

// Shared profile editor state. Manages the open/close state of the
// RemoteProfileForm sheet and the profile being edited (or null for "add new").
// Same singleton pattern as image-viewer.svelte.ts.

class ProfileEditorState {
  open = $state(false);
  editing = $state<RemoteProfile | null>(null);

  openNew(): void {
    this.editing = null;
    this.open = true;
  }

  openEdit(profile: RemoteProfile): void {
    this.editing = profile;
    this.open = true;
  }

  close(): void {
    this.open = false;
    this.editing = null;
  }
}

export const profileEditor = new ProfileEditorState();
