//! LRU eviction policy for a driver's kept-warm session set. Pure + generic so
//! the policy is unit-tested without touching real sessions.
//!
//! Faithful port of `server/src/shared/warm-cap.ts`.

/// Pick the least-recently-focused ids to evict so the set fits `cap`. `order`
/// is oldest→newest by focus recency; `protected_id` is never evicted (the
/// session about to be focused); `evictable` filters out sessions that must not
/// be evicted right now (e.g. a mid-turn background session — evicting it kills
/// the running turn and makes it look finished via the synthetic
/// `sessionClosed`); `cap` ≤ 0 means unbounded (evict nothing).
///
/// When not enough sessions are evictable to reach the cap, the returned list is
/// shorter than `need` — the caller stays temporarily over-cap until a turn
/// finishes or another session is focused. The caller should log loudly in that
/// case.
pub fn eviction_plan<T, F>(order: &[T], protected_id: Option<&T>, cap: i64, evictable: F) -> Vec<T>
where
    T: PartialEq + Clone,
    F: Fn(&T) -> bool,
{
    if cap <= 0 || (order.len() as i64) <= cap {
        return Vec::new();
    }
    let need = order.len() as i64 - cap;
    let mut evict: Vec<T> = Vec::new();
    for id in order {
        if evict.len() as i64 >= need {
            break;
        }
        if Some(id) == protected_id {
            continue;
        }
        if !evictable(id) {
            continue;
        }
        evict.push(id.clone());
    }
    evict
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The default predicate: everything is evictable (backward compat with the
    /// no-predicate TS overload).
    fn all(_: &&str) -> bool {
        true
    }

    #[test]
    fn no_eviction_when_within_the_cap() {
        assert_eq!(
            eviction_plan(&["a", "b", "c"], Some(&"c"), 8, all),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn evicts_the_oldest_when_over_the_cap() {
        assert_eq!(
            eviction_plan(&["a", "b", "c"], Some(&"c"), 2, all),
            vec!["a"]
        );
    }

    #[test]
    fn evicts_multiple_oldest_to_reach_the_cap() {
        assert_eq!(
            eviction_plan(&["a", "b", "c", "d"], Some(&"d"), 2, all),
            vec!["a", "b"]
        );
    }

    #[test]
    fn never_evicts_the_protected_about_to_focus_id() {
        // "a" is oldest, but it's the protected id, so "b" goes instead.
        assert_eq!(
            eviction_plan(&["a", "b", "c"], Some(&"a"), 2, all),
            vec!["b"]
        );
    }

    #[test]
    fn cap_le_zero_means_unbounded() {
        assert_eq!(
            eviction_plan(&["a", "b", "c"], Some(&"a"), 0, all),
            Vec::<&str>::new()
        );
        assert_eq!(
            eviction_plan(&["a", "b", "c"], Some(&"a"), -1, all),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn skips_a_non_evictable_running_session_evicts_next_idle() {
        // "a" is oldest but running → skipped; "b" is the next idle candidate.
        assert_eq!(
            eviction_plan(&["a", "b", "c"], Some(&"c"), 2, |id| *id != "a"),
            vec!["b"]
        );
    }

    #[test]
    fn evicts_multiple_idle_skipping_running_ones_in_between() {
        // need=2: "a" (idle→evict), "b" (running→skip), "c" (idle→evict), "d" (protected)
        assert_eq!(
            eviction_plan(&["a", "b", "c", "d"], Some(&"d"), 2, |id| *id != "b"),
            vec!["a", "c"]
        );
    }

    #[test]
    fn allows_over_cap_when_all_candidates_are_running() {
        // need=2: "a" running, "b" running, "c" protected → nothing evictable
        assert_eq!(
            eviction_plan(&["a", "b", "c"], Some(&"c"), 1, |_| false),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn partial_over_cap_when_some_but_not_enough_are_evictable() {
        // need=3: "a" (evict), "b" (skip), "c" (evict), "d" (skip), "e" (protected)
        // Only 2 of 3 needed → stays over-cap by 1.
        assert_eq!(
            eviction_plan(&["a", "b", "c", "d", "e"], Some(&"e"), 2, |id| *id != "b"
                && *id != "d"),
            vec!["a", "c"]
        );
    }

    #[test]
    fn default_predicate_matches_original_behavior() {
        assert_eq!(
            eviction_plan(&["a", "b", "c"], Some(&"c"), 2, all),
            vec!["a"]
        );
        assert_eq!(
            eviction_plan(&["a", "b", "c", "d"], Some(&"d"), 2, all),
            vec!["a", "b"]
        );
    }
}
