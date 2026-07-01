+-------+--------------------------------------+------------------------------------------------+----------------+
| #     | Ask                                  | Why | Effort         |
+-------+--------------------------------------+------------------------------------------------+----------------+
| 1 ⛔  | emitted_at on user/assistant/        | On other history kinds already; without it     | small          |
|       | tool_result history items            | every reloaded transcript fabricates timestamps|                |
|       |                                      | ("56y ago" rows). Persisting a field the       |                |
|       |                                      | daemon already has at emit time. |                |

comment: yep seems obviously good. want to confirm hard that it doesn't already exist, would feel silly if it doesn't.

+-------+--------------------------------------+------------------------------------------------+----------------+
| 2     | Images on POST /prompt               | Unblocks pilot's entire finished image | medium         |
|       | (images?: [{data, media_type}])      | pipeline; the schema's own comment says |                |
|       |                                      | additive fields are planned there, and |                |
|       |                                      | image_reference_resolved half-exists. |                |

comment: yep if missing we need it

+-------+--------------------------------------+------------------------------------------------+----------------+
| 3 ⛔  | mode: "steer" | "follow_up"           | The distinction is real operator semantics     | medium         |
|       | on /turn/input                       | the TUI wants too; pilot's toggle is currently |                |
|       |                                      | fiction. |                |

commetn: nope not necessary. just follow_up is fine, if i want to steer i send and then cancel the current turn

+-------+--------------------------------------+------------------------------------------------+----------------+
| 4     | Document SSE resume (Last-Event-ID)  | Resume apparently works but is contract-       | small–medium   |
|       | + in-flight partial on GET /state    | invisible; attaching mid-turn permanently      |                |
|       |                                      | loses the in-flight partial. Biggest silent-   |                |
|       |                                      | wedge cluster for spotty Tailscale. |                |

comment: hmm i'll take your word for it

+-------+--------------------------------------+------------------------------------------------+----------------+
| 5 ⛔  | Define that /turn/cancel settles     | Your own §E open question — empirically it     | small          |
|       | pending interrogatives (deny-safe)   | doesn't, leaving no escape from a lost- |                |
|       |                                      | approval wedge. A daemon-robustness fix; a     |                |
|       |                                      | crashed TUI has the same problem. |                |

comment: can we know for sure from the api description that it works like that? if so, yeah
+-------+--------------------------------------+------------------------------------------------+----------------+
| 6     | queue_if_busy on /prompt             | Kills the TOCTOU where pilot routes on a       | small          |
|       | (atomic prompt-or-queue)             | cached turn_in_flight — 409 ghost rows or      |                |
|       |                                      | messages queued into an idle session. |                |
comment: hmm i'll take your word for it
+-------+--------------------------------------+------------------------------------------------+----------------+
| 7     | Bulk queue drain                     | GET /turn/input exists; only atomic drain      | small          |
|       | (DELETE /turn/input returning items) | is missing. Unblocks queue-clear/restore-to-   |                |
|       |                                      | composer. |                |
comment: hmm i'll take your word for it
+-------+--------------------------------------+------------------------------------------------+----------------+
| 8     | Per-turn token usage on              | The internal TurnChunk.usage variant has the   | small–medium   |
|       | message_complete                     | counts and never reaches the wire; kills       |                |
|       |                                      | pilot's 1s polling ticker + chars/4 estimate.  |                |
comment: how can you know what the internal data has? polytoken's internals aren't visible, or did you decompile the binary?
+-------+--------------------------------------+------------------------------------------------+----------------+
| 9 ⛔  | custom history item kind             | Live custom messages vanish on reload, | small          |
|       |                                      | breaking turn grouping — history silently      |                |
|       |                                      | drops a message class. |                |
comment: not sure i understand what "live custom messages" are
+-------+--------------------------------------+------------------------------------------------+----------------+
| 10 ⛔ | Persist session_title in             | Cold sessions have no names in any session     | small          |
|       | session.json                         | browser, including polytoken sessions itself.  |                |
comment: can't be, i can title sessions and see the title i set in `polytoken continue`
+-------+--------------------------------------+------------------------------------------------+----------------+
| 11    | available_facets on the snapshot     | Symmetry with available_skills/ | small          |
|       |                                      | available_subagents; replaces the vfs shell-   |                |
|       |                                      | out you decided on. |                |
comment: if available_skills and available_subagents exists, yeah would be nice
+-------+--------------------------------------+------------------------------------------------+----------------+
| 12    | Read-only observer attach            | Watch from the phone while the TUI holds       | large          |
|       | (lease-free SSE)                     | control; also what would make GUI⇄TUI parity   |                |
|       |                                      | diffing automatable. Biggest, most speculative |                |
|       |                                      | ask. |                |
comment: yeah would be neat but definitely most speculative ask :D
+-------+--------------------------------------+------------------------------------------------+----------------+

---

## Verification round (Fable, 2026-07-01)

Every questioned item re-verified against **ground truth from the local binary**:
`polytoken openapi` dumped fresh from **0.4.0-unstable.4** (vendored wire-types are from
unstable.2 — diffed them: **u2→u4 changed nothing**: same 44 paths, no new DaemonEvent
variants, `PromptRequest` still `{content, max_tool_turns}`, `/events` still declares no
params). Plus real on-disk session dirs under `~/.local/share/polytoken/sessions` (80 dirs).

**#1 `emitted_at` — CONFIRMED missing, ask stands.** In the unstable.4 spec, every history
item kind carries `emitted_at` (`session_lifecycle`, `state_update`, `model_switch`,
`compaction_fencepost`, `system_reminder`, `classifier_decision`, `context_cleared`,
`image_reference`) **except exactly `user`, `assistant`, `tool_result`** (and `facet_switch`).
Not silly — the gap is real and oddly specific to the three kinds a transcript is made of.

**#3 steer/follow_up — dropped per your call.** (Your workflow: send follow-up, cancel turn
if you wanted a steer.) Not filing.

**#5 `/turn/cancel` — the spec is silent, which is the point; ask stands, reframed as
"define/document".** The endpoint's entire documented contract is: 202 "Turn cancellation
accepted" / 409 "No turn is in flight". Nothing about pending interrogatives either way —
so no, we can't know from the API description, and empirically (NEXT-SESSION §E) it did NOT
unblock an interrogative-blocked turn. The ask is precisely "please define (ideally:
settles interrogatives deny-safe) and document it".

**#8 usage — no decompilation :) It's in the published spec.** `TurnChunk` is a schema in
the `polytoken openapi` output itself, with a `usage` variant carrying
`input_tokens`/`output_tokens`/`cache_creation_input_tokens`/`cache_read_input_tokens` —
re-confirmed in the fresh unstable.4 dump. Bonus on-disk evidence: the daemon writes a
`log.jsonl.usage` sidecar per session (`{"message_count":873,"usage":{"input_tokens":10746,
"output_tokens":32,...}}`), so per-message accounting demonstrably exists end-to-end; the
ask is only "surface it on SSE/state". Ask stands.

**#9 custom history kind — WITHDRAWN, my agents got this one wrong.** "Live custom
messages" = pilot's `customMessage` transcript events, which come from the daemon's
`system_reminder` SSE events (event-map.ts:1077-1094; plan-review ones render as visible
inject pills, the rest are invisible turn-boundary markers for `groupTurns`). The claim was
that these vanish on reload because history has no such kind — **false**: `system_reminder`
IS a persisted history item kind, in unstable.4 AND in our own vendored wire-types (line
1922). The real bug is pilot-side: `history-seed.ts` replays only `user`/`assistant`/
`tool_result` and silently drops the other NINE kinds (system_reminder, compaction_fencepost,
model_switch, facet_switch, context_cleared, ...). Filed as a pilot todo instead — it also
explains reloaded transcripts losing turn grouping and compaction rows.

**#10 session_title — ask STANDS, and your counter-observation is explained.** Surveyed all
80 session dirs: `session_title` exists in exactly ONE file anywhere — `record.json` of the
one currently-LIVE daemon (record.json = the pid/port liveness record; 79 dead sessions
have none, and no title key exists in any session.json or log.jsonl — the log matches were
false positives, quoted docs inside prompts). So `polytoken continue` can show titles for
sessions whose daemon record still exists, but a genuinely cold session's title is gone.
If you want to be extra sure: title a session, `/quit` its daemon, check
`~/.local/share/polytoken/sessions/<id>/` — no title survives.

**#11 available_facets — confirmed, ask stands.** `SessionStateSnapshot` in unstable.4 has
`available_models`, `available_skills`, `available_subagents` — and no `available_facets`.

**#2 (images), #4 (SSE resume), #6 (queue_if_busy), #7 (bulk drain)** — re-confirmed
unchanged in unstable.4 (no image field, `/events` param-less, `PendingTurnInputRequest`
still `{content}`-only, still only `DELETE /turn/input/newest`). All stand as written.
+-------+--------------------------------------+------------------------------------------------+----------------+
