//! Filesystem/environment resolution for the bundled runtime.
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const PATH_START: &str = "__DAVE_PATH_START__";
const PATH_END: &str = "__DAVE_PATH_END__";

/// Bundled node: Tauri copies `externalBin` `binaries/node` next to the main
/// executable (Contents/MacOS/node, or target/<profile>/node in dev).
pub fn bundled_node() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("current_exe: {e}"))?;
    let node = exe
        .parent()
        .ok_or("executable has no parent directory")?
        .join("node");
    if node.is_file() {
        Ok(node)
    } else {
        Err(format!("bundled node not found at {}", node.display()))
    }
}

pub fn log_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/tmp"));
    home.join("Library/Logs/DAVE")
}

/// PATH from the user's interactive login shell, so git/ezcoder resolve when
/// launched from Finder (launchd gives GUI apps a minimal PATH). A sentinel
/// isolates the value from any rc-file noise; a timeout guards slow/hung rc files.
pub fn login_shell_path() -> String {
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/')).unwrap_or_else(|| "/bin/zsh".into());
    let script = format!("printf '%s%s%s' '{PATH_START}' \"$PATH\" '{PATH_END}'");
    let child = Command::new(&shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env("DISABLE_AUTO_UPDATE", "true")
        .spawn();
    let Ok(mut child) = child else { return FALLBACK_PATH.into() };
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return FALLBACK_PATH.into();
            }
        }
    }
    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut out);
    }
    parse_sentinel(&out).unwrap_or_else(|| FALLBACK_PATH.into())
}

fn parse_sentinel(out: &str) -> Option<String> {
    let start = out.rfind(PATH_START)? + PATH_START.len();
    let end = start + out[start..].find(PATH_END)?;
    let path = out[start..end].trim();
    (!path.is_empty()).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_sentinel_amid_noise() {
        let out = format!("motd\n{PATH_START}/a:/b{PATH_END}\nbye");
        assert_eq!(parse_sentinel(&out).as_deref(), Some("/a:/b"));
        assert_eq!(parse_sentinel("nothing"), None);
    }
}
