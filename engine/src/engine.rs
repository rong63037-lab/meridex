//! Single-threaded price-time matching engine.
//!
//! The engine is a pure state machine: `apply` is deterministic. Time priority
//! is the command sequence number, never a wall clock. No floats.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use sha2::{Digest, Sha256};

use crate::types::*;

#[derive(Debug, Clone)]
struct RestingOrder {
    order_id: String,
    user_id: u64,
    side: Side,
    price: u64,
    leaves: u64,
    /// Cumulative fills, including quantity that traded before the order rested.
    cum_filled: u64,
    seq: u64,
}

#[derive(Debug, Default)]
struct Level {
    orders: VecDeque<String>,
    total: u64,
}

#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub reference_price: u64,
    pub band_bps: u64,
    pub halt_bps: u64,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            reference_price: 13_000,
            band_bps: 500,
            halt_bps: 200,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ApplyResult {
    pub seq: u64,
    pub events: Vec<Event>,
    pub state_hash: String,
}

#[derive(Debug)]
pub struct Engine {
    pub config_reference: u64,
    pub band_bps: u64,
    pub halt_bps: u64,
    /// Display identity only. Not part of `state_hash`, so the XAU journal
    /// still replays to the same hash after multi-book support.
    symbol: String,
    reference_price: u64,
    halted: bool,
    command_seq: u64,
    next_trade_id: u64,
    trade_count: u64,
    trade_qty_sum: u128,
    trade_checksum: u64,
    last_trade_price: Option<u64>,
    last_trade_qty: Option<u64>,
    bids: BTreeMap<u64, Level>,
    asks: BTreeMap<u64, Level>,
    orders: HashMap<String, RestingOrder>,
    seen: HashSet<String>,
    /// XOR of per-order fingerprints. Combined with the scalar header this is
    /// the book identity, updated in O(1) on insert, fill, and cancel.
    book_fp: [u8; 32],
    /// Full taker-side event list per order id, rebuilt on replay.
    results: HashMap<String, Vec<Event>>,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Result<Self, String> {
        if config.reference_price == 0 || config.reference_price > MAX_PRICE_CENTS {
            return Err("invalid reference price".into());
        }
        if config.band_bps >= 10_000 || config.halt_bps >= 10_000 {
            return Err("bps must be < 10000".into());
        }
        if config.halt_bps > config.band_bps {
            return Err("halt band must be inside or equal to the price band".into());
        }
        Ok(Self {
            reference_price: config.reference_price,
            config_reference: config.reference_price,
            band_bps: config.band_bps,
            halt_bps: config.halt_bps,
            symbol: SYMBOL.to_string(),
            halted: false,
            command_seq: 0,
            next_trade_id: 1,
            trade_count: 0,
            trade_qty_sum: 0,
            trade_checksum: 0,
            last_trade_price: None,
            last_trade_qty: None,
            bids: BTreeMap::new(),
            asks: BTreeMap::new(),
            orders: HashMap::new(),
            seen: HashSet::new(),
            book_fp: [0u8; 32],
            results: HashMap::new(),
        })
    }

    pub fn reference_price(&self) -> u64 {
        self.reference_price
    }

    pub fn symbol(&self) -> &str {
        &self.symbol
    }

    pub fn set_symbol(&mut self, symbol: impl Into<String>) {
        self.symbol = symbol.into();
    }

    pub fn halted(&self) -> bool {
        self.halted
    }

    pub fn command_seq(&self) -> u64 {
        self.command_seq
    }

    pub fn trade_count(&self) -> u64 {
        self.trade_count
    }

    pub fn apply(&mut self, cmd: Command) -> ApplyResult {
        self.command_seq += 1;
        let seq = self.command_seq;
        let events = self.dispatch(cmd, seq);
        self.record(&events);
        let state_hash = self.state_hash();
        ApplyResult {
            seq,
            events,
            state_hash,
        }
    }

    pub fn order_result(&self, order_id: &str) -> Option<&[Event]> {
        self.results.get(order_id).map(|v| v.as_slice())
    }

    pub fn resting_leaves(&self, order_id: &str) -> Option<u64> {
        self.orders.get(order_id).map(|o| o.leaves)
    }

    pub fn is_crossed(&self) -> bool {
        match (self.best_bid(), self.best_ask()) {
            (Some((b, _)), Some((a, _))) => b >= a,
            _ => false,
        }
    }

    pub fn open_order_count(&self) -> usize {
        self.orders.len()
    }

    pub fn book_view(&self) -> BookView {
        let mut bids = Vec::new();
        for (price, level) in self.bids.iter().rev() {
            bids.push(LevelView {
                price: *price,
                qty: level.total,
                orders: level.orders.len() as u32,
            });
        }
        let mut asks = Vec::new();
        for (price, level) in self.asks.iter() {
            asks.push(LevelView {
                price: *price,
                qty: level.total,
                orders: level.orders.len() as u32,
            });
        }
        BookView {
            symbol: self.symbol.clone(),
            reference_price: self.reference_price,
            band_bps: self.band_bps,
            halt_bps: self.halt_bps,
            band_low: band_edge(self.reference_price, self.band_bps, false),
            band_high: band_edge(self.reference_price, self.band_bps, true),
            halt_low: band_edge(self.reference_price, self.halt_bps, false),
            halt_high: band_edge(self.reference_price, self.halt_bps, true),
            halted: self.halted,
            state_hash: self.state_hash(),
            command_seq: self.command_seq,
            trade_count: self.trade_count,
            last_trade_price: self.last_trade_price,
            last_trade_qty: self.last_trade_qty,
            bids,
            asks,
            qty_unit: QTY_UNIT,
            price_unit: PRICE_UNIT,
        }
    }

    pub fn fingerprint_consistent(&self) -> bool {
        let mut fp = [0u8; 32];
        for order in self.orders.values() {
            xor_fp(&mut fp, &order_fp(order));
        }
        fp == self.book_fp
    }

    pub fn state_hash(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(format!(
            "v2|h={}|r={}|b={}|hb={}|seq={}|tc={}|qs={}|cs={}|lp={}|lq={}|n={}",
            if self.halted { 1 } else { 0 },
            self.reference_price,
            self.band_bps,
            self.halt_bps,
            self.command_seq,
            self.trade_count,
            self.trade_qty_sum,
            self.trade_checksum,
            self.last_trade_price.unwrap_or(0),
            self.last_trade_qty.unwrap_or(0),
            self.orders.len(),
        ));
        hasher.update(self.book_fp);
        hex::encode(hasher.finalize())
    }

    fn dispatch(&mut self, cmd: Command, seq: u64) -> Vec<Event> {
        match cmd {
            Command::NewOrder {
                order_id,
                user_id,
                side,
                order_type,
                price,
                qty,
                protection_price,
                expected_ref,
            } => self.new_order(
                order_id,
                user_id,
                side,
                order_type,
                price,
                qty,
                protection_price,
                expected_ref,
                seq,
            ),
            Command::Cancel { order_id, user_id } => self.cancel(order_id, user_id),
            Command::SetReference { price } => self.set_reference(price),
            Command::Halt => self.admin_halt(),
            Command::Resume => self.admin_resume(),
        }
    }

    fn record(&mut self, events: &[Event]) {
        for event in events {
            match event {
                Event::Rejected { order_id, .. }
                | Event::Accepted { order_id, .. }
                | Event::Resting { order_id, .. }
                | Event::Canceled { order_id, .. } => {
                    self.results
                        .entry(order_id.clone())
                        .or_default()
                        .push(event.clone());
                }
                Event::Trade {
                    taker_order_id,
                    maker_order_id,
                    ..
                } => {
                    self.results
                        .entry(taker_order_id.clone())
                        .or_default()
                        .push(event.clone());
                    self.results
                        .entry(maker_order_id.clone())
                        .or_default()
                        .push(event.clone());
                }
                _ => {}
            }
        }
    }

    fn outside_band(&self, price: u64) -> bool {
        let lo = band_edge(self.reference_price, self.band_bps, false);
        let hi = band_edge(self.reference_price, self.band_bps, true);
        price < lo || price > hi
    }

    fn breaches_halt(&self, price: u64) -> bool {
        let lo = band_edge(self.reference_price, self.halt_bps, false);
        let hi = band_edge(self.reference_price, self.halt_bps, true);
        price < lo || price > hi
    }

    fn new_order(
        &mut self,
        order_id: String,
        user_id: u64,
        side: Side,
        order_type: OrderType,
        price: Option<u64>,
        qty: u64,
        protection_price: Option<u64>,
        expected_ref: Option<u64>,
        seq: u64,
    ) -> Vec<Event> {
        if !valid_order_id(&order_id) {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::InvalidOrder,
            }];
        }
        if self.halted {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::MarketHalted,
            }];
        }
        if !self.seen.insert(order_id.clone()) {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::DuplicateOrder,
            }];
        }
        if qty == 0 || qty > MAX_QTY_MG {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::InvalidQty,
            }];
        }
        if let Some(expected) = expected_ref {
            if expected != self.reference_price {
                return vec![Event::Rejected {
                    order_id,
                    reason: RejectReason::StaleReference,
                }];
            }
        }

        let limit = match self.resolve_limit(order_type, side, price, protection_price) {
            Ok(p) => p,
            Err(reason) => {
                return vec![Event::Rejected { order_id, reason }];
            }
        };

        if order_type == OrderType::PostOnly && self.would_cross(side, limit) {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::PostOnly,
            }];
        }

        if order_type == OrderType::Fok && self.fillable(side, limit, user_id) < qty {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::FokUnfillable,
            }];
        }

        let mut leaves = qty;
        let mut trade_events: Vec<Event> = Vec::new();
        let mut stop_stp = false;
        let mut stop_circuit = false;

        while leaves > 0 {
            let Some((best_price, maker_id)) = self.best_opposite(side) else {
                break;
            };
            if !crosses(side, limit, best_price) {
                break;
            }
            if self.breaches_halt(best_price) {
                stop_circuit = true;
                self.halted = true;
                break;
            }
            let maker_user = self.orders[&maker_id].user_id;
            if maker_user == user_id {
                stop_stp = true;
                break;
            }
            let maker_leaves = self.orders[&maker_id].leaves;
            let trade_qty = leaves.min(maker_leaves);
            let trade_id = self.next_trade_id;
            self.next_trade_id += 1;
            self.apply_fill(&maker_id, best_price, trade_qty);
            leaves -= trade_qty;
            self.note_trade(trade_id, best_price, trade_qty);

            let (buyer_user_id, seller_user_id, buyer_order_id, seller_order_id) = match side {
                Side::Buy => (user_id, maker_user, order_id.clone(), maker_id.clone()),
                Side::Sell => (maker_user, user_id, maker_id.clone(), order_id.clone()),
            };
            trade_events.push(Event::Trade {
                trade_id,
                price: best_price,
                qty: trade_qty,
                taker_order_id: order_id.clone(),
                maker_order_id: maker_id,
                taker_user_id: user_id,
                maker_user_id: maker_user,
                taker_side: side,
                buyer_user_id,
                seller_user_id,
                buyer_order_id,
                seller_order_id,
            });
        }

        if order_type == OrderType::Fok && leaves > 0 {
            panic!("FOK pre-check diverged from execution; engine invariant broken");
        }

        let filled = qty - leaves;
        if trade_events.is_empty() && (stop_stp || stop_circuit) {
            let mut events = Vec::new();
            if stop_circuit {
                events.push(Event::Halted {
                    reason: "circuit_breaker".into(),
                });
                events.push(Event::Rejected {
                    order_id,
                    reason: RejectReason::CircuitBreaker,
                });
            } else {
                events.push(Event::Rejected {
                    order_id,
                    reason: RejectReason::SelfTrade,
                });
            }
            return events;
        }

        let mut events = Vec::new();
        events.push(Event::Accepted {
            order_id: order_id.clone(),
            user_id,
            side,
            order_type,
            price: match order_type {
                OrderType::Market => Some(limit),
                _ => price,
            },
            qty,
            leaves,
        });
        events.extend(trade_events);

        if stop_circuit {
            events.push(Event::Halted {
                reason: "circuit_breaker".into(),
            });
            if leaves > 0 {
                events.push(Event::Canceled {
                    order_id,
                    leaves,
                    filled,
                    reason: CancelReason::CircuitBreaker,
                });
            }
            return events;
        }

        if stop_stp && leaves > 0 {
            events.push(Event::Canceled {
                order_id,
                leaves,
                filled,
                reason: CancelReason::SelfTrade,
            });
            return events;
        }

        match order_type {
            OrderType::Ioc => {
                if leaves > 0 {
                    events.push(Event::Canceled {
                        order_id,
                        leaves,
                        filled,
                        reason: CancelReason::Ioc,
                    });
                }
            }
            OrderType::Market => {
                if leaves > 0 {
                    events.push(Event::Canceled {
                        order_id,
                        leaves,
                        filled,
                        reason: CancelReason::MarketRemainder,
                    });
                }
            }
            OrderType::Fok => {}
            OrderType::Limit | OrderType::PostOnly => {
                if leaves > 0 {
                    self.rest(order_id.clone(), user_id, side, limit, leaves, filled, seq);
                    events.push(Event::Resting {
                        order_id,
                        price: limit,
                        leaves,
                    });
                }
            }
        }
        events
    }

    fn resolve_limit(
        &self,
        order_type: OrderType,
        side: Side,
        price: Option<u64>,
        protection_price: Option<u64>,
    ) -> Result<u64, RejectReason> {
        let limit = match order_type {
            OrderType::Market => {
                if price.is_some() {
                    return Err(RejectReason::InvalidPrice);
                }
                protection_price.unwrap_or_else(|| {
                    band_edge(self.reference_price, self.band_bps, side == Side::Buy)
                })
            }
            OrderType::Limit | OrderType::Ioc | OrderType::Fok | OrderType::PostOnly => {
                let Some(p) = price else {
                    return Err(RejectReason::InvalidPrice);
                };
                if protection_price.is_some() {
                    return Err(RejectReason::InvalidPrice);
                }
                p
            }
        };
        if limit == 0 || limit > MAX_PRICE_CENTS {
            return Err(RejectReason::InvalidPrice);
        }
        if self.outside_band(limit) {
            return Err(RejectReason::PriceBand);
        }
        Ok(limit)
    }

    fn would_cross(&self, side: Side, limit: u64) -> bool {
        match self.best_opposite(side) {
            Some((px, _)) => crosses(side, limit, px),
            None => false,
        }
    }

    fn fillable(&self, side: Side, limit: u64, user_id: u64) -> u64 {
        let mut got = 0u64;
        match side {
            Side::Buy => {
                for (price, level) in &self.asks {
                    if !crosses(side, limit, *price) || self.breaches_halt(*price) {
                        break;
                    }
                    for oid in &level.orders {
                        let maker = &self.orders[oid];
                        if maker.user_id == user_id {
                            return got;
                        }
                        got = got.saturating_add(maker.leaves);
                    }
                }
            }
            Side::Sell => {
                for (price, level) in self.bids.iter().rev() {
                    if !crosses(side, limit, *price) || self.breaches_halt(*price) {
                        break;
                    }
                    for oid in &level.orders {
                        let maker = &self.orders[oid];
                        if maker.user_id == user_id {
                            return got;
                        }
                        got = got.saturating_add(maker.leaves);
                    }
                }
            }
        }
        got
    }

    fn apply_fill(&mut self, maker_id: &str, price: u64, qty: u64) {
        let before = order_fp(self.orders.get(maker_id).expect("maker"));
        xor_fp(&mut self.book_fp, &before);
        let side = self.orders.get(maker_id).expect("maker").side;
        let removed = {
            let Engine {
                orders, bids, asks, ..
            } = self;
            let book = match side {
                Side::Buy => bids,
                Side::Sell => asks,
            };
            let level = book.get_mut(&price).expect("level");
            level.total = level.total.checked_sub(qty).expect("level total");
            let maker = orders.get_mut(maker_id).expect("maker");
            maker.leaves = maker.leaves.checked_sub(qty).expect("maker leaves");
            maker.cum_filled += qty;
            if maker.leaves == 0 {
                let front = level.orders.pop_front().expect("front");
                assert_eq!(&front, maker_id);
                orders.remove(maker_id);
                if level.orders.is_empty() {
                    book.remove(&price);
                }
                true
            } else {
                false
            }
        };
        if !removed {
            let after = order_fp(self.orders.get(maker_id).expect("maker"));
            xor_fp(&mut self.book_fp, &after);
        }
    }

    fn note_trade(&mut self, trade_id: u64, price: u64, qty: u64) {
        self.trade_count += 1;
        self.trade_qty_sum += qty as u128;
        self.trade_checksum ^= trade_id
            .wrapping_mul(0x9E37_79B1_85EB_CA87)
            ^ price
            ^ qty.wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
        self.last_trade_price = Some(price);
        self.last_trade_qty = Some(qty);
    }

    fn rest(
        &mut self,
        order_id: String,
        user_id: u64,
        side: Side,
        price: u64,
        leaves: u64,
        cum_filled: u64,
        seq: u64,
    ) {
        let order = RestingOrder {
            order_id: order_id.clone(),
            user_id,
            side,
            price,
            leaves,
            cum_filled,
            seq,
        };
        let digest = order_fp(&order);
        {
            let book = match side {
                Side::Buy => &mut self.bids,
                Side::Sell => &mut self.asks,
            };
            let level = book.entry(price).or_default();
            level.total += leaves;
            level.orders.push_back(order_id);
        }
        xor_fp(&mut self.book_fp, &digest);
        self.orders.insert(order.order_id.clone(), order);
    }

    fn best_opposite(&self, side: Side) -> Option<(u64, String)> {
        match side {
            Side::Buy => self.best_ask(),
            Side::Sell => self.best_bid(),
        }
    }

    fn best_bid(&self) -> Option<(u64, String)> {
        let (&price, level) = self.bids.iter().next_back()?;
        Some((price, level.orders.front()?.clone()))
    }

    fn best_ask(&self) -> Option<(u64, String)> {
        let (&price, level) = self.asks.iter().next()?;
        Some((price, level.orders.front()?.clone()))
    }

    fn cancel(&mut self, order_id: String, user_id: u64) -> Vec<Event> {
        if !valid_order_id(&order_id) {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::InvalidOrder,
            }];
        }
        let Some(order) = self.orders.get(&order_id) else {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::NotFound,
            }];
        };
        if order.user_id != user_id {
            return vec![Event::Rejected {
                order_id,
                reason: RejectReason::NotOwner,
            }];
        }
        let price = order.price;
        let side = order.side;
        let leaves = order.leaves;
        let filled = order.cum_filled;
        self.remove_resting(&order_id, side, price);
        vec![Event::Canceled {
            order_id,
            leaves,
            filled,
            reason: CancelReason::User,
        }]
    }

    fn remove_resting(&mut self, order_id: &str, side: Side, price: u64) {
        let digest = order_fp(self.orders.get(order_id).expect("order"));
        xor_fp(&mut self.book_fp, &digest);
        let Engine {
            orders, bids, asks, ..
        } = self;
        let book = match side {
            Side::Buy => bids,
            Side::Sell => asks,
        };
        let level = book.get_mut(&price).expect("level");
        let pos = level
            .orders
            .iter()
            .position(|id| id == order_id)
            .expect("order on level");
        level.orders.remove(pos);
        let leaves = orders.remove(order_id).expect("order").leaves;
        level.total = level.total.checked_sub(leaves).expect("level total");
        if level.orders.is_empty() {
            book.remove(&price);
        }
    }

    fn set_reference(&mut self, price: u64) -> Vec<Event> {
        if price == 0 || price > MAX_PRICE_CENTS {
            return vec![Event::CommandRejected {
                reason: RejectReason::InvalidPrice,
            }];
        }
        self.reference_price = price;
        vec![Event::ReferenceSet { price }]
    }

    fn admin_halt(&mut self) -> Vec<Event> {
        if self.halted {
            return vec![Event::CommandRejected {
                reason: RejectReason::AlreadyHalted,
            }];
        }
        self.halted = true;
        vec![Event::Halted {
            reason: "admin".into(),
        }]
    }

    fn admin_resume(&mut self) -> Vec<Event> {
        if !self.halted {
            return vec![Event::CommandRejected {
                reason: RejectReason::NotHalted,
            }];
        }
        self.halted = false;
        vec![Event::Resumed]
    }
}

fn crosses(side: Side, limit: u64, book_price: u64) -> bool {
    match side {
        Side::Buy => limit >= book_price,
        Side::Sell => limit <= book_price,
    }
}

fn order_fp(order: &RestingOrder) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"v2ord|");
    hasher.update(order.order_id.as_bytes());
    hasher.update(order.user_id.to_le_bytes());
    hasher.update(order.price.to_le_bytes());
    hasher.update(order.leaves.to_le_bytes());
    hasher.update(order.seq.to_le_bytes());
    hasher.update([match order.side {
        Side::Buy => 1,
        Side::Sell => 2,
    }]);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn xor_fp(slot: &mut [u8; 32], digest: &[u8; 32]) {
    for (a, b) in slot.iter_mut().zip(digest.iter()) {
        *a ^= *b;
    }
}
