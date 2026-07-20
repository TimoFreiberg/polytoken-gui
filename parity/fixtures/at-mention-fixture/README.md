# at-mention fixture

A synthetic project for comparing pantoken's `@`-autocomplete file filtering and
ordering against polytoken's TUI. Each file is deliberately placed to exercise
one edge case (case sensitivity, prefix/interior/suffix matching, dotfiles,
gitignored files, cross-directory matches, typo leniency, directory-before-file
tie-breaking).

See the plan in `plan-001.md` (session `06ez50-jam`) for the full query matrix.
