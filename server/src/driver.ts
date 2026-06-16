// The seam between the WS hub and whatever produces session events. The mock
// driver (M0) and the real pi-sdk driver (M5) both implement this, so the hub
// never changes when we swap the fixture for a live agent.

import type { HostUiResponse, SessionDriverEvent } from "@pilot/protocol";

export interface PilotDriver {
  subscribe(listener: (ev: SessionDriverEvent) => void): () => void;
  prompt(text: string, deliverAs?: "steer" | "followUp"): void;
  abort(): void;
  respondUi(response: HostUiResponse): void;
  /** Dev-only: jump the mock to a named scripted state. No-op for the real driver. */
  runScript?(name: string): void;
}
