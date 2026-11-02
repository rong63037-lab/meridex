//! Meridex matching engine: one XAU/USD book, price-time priority, event sourced.

pub mod engine;
pub mod exchange;
pub mod http_server;
pub mod journal;
pub mod service;
pub mod types;

pub use engine::{ApplyResult, Engine, EngineConfig};
pub use types::*;
