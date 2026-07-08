//! Memorable worktree-name slugs.
//!
//! Faithful port of `server/src/shared/worktree-name.ts`.

use rand::Rng;

pub const ADJECTIVES: &[&str] = &[
    "amber", "brave", "brisk", "calm", "clever", "cobalt", "copper", "coral", "crisp", "dapper",
    "deft", "eager", "fleet", "fond", "gentle", "glad", "golden", "hardy", "hazel", "jade",
    "jolly", "keen", "lively", "lucid", "lunar", "mellow", "merry", "mild", "nimble", "noble",
    "peppy", "placid", "plucky", "polar", "proud", "quick", "quiet", "rapid", "rosy", "ruby",
    "rustic", "sage", "sandy", "sleek", "snug", "solar", "spry", "stout", "sunny", "swift", "tidy",
    "trusty", "vivid", "warm", "wily", "witty", "zesty",
];

pub const ANIMALS: &[&str] = &[
    "otter", "badger", "finch", "heron", "lemur", "marten", "ocelot", "panda", "quail", "raven",
    "robin", "sable", "tapir", "vole", "walrus", "wombat", "yak", "zebra", "bison", "crane",
    "dingo", "egret", "ferret", "gecko", "gopher", "hawk", "ibex", "jackal", "koala", "lynx",
    "mole", "newt", "osprey", "puma", "rabbit", "seal", "stoat", "toad", "viper", "weasel", "wren",
    "falcon", "beaver", "mantis", "cricket", "sparrow", "magpie", "kestrel", "pelican", "narwhal",
    "manatee", "meerkat", "mongoose", "possum", "raccoon", "salmon", "turtle", "antelope",
    "dolphin", "puffin",
];

fn pick<'a>(arr: &'a [&str]) -> &'a str {
    let mut rng = rand::rng();
    let index = rng.random_range(0..arr.len());
    arr[index]
}

/// A memorable `adjective-animal` worktree slug (e.g. "brisk-otter").
pub fn random_worktree_name() -> String {
    format!("{}-{}", pick(ADJECTIVES), pick(ANIMALS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_a_two_word_adjective_animal_slug() {
        for _ in 0..100 {
            let name = random_worktree_name();
            let parts: Vec<&str> = name.split('-').collect();
            assert_eq!(parts.len(), 2, "name should contain one hyphen: {name}");
            assert!(ADJECTIVES.contains(&parts[0]), "unknown adjective: {name}");
            assert!(ANIMALS.contains(&parts[1]), "unknown animal: {name}");
            assert!(name.chars().all(|c| c.is_ascii_lowercase() || c == '-'));
        }
    }

    #[test]
    fn varies_across_calls_not_a_constant() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..50 {
            seen.insert(random_worktree_name());
        }
        assert!(seen.len() > 5, "seen only {} distinct names", seen.len());
    }
}
