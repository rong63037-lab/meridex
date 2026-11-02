//! One matching service per instrument. XAU/USD keeps the historical journal
//! path. Every other book is a sibling file under `books/`, with its own
//! replay hash.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::engine::EngineConfig;
use crate::service::Service;
use crate::types::{BookView, Command, SYMBOL};

#[derive(Debug, Deserialize)]
struct CatalogRow {
    symbol: String,
    #[serde(rename = "refPrice")]
    ref_price: u64,
    #[serde(rename = "bandBps")]
    band_bps: u64,
    #[serde(rename = "haltBps")]
    halt_bps: u64,
}

pub struct Exchange {
    order: Vec<String>,
    books: HashMap<String, Service>,
}

impl Exchange {
    pub fn open(xau_journal: &Path, xau_config: EngineConfig, fsync_every: u64) -> Result<Self, String> {
        let xau = Service::open(xau_journal, xau_config, fsync_every)?;
        let mut books = HashMap::new();
        let mut order = vec![SYMBOL.to_string()];
        books.insert(SYMBOL.to_string(), xau);
        let dir = books_dir(xau_journal);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for row in catalog() {
            if row.symbol == SYMBOL {
                continue;
            }
            let path = dir.join(format!("{}.jsonl", row.symbol.replace('/', "_")));
            let config = EngineConfig {
                reference_price: row.ref_price,
                band_bps: row.band_bps,
                halt_bps: row.halt_bps,
            };
            let svc = Service::open_named(&path, config, &row.symbol, fsync_every)?;
            order.push(row.symbol.clone());
            books.insert(row.symbol, svc);
        }
        Ok(Self { order, books })
    }

    pub fn symbols(&self) -> &[String] {
        &self.order
    }

    pub fn book(&self, symbol: &str) -> Result<BookView, String> {
        Ok(self.service(symbol)?.book_ref())
    }

    pub fn command(&mut self, symbol: &str, cmd: Command) -> Result<crate::engine::ApplyResult, String> {
        self.service_mut(symbol)?.command(cmd)
    }

    pub fn order_view(&self, symbol: &str, order_id: &str) -> Result<Option<crate::service::OrderHttpView>, String> {
        Ok(self.service(symbol)?.order_view(order_id))
    }

    pub fn verify(&mut self, symbol: &str) -> Result<String, String> {
        self.service_mut(symbol)?.verify_replay()
    }

    pub fn verify_all(&mut self) -> Result<Vec<(String, String)>, String> {
        let mut out = Vec::new();
        for symbol in self.order.clone() {
            let hash = self.service_mut(&symbol)?.verify_replay()?;
            out.push((symbol, hash));
        }
        Ok(out)
    }

    pub fn open_orders(&self, symbol: &str) -> Result<usize, String> {
        Ok(self.service(symbol)?.open_orders())
    }

    pub fn sync(&mut self) -> std::io::Result<()> {
        for svc in self.books.values_mut() {
            svc.sync()?;
        }
        Ok(())
    }

    fn service(&self, symbol: &str) -> Result<&Service, String> {
        self.books.get(symbol).ok_or_else(|| format!("unknown symbol {symbol}"))
    }

    fn service_mut(&mut self, symbol: &str) -> Result<&mut Service, String> {
        self.books.get_mut(symbol).ok_or_else(|| format!("unknown symbol {symbol}"))
    }
}

fn books_dir(xau_journal: &Path) -> PathBuf {
    xau_journal
        .parent()
        .unwrap_or_else(|| Path::new("data"))
        .join("books")
}

fn catalog() -> Vec<CatalogRow> {
    let raw = include_str!("../instruments.json");
    serde_json::from_str(raw).expect("instruments.json")
}
