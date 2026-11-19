//! A connection to a `pty` command's terminal, which its `swb-hold` serves on a Unix socket: raw output to read, and
//! input and resizes sent as frames of a kind byte, a big-endian u32 length and the payload.

use anyhow::{Result, bail};
use std::fs;
use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

/// How long a run that has not started yet may take to open its terminal.
const START_TIMEOUT: Duration = Duration::from_secs(5);

pub struct Pty(UnixStream);

impl Pty {
    pub(crate) fn connect(home: &Path, run_id: &str) -> Result<Pty> {
        if run_id.is_empty() || !run_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            bail!("invalid run id {run_id}");
        }
        let dir = crate::runner::run_dir(home, run_id);
        let deadline = Instant::now() + START_TIMEOUT;
        loop {
            if let Ok(socket) = fs::read_to_string(dir.join("pty")) {
                return match UnixStream::connect(socket.trim_end()) {
                    Ok(stream) => Ok(Pty(stream)),
                    Err(_) => bail!("run {run_id} has ended"),
                };
            }
            if dir.join("exit").exists() || Instant::now() > deadline {
                bail!("run {run_id} has no terminal");
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn try_clone(&self) -> io::Result<Pty> {
        self.0.try_clone().map(Pty)
    }

    pub fn input(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.frame(0, bytes)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        let [c0, c1] = cols.to_be_bytes();
        let [r0, r1] = rows.to_be_bytes();
        self.frame(1, &[c0, c1, r0, r1])
    }

    /// Disconnects every clone; the command keeps running until it has had no client for a while.
    pub fn close(&self) {
        let _ = self.0.shutdown(Shutdown::Both);
    }

    fn frame(&mut self, kind: u8, payload: &[u8]) -> io::Result<()> {
        let mut frame = Vec::with_capacity(5 + payload.len());
        frame.push(kind);
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(payload);
        self.0.write_all(&frame)
    }
}

impl Read for Pty {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.read(buf)
    }
}
