PARITY TEST PROJECT — first line is a known fixed value.

This is a throwaway project used by the GUI⇄TUI parity harness. An agent drives
sessions here from both the pilot GUI and the polytoken TUI. Nothing here is
precious — `parity project reset` recreates it.

The first line above ("PARITY TEST PROJECT — first line is a known fixed value.") is a
deterministic anchor: a prompt like "reply with exactly the first line of README.md" has
a fixed expected answer for parity assertions.
