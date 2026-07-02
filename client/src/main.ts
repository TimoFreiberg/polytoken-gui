import { disableD2 } from "markstream-svelte";
import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import "./markstream-theme.css";
import { store } from "./lib/store.svelte.js";
import { registerServiceWorker } from "./lib/sw.js";

// Pilot doesn't ship the optional @terrastruct/d2 dependency, but markstream
// probes for it on every finalized markdown block — an unhandled rejection per
// block that also aborts that block's footnote/tooltip enhancement pass. Opt
// out once at startup; to enable D2 diagrams, install @terrastruct/d2 and
// delete this call.
disableD2();

const app = mount(App, { target: document.getElementById("app")! });

// Register the service worker (PWA installability + push) and raise a refresh prompt
// when a new version installs. Dev-safe (no-ops without serviceWorker support).
registerServiceWorker(() => store.markUpdateReady());

export default app;
