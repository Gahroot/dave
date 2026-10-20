//! Supervises the bundled Node server: port selection, spawn in its own
//! process group, health polling, crash detection and graceful shutdown.
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::paths;

pub const PREFERRED_PORT: u16 = 4317;
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const STOP_GRACE: Duration = Duration::from_secs(8);
const LOG_CAP: u64 = 5 * 1024 * 1024;
const PASSTHROUGH_ENV: [&str; 3] = ["PCC_HOME", "PCC_MOBILE_PORT", "DAVE_AGENT_COMMAND"];

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Status {
    Starting { port: u16 },
    Running { port: u16, url: String },
    Failed { message: String, log_tail: String, log_path: String, crashed: bool },
}

struct Inner {
    child: Option<Child>,
    generation: u64,
    port: u16,
    status: Status,
    log_offset: u64,
}

/// Cheaply clonable handle to the supervisor state.
#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
    resource_dir: PathBuf,
    shell_path: Arc<OnceLock<String>>,
}

/// Events for the UI layer (navigation), delivered from background threads.
pub enum Event {
    Healthy(u16),
    Failed,
}

impl Supervisor {
    pub fn new(resource_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                child: None,
                generation: 0,
                port: 0,
                status: Status::Starting { port: 0 },
                log_offset: 0,
            })),
            resource_dir,
            shell_path: Arc::new(OnceLock::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn status(&self) -> Status {
        self.lock().status.clone()
    }

    pub fn port(&self) -> u16 {
        self.lock().port
    }

    pub fn log_path() -> PathBuf {
        paths::log_dir().join("server.log")
    }

    /// (Re)start the server; `notify` runs on a background thread when the
    /// server becomes healthy or fails (early exit, timeout, later crash).
    pub fn start(&self, notify: impl Fn(Event) + Send + 'static) {
        self.stop();
        let port = pick_port();
        let generation = {
            let mut g = self.lock();
            g.generation += 1;
            g.port = port;
            g.status = Status::Starting { port };
            g.generation
        };
        match self.spawn(port) {
            Ok((child, offset)) => {
                let mut g = self.lock();
                g.child = Some(child);
                g.log_offset = offset;
            }
            Err(message) => {
                self.fail(generation, message, false);
                notify(Event::Failed);
                return;
            }
        }
        let this = self.clone();
        std::thread::spawn(move || this.watch(generation, port, notify));
    }

    fn spawn(&self, port: u16) -> Result<(Child, u64), String> {
        let node = paths::bundled_node()?;
        let server_dir = self.resource_dir.join("server");
        let entry = server_dir.join("src/server/index.ts");
        if !entry.is_file() {
            return Err(format!("server entry not found at {}", entry.display()));
        }
        let (log, offset) = open_log()?;
        let err = log.try_clone().map_err(|e| format!("log clone: {e}"))?;
        let mut cmd = Command::new(node);
        cmd.arg("--experimental-strip-types")
            .arg(&entry)
            .current_dir(&server_dir)
            .env("PORT", port.to_string())
            .env("NODE_ENV", "production")
            .env("PATH", self.shell_path.get_or_init(paths::login_shell_path))
            .stdin(Stdio::null())
            .stdout(log)
            .stderr(err)
            .process_group(0);
        // The rest of the environment (HOME, PCC_HOME, PCC_MOBILE_PORT,
        // DAVE_AGENT_COMMAND, ...) is inherited unchanged; make that explicit.
        for key in PASSTHROUGH_ENV {
            if let Some(v) = std::env::var_os(key) {
                cmd.env(key, v);
            }
        }
        let child = cmd.spawn().map_err(|e| format!("failed to spawn node: {e}"))?;
        Ok((child, offset))
    }

    fn watch(&self, generation: u64, port: u16, notify: impl Fn(Event)) {
        let deadline = Instant::now() + HEALTH_TIMEOUT;
        let mut healthy = false;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let exited = {
                let mut g = self.lock();
                if g.generation != generation {
                    return;
                }
                match g.child.as_mut().map(|c| c.try_wait()) {
                    Some(Ok(None)) => None,
                    Some(Ok(Some(st))) => Some(format!("server exited ({st})")),
                    Some(Err(e)) => Some(format!("server wait failed: {e}")),
                    None => Some("server is not running".into()),
                }
            };
            if let Some(message) = exited {
                let msg = if healthy { format!("The DAVE server stopped unexpectedly: {message}") } else { message };
                self.fail(generation, msg, healthy);
                notify(Event::Failed);
                return;
            }
            if healthy {
                continue;
            }
            if health_ok(port) {
                healthy = true;
                {
                    let mut g = self.lock();
                    if g.generation != generation {
                        return;
                    }
                    g.status = Status::Running { port, url: server_url(port) };
                }
                notify(Event::Healthy(port));
            } else if Instant::now() > deadline {
                self.stop();
                self.fail(generation, format!("server did not become healthy within {}s", HEALTH_TIMEOUT.as_secs()), false);
                notify(Event::Failed);
                return;
            }
        }
    }

    fn fail(&self, generation: u64, message: String, crashed: bool) {
        let mut g = self.lock();
        if g.generation != generation {
            return;
        }
        g.child = None;
        let log_path = Self::log_path();
        g.status = Status::Failed {
            message,
            log_tail: log_tail(&log_path, g.log_offset, 40),
            log_path: log_path.display().to_string(),
            crashed,
        };
    }

    /// SIGTERM the child's process group, wait up to 8 s, then SIGKILL.
    pub fn stop(&self) {
        let child = {
            let mut g = self.lock();
            g.generation += 1; // invalidate watchers
            g.child.take()
        };
        let Some(mut child) = child else { return };
        let pgid = child.id() as libc::pid_t;
        signal_group(pgid, libc::SIGTERM);
        let deadline = Instant::now() + STOP_GRACE;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    signal_group(pgid, libc::SIGKILL);
                    let _ = child.wait();
                    break;
                }
            }
        }
        // Reap any stragglers still in the group (e.g. grandchildren).
        signal_group(pgid, libc::SIGKILL);
    }
}

fn signal_group(pgid: libc::pid_t, sig: libc::c_int) {
    if pgid > 1 {
        // SAFETY: kill(2) with a negative pid signals our own child's process group.
        unsafe {
            libc::kill(-pgid, sig);
        }
    }
}

pub fn server_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// 4317 if free, otherwise an OS-assigned free loopback port.
pub fn pick_port() -> u16 {
    if TcpListener::bind((Ipv4Addr::LOCALHOST, PREFERRED_PORT)).is_ok() {
        return PREFERRED_PORT;
    }
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(PREFERRED_PORT)
}

fn health_ok(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(500)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = s.set_write_timeout(Some(Duration::from_secs(2)));
    let req = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = s.read(&mut buf).unwrap_or(0);
    let head = String::from_utf8_lossy(&buf[..n]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
}

/// Opens server.log for appending, truncating it first when over the cap.
/// Returns the file and the offset where this run's output begins.
fn open_log() -> Result<(File, u64), String> {
    let path = Supervisor::log_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    if std::fs::metadata(&path).map(|m| m.len() > LOG_CAP).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.1"));
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let _ = writeln!(f, "\n--- DAVE desktop: starting server ---");
    let offset = f.seek(SeekFrom::End(0)).unwrap_or(0);
    Ok((f, offset))
}

fn log_tail(path: &Path, from: u64, lines: usize) -> String {
    let Ok(mut f) = File::open(path) else { return String::new() };
    let _ = f.seek(SeekFrom::Start(from));
    let mut s = String::new();
    let _ = f.take(LOG_CAP).read_to_string(&mut s);
    let all: Vec<&str> = s.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}
