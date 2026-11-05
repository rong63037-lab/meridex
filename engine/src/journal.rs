//! Append-only command journal. Replay rebuilds engine state from inputs and
//! checks that every recorded output still matches.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::engine::{ApplyResult, Engine, EngineConfig};
use crate::types::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JournalRecord {
    Header {
        v: u32,
        symbol: String,
        reference_price: u64,
        band_bps: u64,
        halt_bps: u64,
        qty_unit: String,
        price_unit: String,
        cash_unit: String,
        notional: String,
    },
    Input {
        v: u32,
        seq: u64,
        cmd: Command,
    },
    Output {
        v: u32,
        seq: u64,
        events: Vec<Event>,
        state_hash: String,
    },
}

pub struct Journal {
    file: File,
    pub path: std::path::PathBuf,
    fsync_every: u64,
    pending: u64,
}

impl Journal {
    pub fn create(path: &Path, config: &EngineConfig, symbol: &str, fsync_every: u64) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .read(true)
            .open(path)?;
        let header = JournalRecord::Header {
            v: 1,
            symbol: symbol.into(),
            reference_price: config.reference_price,
            band_bps: config.band_bps,
            halt_bps: config.halt_bps,
            qty_unit: QTY_UNIT.into(),
            price_unit: PRICE_UNIT.into(),
            cash_unit: CASH_UNIT.into(),
            notional: "qty_mg * price_cents_per_gram * 10".into(),
        };
        writeln!(file, "{}", serde_json::to_string(&header).unwrap())?;
        file.sync_all()?;
        Ok(Self {
            file,
            path: path.to_path_buf(),
            fsync_every: fsync_every.max(1),
            pending: 0,
        })
    }

    pub fn append(path: &Path, fsync_every: u64) -> std::io::Result<Self> {
        let file = OpenOptions::new().append(true).read(true).open(path)?;
        Ok(Self {
            file,
            path: path.to_path_buf(),
            fsync_every: fsync_every.max(1),
            pending: 0,
        })
    }

    pub fn write_pair(&mut self, result: &ApplyResult, cmd: &Command) -> std::io::Result<()> {
        let input = JournalRecord::Input {
            v: 1,
            seq: result.seq,
            cmd: cmd.clone(),
        };
        let output = JournalRecord::Output {
            v: 1,
            seq: result.seq,
            events: result.events.clone(),
            state_hash: result.state_hash.clone(),
        };
        writeln!(self.file, "{}", serde_json::to_string(&input).unwrap())?;
        writeln!(self.file, "{}", serde_json::to_string(&output).unwrap())?;
        self.file.flush()?;
        self.pending += 1;
        if self.pending >= self.fsync_every {
            self.file.sync_all()?;
            self.pending = 0;
        }
        Ok(())
    }

    pub fn sync(&mut self) -> std::io::Result<()> {
        self.file.flush()?;
        self.file.sync_all()?;
        self.pending = 0;
        Ok(())
    }
}

pub fn read_records(path: &Path) -> Result<Vec<JournalRecord>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let mut records = Vec::new();
    let mut lines = reader.lines().peekable();
    while let Some(line) = lines.next() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<JournalRecord>(&line) {
            Ok(rec) => records.push(rec),
            Err(err) => {
                if lines.peek().is_none() {
                    eprintln!("meridex-engine: dropping truncated tail line: {err}");
                    break;
                }
                return Err(format!("corrupt journal: {err}"));
            }
        }
    }
    Ok(records)
}

pub fn header_config(records: &[JournalRecord]) -> Result<(EngineConfig, String), String> {
    match records.first() {
        Some(JournalRecord::Header {
            reference_price,
            band_bps,
            halt_bps,
            symbol,
            ..
        }) => {
            if symbol.is_empty() || symbol.len() > 32 {
                return Err(format!("unexpected symbol {symbol}"));
            }
            Ok((
                EngineConfig {
                    reference_price: *reference_price,
                    band_bps: *band_bps,
                    halt_bps: *halt_bps,
                },
                symbol.clone(),
            ))
        }
        _ => Err("journal missing header".into()),
    }
}

/// Replay inputs. When an output record is present, it must match exactly.
/// A trailing input without an output (crash window) is applied and returned
/// so the caller can append the healed output.
pub fn replay(path: &Path) -> Result<(Engine, Option<(Command, ApplyResult)>), String> {
    let records = read_records(path)?;
    let (config, symbol) = header_config(&records)?;
    let mut engine = Engine::new(config)?;
    engine.set_symbol(symbol);
    let mut pending_heal: Option<(Command, ApplyResult)> = None;
    let mut i = 1;
    while i < records.len() {
        let JournalRecord::Input { seq, cmd, .. } = &records[i] else {
            return Err(format!("expected input at record {i}"));
        };
        let result = engine.apply(cmd.clone());
        if result.seq != *seq {
            return Err(format!(
                "seq mismatch at record {i}: engine {} journal {seq}",
                result.seq
            ));
        }
        if i + 1 < records.len() {
            match &records[i + 1] {
                JournalRecord::Output {
                    seq: out_seq,
                    events,
                    state_hash,
                    ..
                } => {
                    if out_seq != seq {
                        return Err(format!("output seq mismatch at {i}"));
                    }
                    if events != &result.events || state_hash != &result.state_hash {
                        return Err(format!(
                            "replay diverged at seq {seq}: journal hash {state_hash} engine {}",
                            result.state_hash
                        ));
                    }
                    pending_heal = None;
                    i += 2;
                }
                _ => return Err(format!("expected output after input seq {seq}")),
            }
        } else {
            pending_heal = Some((cmd.clone(), result));
            i += 1;
        }
    }
    Ok((engine, pending_heal))
}

