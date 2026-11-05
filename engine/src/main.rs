//! Meridex matching engine process.
//!
//! `meridex-engine`            serve HTTP
//! `meridex-engine replay`     rebuild state from the journal and print the hash

use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::ExitCode;

use meridex_engine::http_server::{config_from_env, fsync_from_env, spawn};
use meridex_engine::journal;
use meridex_engine::service::Service;
use meridex_engine::types::Command;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("replay") => cmd_replay(),
        Some("batch") => cmd_batch(),
        Some("serve") | None => cmd_serve(),
        Some(other) => {
            eprintln!("unknown command {other}. Use serve | replay | batch");
            ExitCode::from(2)
        }
    }
}

fn journal_path() -> PathBuf {
    std::env::var("ENGINE_JOURNAL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/engine-journal.jsonl"))
}

fn cmd_serve() -> ExitCode {
    let bind = std::env::var("ENGINE_BIND").unwrap_or_else(|_| "0.0.0.0:7109".into());
    let path = journal_path();
    let config = config_from_env();
    let fsync_every = fsync_from_env();
    eprintln!(
        "meridex-engine listening on {bind} journal {} ref {} band {}bps halt {}bps fsync_every {fsync_every}",
        path.display(),
        config.reference_price,
        config.band_bps,
        config.halt_bps
    );
    let handle = match spawn(&bind, &path, config, fsync_every) {
        Ok(h) => h,
        Err(err) => {
            eprintln!("failed to start: {err}");
            return ExitCode::from(1);
        }
    };
    // Hold the server until the process is killed. Each command already flushes
    // the journal; SIGTERM ends the process without draining stdin (Docker
    // closes stdin, which must not be treated as a shutdown signal).
    std::thread::park();
    drop(handle);
    ExitCode::SUCCESS
}

fn cmd_replay() -> ExitCode {
    let path = journal_path();
    match journal::replay(&path) {
        Ok((engine, heal)) => {
            if heal.is_some() {
                eprintln!("warning: journal tail had an input without output; hash is post-apply");
            }
            println!("{}", engine.state_hash());
            if engine.is_crossed() {
                eprintln!("book is crossed");
                return ExitCode::from(1);
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("replay failed: {err}");
            ExitCode::from(1)
        }
    }
}

fn cmd_batch() -> ExitCode {
    let path = journal_path();
    let config = config_from_env();
    let fsync_every = fsync_from_env();
    let mut service = match Service::open(&path, config, fsync_every) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("open failed: {err}");
            return ExitCode::from(1);
        }
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(err) => {
                eprintln!("stdin: {err}");
                return ExitCode::from(1);
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let cmd: Command = match serde_json::from_str(&line) {
            Ok(c) => c,
            Err(err) => {
                eprintln!("bad command: {err}");
                return ExitCode::from(1);
            }
        };
        let result = match service.command(cmd) {
            Ok(r) => r,
            Err(err) => {
                eprintln!("command failed: {err}");
                return ExitCode::from(1);
            }
        };
        let out = serde_json::json!({
            "seq": result.seq,
            "events": result.events,
            "state_hash": result.state_hash,
        });
        if writeln!(stdout, "{out}").is_err() {
            return ExitCode::from(1);
        }
    }
    if service.sync().is_err() {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
