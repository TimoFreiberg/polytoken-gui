// The basenames (without `.ts`) of every pilot-OWNED extension — the ones pilot ships
// in-repo and loads via pi's `additionalExtensionPaths` (D1). This is the SINGLE source
// of truth for the owned set so the three sites that need it can never disagree:
//   - the server (`pi-driver.ts` resolves each name → an absolute path, filters disabled
//     ones in warmUp, projects source:"Pilot" + the frontmatter description in
//     listExtensions, routes the toggle to pilot's `enabledExtensions`);
//   - the client (the Settings UI flags pilot-owned rows + routes their toggles to
//     `enabledExtensions` instead of pi's force-exclude, which Chunk 0 proved is a no-op
//     on `additionalExtensionPaths` entries).
//
// Keeping it in `protocol/` (not `server/`) means the client imports it without pulling
// server code — it's a plain readonly array, no runtime/DOM deps. `pi-driver.ts` derives
// its name→path map from this list so the two can't drift. Add a name here in the same
// chunk that ships the extension file (session-namer = Chunk 2; answer/tasklist = 3/4).
export const PILOT_OWNED_EXTENSION_NAMES: readonly string[] = ["session-namer"];
