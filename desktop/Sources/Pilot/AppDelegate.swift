import AppKit
import UniformTypeIdentifiers
import UserNotifications
import WebKit

/// The shell. Boots a local pilot server from the dedicated clone, gates on /health,
/// then shows the web client in a chromeless window and starts the update-watcher.
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: ServerSupervisor!
    private var config: Config!

    private var watcher: Process?
    private var watcherStopped = false
    /// Accumulates raw watcher stdout until a newline; see consumeWatcherOutput.
    private var watcherOutBuffer = Data()

    // "Updating Pilot…" overlay, raised over the webview for the whole apply (build +
    // restart). Native, not web: the web client is exactly what's restarting, so it can't
    // paint its own progress — and the restart leaves it showing a stale, offline page.
    // Driven by the watcher's `apply` events; torn down once the rebuilt server is healthy
    // and the webview has reloaded the fresh build (see webView(_:didFinish:)).
    private var overlay: NSVisualEffectView?
    private var overlaySpinner: NSProgressIndicator?
    private var overlayLabel: NSTextField?
    private var overlayFailsafe: Timer?
    /// True between the first `apply` event and the post-update reload's didFinish — gates
    /// the teardown so an unrelated page load doesn't dismiss an overlay that isn't ours.
    private var updateReloadPending = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()

        // Own update notifications ourselves so they're attributed to Pilot — clicking one
        // focuses the app. (The watcher's osascript fallback is disabled via watcherEnv;
        // its notifications would open Script Editor instead.)
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in }

        guard let port = PortFinder.freePort() else {
            presentFatal("Couldn't find a free local port to run the pilot server on.")
            return
        }
        config = Config.resolve(serverPort: port)

        // The app runs everything from a dedicated clone — a bare `.git` check is enough
        // (it's always a plain `git clone`, not a worktree). Fail with setup instructions
        // rather than a confusing blank window.
        let gitDir = config.clone.appendingPathComponent(".git").path
        guard FileManager.default.fileExists(atPath: gitDir) else {
            presentFatal("""
                No pilot checkout at \(config.clone.path).

                Create it once:
                  git clone <pilot-repo> \(config.clone.path)
                  cd \(config.clone.path) && bun install && bun run build

                Or set PILOT_APP_CLONE to an existing checkout.
                """)
            return
        }
        try? FileManager.default.createDirectory(
            at: config.dataDir, withIntermediateDirectories: true)

        makeWindow()
        showLoading()
        NSApp.activate(ignoringOtherApps: true)

        server = ServerSupervisor(config: config)
        server.onUnrecoverable = { [weak self] msg in self?.presentFatal(msg) }
        server.onHealthy = { [weak self] firstTime in
            guard let self else { return }
            if firstTime {
                self.loadApp()
                self.startWatcher()
            } else {
                // Server came back from a restart (typically an applied update) — reload
                // so the webview picks up the freshly-built client assets.
                self.webView.reload()
            }
        }
        server.start()
    }

    func applicationWillTerminate(_ notification: Notification) {
        watcherStopped = true
        watcher?.terminationHandler = nil
        watcher?.terminate()
        server?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // MARK: - Window / web view

    private func makeWindow() {
        let w = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        w.title = "Pilot"
        // Clean, native chrome: hide the title text and let the content run under a
        // transparent titlebar (traffic lights float over the app's own header). This is
        // the thing the Safari-PWA titlebar couldn't do.
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.isMovableByWindowBackground = false
        w.setFrameAutosaveName("PilotMainWindow")
        w.center()

        let conf = WKWebViewConfiguration()
        conf.websiteDataStore = .default()  // persistent → localStorage / token survive

        let wv = WKWebView(frame: w.contentView!.bounds, configuration: conf)
        wv.autoresizingMask = [.width, .height]
        // WKWebView hands OS-mediated behaviors to its delegates and silently drops them
        // otherwise: the uiDelegate covers the file picker (`<input type=file>`) + new
        // windows (`target=_blank`/`window.open`); the navigationDelegate routes external
        // links to the system browser and turns un-renderable responses into downloads.
        // See the "WKWebView host capabilities" checklist in desktop/README.md.
        wv.uiDelegate = self
        wv.navigationDelegate = self
        w.contentView!.addSubview(wv)

        webView = wv
        window = w
        w.makeKeyAndOrderFront(nil)
    }

    private func showLoading() {
        webView.loadHTMLString(
            """
            <html><body style="margin:0;height:100vh;display:flex;align-items:center;
            justify-content:center;background:#f7f6f2;color:#8a8780;
            font:15px -apple-system,system-ui">Starting Pilot…</body></html>
            """, baseURL: nil)
    }

    private func loadApp() {
        let url = URL(string: "http://127.0.0.1:\(config.serverPort)/")!
        webView.load(URLRequest(url: url))
    }

    // MARK: - Update watcher

    private func startWatcher() {
        guard !watcherStopped else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: config.bunPath)
        p.arguments = ["run", "scripts/desktop/update-watcher.ts"]
        p.currentDirectoryURL = config.clone
        p.environment = config.watcherEnv()

        // Read the watcher's machine channel (one JSON event per stdout line) so we can post
        // a native notification on `update-deferred`. Buffer + dispatch happens on the main
        // queue in consumeWatcherOutput.
        let outPipe = Pipe()
        p.standardOutput = outPipe
        watcherOutBuffer = Data()
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil  // EOF — the watcher exited
                return
            }
            DispatchQueue.main.async { self?.consumeWatcherOutput(chunk) }
        }

        p.terminationHandler = { [weak self] _ in
            // Non-fatal: if the watcher dies, the app keeps working — just respawn it
            // after a beat so auto-update keeps running.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                guard let self, !self.watcherStopped else { return }
                self.startWatcher()
            }
        }
        do {
            try p.run()
            watcher = p
        } catch {
            // Swallow: a missing watcher only costs auto-update, not the app.
            NSLog("Pilot: failed to start update-watcher: \(error.localizedDescription)")
        }
    }

    /// Buffer raw watcher stdout and dispatch each complete line. The watcher emits one JSON
    /// object per line (update-watcher.ts emitEvent); chunks don't arrive line-aligned, so we
    /// accumulate until a newline. On the main queue, so watcherOutBuffer needs no lock.
    private func consumeWatcherOutput(_ chunk: Data) {
        watcherOutBuffer.append(chunk)
        while let nl = watcherOutBuffer.firstIndex(of: 0x0A) {
            let line = watcherOutBuffer.subdata(in: watcherOutBuffer.startIndex..<nl)
            watcherOutBuffer.removeSubrange(watcherOutBuffer.startIndex...nl)
            handleWatcherEvent(line)
        }
    }

    private func handleWatcherEvent(_ line: Data) {
        guard !line.isEmpty,
            let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let event = obj["event"] as? String
        else { return }
        switch event {
        case "update-deferred":
            postUpdateNotification()
        case "desktop-update-available":
            // The native shell (desktop/) changed, so the running .app binary is stale. We do
            // NOT swap + relaunch it ourselves: replacing the bundle in place trips macOS App
            // Management (the in-place self-update exemption needs an Apple Developer ID this
            // ad-hoc-signed app doesn't have). Instead, tell the user to rebuild by hand.
            // Deduped on the sha so the watcher re-emitting every tick doesn't re-buzz.
            postDesktopUpdateNotification(sha: obj["sha"] as? String)
        case "apply":
            // One per apply phase (starting → installing? → building → restarting, or failed).
            // A failure drops the overlay (the sidebar card offers retry); any other phase
            // raises it / refreshes its label.
            if obj["phase"] as? String == "failed" {
                hideUpdateOverlay()
            } else {
                presentUpdateOverlay(obj["label"] as? String ?? "Updating Pilot…")
            }
        default:
            break
        }
    }

    private func postUpdateNotification() {
        let content = UNMutableNotificationContent()
        content.title = "Pilot update ready"
        content.body = "A new version is ready — open Pilot to update."
        // Stable id: if origin/main moves again, the re-notification replaces this one
        // rather than stacking duplicates.
        let req = UNNotificationRequest(
            identifier: "pilot-update-ready", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    // MARK: - Update overlay

    /// Raise (or refresh the label of) the "Updating Pilot…" overlay over the webview. Built
    /// from a frosted NSVisualEffectView scrim + a centered indeterminate spinner + a phase
    /// label — an honest "working, no ETA" busy state (the build emits no real progress, so a
    /// progress bar would be fake). Added ABOVE the webview explicitly; if WKWebView ever
    /// composites over it, the fallback is a separate child overlay window.
    private func presentUpdateOverlay(_ label: String) {
        updateReloadPending = true
        armOverlayFailsafe()

        if let scrim = overlay {
            overlayLabel?.stringValue = label
            scrim.animator().alphaValue = 1  // in case a fade-out was mid-flight
            return
        }
        guard let host = window?.contentView, let webView else { return }

        let scrim = NSVisualEffectView(frame: host.bounds)
        scrim.autoresizingMask = [.width, .height]
        scrim.material = .hudWindow
        scrim.blendingMode = .withinWindow
        scrim.state = .active
        scrim.wantsLayer = true
        // Pin a dark vibrancy so the spinner + label read as light on the frost regardless
        // of the system theme.
        scrim.appearance = NSAppearance(named: .vibrantDark)

        let spinner = NSProgressIndicator()
        spinner.style = .spinning
        spinner.isIndeterminate = true
        spinner.controlSize = .large
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimation(nil)

        let text = NSTextField(labelWithString: label)
        text.font = .systemFont(ofSize: 13, weight: .medium)
        text.textColor = .secondaryLabelColor
        text.alignment = .center
        text.translatesAutoresizingMaskIntoConstraints = false

        scrim.addSubview(spinner)
        scrim.addSubview(text)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: scrim.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: scrim.centerYAnchor, constant: -14),
            text.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 18),
            text.centerXAnchor.constraint(equalTo: scrim.centerXAnchor),
        ])

        scrim.alphaValue = 0
        host.addSubview(scrim, positioned: .above, relativeTo: webView)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.18
            scrim.animator().alphaValue = 1
        }

        overlay = scrim
        overlaySpinner = spinner
        overlayLabel = text
    }

    /// Fade out + remove the overlay. Called on the post-update reload finishing, on an
    /// apply failure, on an unrecoverable server, or by the failsafe timer.
    private func hideUpdateOverlay() {
        updateReloadPending = false
        overlayFailsafe?.invalidate()
        overlayFailsafe = nil
        guard let scrim = overlay else { return }
        overlaySpinner?.stopAnimation(nil)
        overlay = nil
        overlaySpinner = nil
        overlayLabel = nil
        NSAnimationContext.runAnimationGroup(
            { ctx in
                ctx.duration = 0.2
                scrim.animator().alphaValue = 0
            },
            completionHandler: { scrim.removeFromSuperview() })
    }

    /// Drop the overlay if the teardown signal never arrives (e.g. a restart that can't be
    /// SIGTERM'd, or a missed event) so a modal scrim can't strand the window forever.
    private func armOverlayFailsafe() {
        overlayFailsafe?.invalidate()
        // Re-armed at every phase, so this only has to outlast the longest single phase
        // (the build / a cold `bun install`). 5 min is comfortably above that; if a phase
        // somehow overruns it the next `apply` event re-raises the overlay anyway.
        overlayFailsafe = Timer.scheduledTimer(
            withTimeInterval: 300, repeats: false
        ) { [weak self] _ in
            NSLog("Pilot: update overlay failsafe fired — tearing it down")
            self?.hideUpdateOverlay()
        }
    }

    // MARK: - Native shell update (detect-only; the user rebuilds by hand)

    /// Last desktop tree sha we notified about, so the watcher re-emitting
    /// `desktop-update-available` every tick doesn't re-buzz. nil until the first one.
    private var lastNotifiedDesktopSha: String?

    /// The native shell (desktop/) changed, so the running .app binary is stale. We deliberately
    /// do NOT swap + relaunch the bundle ourselves: replacing an installed .app in place trips
    /// macOS App Management (the in-place self-update exemption requires an Apple Developer ID;
    /// this app is ad-hoc signed). So we just tell the user to rebuild with build-app.sh — they
    /// run it in their own shell, which sidesteps the permission entirely. The TS/server/client
    /// layer keeps auto-updating; only the rare native-shell change needs this manual step.
    private func postDesktopUpdateNotification(sha: String?) {
        guard sha != lastNotifiedDesktopSha else { return }  // dedupe the per-tick re-emits
        lastNotifiedDesktopSha = sha
        let content = UNMutableNotificationContent()
        content.title = "Pilot app update ready"
        content.body =
            "The app shell changed. Quit Pilot and run desktop/build-app.sh in "
            + config.clone.path + " to update it."
        // Stable id so a later native change replaces this banner rather than stacking.
        let req = UNNotificationRequest(
            identifier: "pilot-desktop-update-ready", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req)
    }

    // MARK: - Notifications (UNUserNotificationCenterDelegate)

    /// Show the banner even when Pilot is frontmost. The watcher only emits update-deferred
    /// when a client is connected (window open) — without this the banner would be silently
    /// suppressed in the foreground, which is exactly when the user is here to act on it.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) ->
            Void
    ) {
        completionHandler([.banner, .sound])
    }

    /// Clicking the notification focuses Pilot — the whole point of owning notifications here
    /// instead of letting the watcher's osascript fallback open Script Editor.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        completionHandler()
    }

    // MARK: - Menu (so Cmd+Q and copy/paste/select-all work in the web client)

    private func installMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appItem.submenu = appMenu
        appMenu.addItem(withTitle: "Hide Pilot",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Pilot",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editItem.submenu = editMenu
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All",
                         action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        NSApp.mainMenu = main
    }

    private func presentFatal(_ message: String) {
        hideUpdateOverlay()
        let alert = NSAlert()
        alert.messageText = "Pilot can't start"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Quit")
        alert.runModal()
        NSApp.terminate(nil)
    }
}

/// True for the app's own origin (the local pilot server). Off-origin navigations are
/// external links we hand to the system browser rather than load in the chromeless window.
private func isAppLocal(_ url: URL?) -> Bool {
    guard let host = url?.host else { return false }
    return host == "127.0.0.1" || host == "localhost"
}

// MARK: - File picker + new windows (WKUIDelegate)

extension AppDelegate: WKUIDelegate {
    /// Bridge `<input type="file">` to a native NSOpenPanel. WKWebView does NOT show a
    /// picker on its own — without this, the composer's image-attach button is a silent
    /// no-op in the packaged app (it works in a browser because the OS picker is native
    /// there). WebKit requires `completionHandler` be called exactly once: the panel's
    /// completion block covers both the picked-files and cancelled (nil) cases.
    ///
    /// WKOpenPanelParameters surfaces the multi-select / directory flags but NOT the
    /// input's `accept` filter, so we mirror the app's sole file input (`accept="image/*"`)
    /// by restricting to image types. Relax this if a non-image file input ever appears.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.image]
        let finish: (NSApplication.ModalResponse) -> Void = { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            panel.begin(completionHandler: finish)
        }
    }

    /// `target="_blank"` links + `window.open` ask WKWebView for a NEW web view. We have no
    /// multi-window UI, so returning nil (the default) silently drops them — that's why
    /// links in agent output do nothing in the packaged app. Open them in the system
    /// browser instead. (Same-origin pop-ups don't occur in this app; everything here is
    /// an outbound link.)
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
}

// MARK: - Navigation routing + downloads (WKNavigationDelegate)

extension AppDelegate: WKNavigationDelegate {
    /// Tear down the update overlay once the rebuilt server is healthy AND the webview has
    /// reloaded the fresh build (onHealthy(firstTime:false) → reload → here). Gated on
    /// updateReloadPending so an ordinary page load doesn't dismiss it; the SPA routes
    /// client-side, so the only real navigations during an update are our reload.
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if updateReloadPending { hideUpdateOverlay() }
    }

    /// Keep the chromeless window on the app's own origin. A user-clicked external link
    /// opens in the system browser; an `<a download>` (shouldPerformDownload) becomes a
    /// native download. Everything else — the initial load, reloads, same-origin nav,
    /// redirects, form posts — is allowed through untouched.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if navigationAction.shouldPerformDownload {
            decisionHandler(.download)
            return
        }
        if navigationAction.navigationType == .linkActivated,
            let url = navigationAction.request.url, !isAppLocal(url),
            url.scheme == "http" || url.scheme == "https"
        {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// A response the web view can't render (zip, octet-stream, …) is a download, not a
    /// blank page. NOTE: a renderable MIME served with `Content-Disposition: attachment`
    /// still renders inline here — pilot's own server should serve real downloads with a
    /// non-renderable type or trigger them via `<a download>` (handled above).
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        decisionHandler(navigationResponse.canShowMIMEType ? .allow : .download)
    }

    func webView(
        _ webView: WKWebView,
        navigationAction: WKNavigationAction,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }

    func webView(
        _ webView: WKWebView,
        navigationResponse: WKNavigationResponse,
        didBecome download: WKDownload
    ) {
        download.delegate = self
    }
}

// MARK: - Download destination (WKDownloadDelegate)

extension AppDelegate: WKDownloadDelegate {
    /// Generic for ALL downloads, whatever triggers them: ask the user where to save via a
    /// native NSSavePanel (defaulting to ~/Downloads + the suggested filename). WKDownload
    /// fails if the destination already exists, so clear any existing file first. Returning
    /// nil cancels the download (user hit Cancel).
    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping (URL?) -> Void
    ) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(
            for: .downloadsDirectory, in: .userDomainMask
        ).first
        let finish: (NSApplication.ModalResponse) -> Void = { resp in
            guard resp == .OK, let url = panel.url else {
                completionHandler(nil)
                return
            }
            try? FileManager.default.removeItem(at: url)
            completionHandler(url)
        }
        if let window {
            panel.beginSheetModal(for: window, completionHandler: finish)
        } else {
            panel.begin(completionHandler: finish)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        NSLog("Pilot: download failed: \(error.localizedDescription)")
    }
}
