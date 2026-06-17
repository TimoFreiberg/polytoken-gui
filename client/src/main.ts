import { mount } from "svelte";
import App from "./App.svelte";
import "./app.css";
import { store } from "./lib/store.svelte.js";
import { registerServiceWorker } from "./lib/sw.js";

const app = mount(App, { target: document.getElementById("app")! });

// Register the service worker (PWA installability + push) and raise a refresh prompt
// when a new version installs. Dev-safe (no-ops without serviceWorker support).
registerServiceWorker(() => store.markUpdateReady());

export default app;
