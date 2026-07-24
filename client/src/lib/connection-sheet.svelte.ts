// Shared connection sheet state. Tracks which host id is currently shown in
// the focused ConnectionSheet (or null when hidden). The show/hide decision
// is driven by the ConnectionSheet component reacting to coordinator state.

class ConnectionState {
  /** The host id currently shown in the focused sheet, or null. */
  visibleHostId = $state<string | null>(null);

  show(id: string): void {
    this.visibleHostId = id;
  }

  hide(): void {
    this.visibleHostId = null;
  }
}

export const connectionSheet = new ConnectionState();
