export interface DirectoryMatch {
  name: string;
  prefix: boolean;
}

/** Split an editable path into the directory to list and the unfinished basename. */
export function splitDirectoryInput(input: string): {
  browsePath: string;
  leaf: string;
  viewingDirectory: boolean;
} {
  if (!input) return { browsePath: "", leaf: "", viewingDirectory: true };
  if (input.endsWith("/")) {
    return { browsePath: input, leaf: "", viewingDirectory: true };
  }
  const slash = input.lastIndexOf("/");
  if (slash < 0)
    return { browsePath: ".", leaf: input, viewingDirectory: false };
  return {
    browsePath: slash === 0 ? "/" : input.slice(0, slash),
    leaf: input.slice(slash + 1),
    viewingDirectory: false,
  };
}

/** Complete a child while preserving an absolute, relative, or ~/ display prefix. */
export function completeDirectoryInput(input: string, name: string): string {
  const { browsePath } = splitDirectoryInput(input);
  if (browsePath === "/") return `/${name}/`;
  if (browsePath === ".") return `${name}/`;
  return `${browsePath.replace(/\/+$/, "")}/${name}/`;
}

/** Prefix matches are always first; fuzzy subsequences remain available afterwards. */
export function rankDirectoryMatches(
  entries: readonly string[],
  query: string,
): DirectoryMatch[] {
  const q = query.toLocaleLowerCase();
  const matches = entries
    .map((name, order) => ({
      name,
      order,
      prefix: !q || name.toLocaleLowerCase().startsWith(q),
      fuzzy: !q || fuzzyMatch(q, name.toLocaleLowerCase()),
    }))
    .filter((entry) => entry.fuzzy)
    .sort((a, b) => Number(b.prefix) - Number(a.prefix) || a.order - b.order);
  return matches.map(({ name, prefix }) => ({ name, prefix }));
}

function fuzzyMatch(query: string, target: string): boolean {
  let qi = 0;
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++;
  }
  return qi === query.length;
}
