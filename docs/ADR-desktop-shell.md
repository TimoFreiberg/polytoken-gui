# ADR — Desktop shell: Tauri now, Bun hub as supervised sidecar, Rust hub behind go/no-go

summary of the current state by the author, as far as i remember:
Tauri is the only frontend right now.
There is one rust backend server impl.
Tauri bundles the entire app.
The app requires Polytoken to be installed locally. 
The app is packaged via GitHub Action, and installed by downloading from GitHub releases. 
The main repo is on GitHub now. 
The server acts as a hub between the GUI frontend and an arbitrary number of polytoken daemons each running one agent session. 
The Tauri front end auto updates the entire app.
