use std::env;

fn main() {
    println!("cargo:rerun-if-env-changed=PANTOKEN_BUILD_SHA");
    println!("cargo:rerun-if-env-changed=PANTOKEN_RELEASE_BUILD");

    let profile = env::var("PROFILE").unwrap_or_default();
    let release = profile == "release" || env::var("PANTOKEN_RELEASE_BUILD").as_deref() == Ok("1");
    let value = env::var("PANTOKEN_BUILD_SHA").unwrap_or_default();

    if release {
        if !is_full_sha(&value) {
            panic!(
                "PANTOKEN_BUILD_SHA must be exactly 40 lowercase hexadecimal characters for release builds"
            );
        }
    } else if value.is_empty() {
        println!("cargo:rustc-env=PANTOKEN_BUILD_SHA=dev-local");
        return;
    }

    println!("cargo:rustc-env=PANTOKEN_BUILD_SHA={value}");
}

fn is_full_sha(value: &str) -> bool {
    value.len() == 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::is_full_sha;

    #[test]
    fn accepts_only_lowercase_full_sha1() {
        assert!(is_full_sha(&"a".repeat(40)));
        assert!(!is_full_sha(&"A".repeat(40)));
        assert!(!is_full_sha("abc"));
        assert!(!is_full_sha(&"a".repeat(41)));
    }
}
