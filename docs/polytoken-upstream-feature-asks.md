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
