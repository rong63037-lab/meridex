//! Journal-backed engine service used by the HTTP server and the batch CLI.

use std::path::Path;

use serde::Serialize;

use crate::engine::{ApplyResult, Engine, EngineConfig};
use crate::journal::{self, Journal};
use crate::types::{BookView, Command, Event, SYMBOL};

#[derive(Serialize)]
pub struct OrderHttpView {
    pub order_id: String,
    pub found: bool,
    pub resting: bool,
    pub leaves: u64,
    pub events: Vec<Event>,
}

pub struct Service {
    engine: Engine,
    journal: Journal,
}

impl Service {
    pub fn open(path: &Path, config: EngineConfig, fsync_every: u64) -> Result<Self, String> {
        if path.exists() {
            let (engine, heal) = journal::replay(path)?;
            if engine.config_reference != config.reference_price
                || engine.band_bps != config.band_bps
                || engine.halt_bps != config.halt_bps
            {
                return Err(format!(
                    "journal config ref {} band {} halt {} does not match process config ref {} band {} halt {}",
                    engine.config_reference,
                    engine.band_bps,
                    engine.halt_bps,
                    config.reference_price,
                    config.band_bps,
                    config.halt_bps
                ));
            }
            let mut journal = Journal::append(path, fsync_every).map_err(|e| e.to_string())?;
            if let Some((cmd, result)) = heal {
                journal
                    .write_pair(&result, &cmd)
                    .map_err(|e| format!("heal write failed: {e}"))?;
                journal.sync().map_err(|e| e.to_string())?;
            }
            Ok(Self { engine, journal })
        } else {
            let engine = Engine::new(config.clone())?;
            let journal = Journal::create(path, &config, SYMBOL, fsync_every).map_err(|e| e.to_string())?;
            Ok(Self { engine, journal })
        }
    }

    /// A non-gold book. The journal header carries the symbol. Hashing stays
    /// the same algorithm; each file is its own partition.
    pub fn open_named(path: &Path, config: EngineConfig, symbol: &str, fsync_every: u64) -> Result<Self, String> {
        if symbol.is_empty() {
            return Err("symbol required".into());
        }
        if path.exists() {
            let (engine, heal) = journal::replay(path)?;
            if engine.symbol() != symbol {
                return Err(format!("journal symbol {} != {symbol}", engine.symbol()));
            }
            if engine.config_reference != config.reference_price
                || engine.band_bps != config.band_bps
                || engine.halt_bps != config.halt_bps
            {
                return Err(format!(
                    "journal config for {symbol} does not match catalog"
                ));
            }
            let mut journal = Journal::append(path, fsync_every).map_err(|e| e.to_string())?;
            if let Some((cmd, result)) = heal {
                journal
                    .write_pair(&result, &cmd)
                    .map_err(|e| format!("heal write failed: {e}"))?;
                journal.sync().map_err(|e| e.to_string())?;
            }
            Ok(Self { engine, journal })
        } else {
            let mut engine = Engine::new(config.clone())?;
            engine.set_symbol(symbol);
            let journal = Journal::create(path, &config, symbol, fsync_every).map_err(|e| e.to_string())?;
            Ok(Self { engine, journal })
        }
    }

    pub fn command(&mut self, cmd: Command) -> Result<ApplyResult, String> {
        let result = self.engine.apply(cmd.clone());
        self.journal
            .write_pair(&result, &cmd)
            .map_err(|e| format!("journal write failed: {e}"))?;
        Ok(result)
    }

    pub fn book(&self) -> BookView {
        self.engine.book_view()
    }

    pub fn book_ref(&self) -> BookView {
        self.engine.book_view()
    }

    pub fn open_orders(&self) -> usize {
        self.engine.open_order_count()
    }

    pub fn order_view(&self, order_id: &str) -> Option<OrderHttpView> {
        let events: Vec<Event> = self.engine.order_result(order_id)?.to_vec();
        if events.is_empty() && self.engine.resting_leaves(order_id).is_none() {
            return None;
        }
        let leaves = self.engine.resting_leaves(order_id).unwrap_or(0);
        Some(OrderHttpView {
            order_id: order_id.to_string(),
            found: true,
            resting: self.engine.resting_leaves(order_id).is_some(),
            leaves,
            events,
        })
    }

    pub fn verify_replay(&mut self) -> Result<String, String> {
        self.journal.sync().map_err(|e| e.to_string())?;
        let (replayed, heal) = journal::replay(&self.journal.path)?;
        if heal.is_some() {
            return Err("journal has an unhealed tail during verify".into());
        }
        let live = self.engine.state_hash();
        let replay_hash = replayed.state_hash();
        if live != replay_hash {
            return Err(format!("live {live} != replay {replay_hash}"));
        }
        if replayed.is_crossed() {
            return Err("replayed book is crossed".into());
        }
        Ok(live)
    }

    pub fn sync(&mut self) -> std::io::Result<()> {
        self.journal.sync()
    }

    pub fn state_hash(&self) -> String {
        self.engine.state_hash()
    }
}

#[derive(Debug, Serialize)]
pub struct BatchLine {
    pub seq: u64,
    pub events: Vec<Event>,
    pub state_hash: String,
}
