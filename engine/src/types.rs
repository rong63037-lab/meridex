//! Shared types for the XAU/USD sandbox matching engine.
//!
//! Units (settlement-grade, no floating point):
//! - Quantity is integer milligrams of fine gold (`mg`). 1 gram = 1_000 mg.
//! - Price is integer USD cents per gram (`usd_cents_per_gram`). Tick = 1 cent.
//! - Cash is integer micro-USD (`uusd`). 1 USD = 1_000_000 µUSD.
//! - Notional: `uusd = qty_mg * price_cents_per_gram * 10`.
//!
//! Troy-ounce display is a presentation concern only and never enters matching
//! or settlement. 1 troy oz ≈ 31.1034768 g.

use serde::{Deserialize, Serialize};

pub const SYMBOL: &str = "XAU/USD";
pub const QTY_UNIT: &str = "mg";
pub const PRICE_UNIT: &str = "usd_cents_per_gram";
pub const CASH_UNIT: &str = "uusd";

/// Hard caps stay inside the JSON safe-integer range (2^53) for the gateway.
pub const MAX_QTY_MG: u64 = 1_000_000_000_000;
pub const MAX_PRICE_CENTS: u64 = 100_000_000_000;

pub fn notional_uusd(qty_mg: u64, price_cents_per_gram: u64) -> u128 {
    qty_mg as u128 * price_cents_per_gram as u128 * 10
}

pub fn band_edge(reference: u64, bps: u64, upper: bool) -> u64 {
    let bps = bps as u128;
    let reference = reference as u128;
    let num = if upper { 10_000 + bps } else { 10_000 - bps };
    (reference * num / 10_000) as u64
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Self {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderType {
    Limit,
    Market,
    Ioc,
    Fok,
    PostOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RejectReason {
    MarketHalted,
    InvalidQty,
    InvalidPrice,
    InvalidOrder,
    PriceBand,
    PostOnly,
    FokUnfillable,
    SelfTrade,
    NotFound,
    NotOwner,
    DuplicateOrder,
    StaleReference,
    CircuitBreaker,
    AlreadyHalted,
    NotHalted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CancelReason {
    User,
    Ioc,
    MarketRemainder,
    SelfTrade,
    CircuitBreaker,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Command {
    NewOrder {
        order_id: String,
        user_id: u64,
        side: Side,
        order_type: OrderType,
        #[serde(default)]
        price: Option<u64>,
        qty: u64,
        #[serde(default)]
        protection_price: Option<u64>,
        #[serde(default)]
        expected_ref: Option<u64>,
    },
    Cancel {
        order_id: String,
        user_id: u64,
    },
    SetReference {
        price: u64,
    },
    Halt,
    Resume,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Rejected {
        order_id: String,
        reason: RejectReason,
    },
    CommandRejected {
        reason: RejectReason,
    },
    Accepted {
        order_id: String,
        user_id: u64,
        side: Side,
        order_type: OrderType,
        price: Option<u64>,
        qty: u64,
        leaves: u64,
    },
    Trade {
        trade_id: u64,
        price: u64,
        qty: u64,
        taker_order_id: String,
        maker_order_id: String,
        taker_user_id: u64,
        maker_user_id: u64,
        taker_side: Side,
        buyer_user_id: u64,
        seller_user_id: u64,
        buyer_order_id: String,
        seller_order_id: String,
    },
    Resting {
        order_id: String,
        price: u64,
        leaves: u64,
    },
    Canceled {
        order_id: String,
        leaves: u64,
        filled: u64,
        reason: CancelReason,
    },
    Halted {
        reason: String,
    },
    Resumed,
    ReferenceSet {
        price: u64,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct LevelView {
    pub price: u64,
    pub qty: u64,
    pub orders: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct BookView {
    pub symbol: String,
    pub reference_price: u64,
    pub band_bps: u64,
    pub halt_bps: u64,
    pub band_low: u64,
    pub band_high: u64,
    pub halt_low: u64,
    pub halt_high: u64,
    pub halted: bool,
    pub state_hash: String,
    pub command_seq: u64,
    pub trade_count: u64,
    pub last_trade_price: Option<u64>,
    pub last_trade_qty: Option<u64>,
    pub bids: Vec<LevelView>,
    pub asks: Vec<LevelView>,
    pub qty_unit: &'static str,
    pub price_unit: &'static str,
}

pub fn valid_order_id(id: &str) -> bool {
    let n = id.len();
    (1..=64).contains(&n)
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':' | b'.'))
}
