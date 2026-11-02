//! Behavioural tests for the XAU/USD book: priority, order types, STP,
//! price band, circuit breaker, and deterministic journal replay.

use std::time::Instant;

use meridex_engine::http_server::spawn;
use meridex_engine::journal;
use meridex_engine::service::Service;
use meridex_engine::types::*;
use meridex_engine::{Command, Engine, EngineConfig, Event, OrderType, RejectReason, Side};

fn engine() -> Engine {
    Engine::new(EngineConfig::default()).unwrap()
}

fn limit(id: &str, user: u64, side: Side, price: u64, qty: u64) -> Command {
    Command::NewOrder {
        order_id: id.into(),
        user_id: user,
        side,
        order_type: OrderType::Limit,
        price: Some(price),
        qty,
        protection_price: None,
        expected_ref: None,
    }
}

fn typed(
    id: &str,
    user: u64,
    side: Side,
    order_type: OrderType,
    price: Option<u64>,
    qty: u64,
) -> Command {
    Command::NewOrder {
        order_id: id.into(),
        user_id: user,
        side,
        order_type,
        price,
        qty,
        protection_price: None,
        expected_ref: None,
    }
}

fn rejected(events: &[Event]) -> Option<RejectReason> {
    events.iter().find_map(|e| match e {
        Event::Rejected { reason, .. } => Some(*reason),
        _ => None,
    })
}

fn trade_qty(events: &[Event]) -> u64 {
    events.iter().fold(0, |acc, e| match e {
        Event::Trade { qty, .. } => acc + qty,
        _ => acc,
    })
}

#[test]
fn notional_is_micro_usd_from_milligrams_and_cents() {
    // 1.000 g at $130.00/g = $130 = 130_000_000 µUSD.
    assert_eq!(notional_uusd(1_000, 13_000), 130_000_000);
    // 1 mg at $0.01/g = $0.00001 = 10 µUSD.
    assert_eq!(notional_uusd(1, 1), 10);
    assert_eq!(band_edge(13_000, 500, true), 13_650);
    assert_eq!(band_edge(13_000, 500, false), 12_350);
    assert_eq!(band_edge(13_000, 200, true), 13_260);
    assert_eq!(band_edge(13_000, 200, false), 12_740);
}

#[test]
fn price_time_priority_partial_fill_and_rest() {
    let mut eng = engine();
    eng.apply(limit("a1", 1, Side::Sell, 13_000, 2_000));
    eng.apply(limit("a2", 2, Side::Sell, 13_000, 2_000));
    eng.apply(limit("a3", 3, Side::Sell, 13_010, 5_000));
    let res = eng.apply(limit("b1", 4, Side::Buy, 13_010, 3_000));
    assert_eq!(trade_qty(&res.events), 3_000);
    match &res.events[1] {
        Event::Trade {
            maker_order_id,
            price,
            qty,
            buyer_user_id,
            seller_user_id,
            ..
        } => {
            assert_eq!(maker_order_id, "a1");
            assert_eq!(*price, 13_000);
            assert_eq!(*qty, 2_000);
            assert_eq!(*buyer_user_id, 4);
            assert_eq!(*seller_user_id, 1);
        }
        other => panic!("expected trade, got {other:?}"),
    }
    match &res.events[2] {
        Event::Trade {
            maker_order_id,
            qty,
            price,
            ..
        } => {
            assert_eq!(maker_order_id, "a2");
            assert_eq!(*qty, 1_000);
            assert_eq!(*price, 13_000);
        }
        other => panic!("expected second trade, got {other:?}"),
    }
    assert!(res
        .events
        .iter()
        .all(|e| !matches!(e, Event::Resting { .. })));
    assert_eq!(eng.resting_leaves("a2"), Some(1_000));
    assert_eq!(eng.resting_leaves("a3"), Some(5_000));
    assert!(!eng.is_crossed());
    let book = eng.book_view();
    assert_eq!(book.asks[0].price, 13_000);
    assert_eq!(book.asks[0].qty, 1_000);
    assert_eq!(book.asks[1].price, 13_010);
}

#[test]
fn self_trade_is_rejected_and_does_not_print() {
    let mut eng = engine();
    eng.apply(limit("bid", 7, Side::Buy, 13_000, 1_000));
    let res = eng.apply(limit("ask", 7, Side::Sell, 13_000, 1_000));
    assert_eq!(rejected(&res.events), Some(RejectReason::SelfTrade));
    assert_eq!(trade_qty(&res.events), 0);
    assert_eq!(eng.resting_leaves("bid"), Some(1_000));
    assert_eq!(eng.trade_count(), 0);
    assert!(!eng.is_crossed());
}

#[test]
fn self_trade_after_other_liquidity_cancels_remainder() {
    let mut eng = engine();
    eng.apply(limit("other", 2, Side::Sell, 13_000, 400));
    eng.apply(limit("mine", 7, Side::Sell, 13_000, 1_000));
    let res = eng.apply(limit("buy", 7, Side::Buy, 13_000, 1_000));
    assert_eq!(trade_qty(&res.events), 400);
    assert!(res.events.iter().any(|e| matches!(
        e,
        Event::Canceled {
            reason: CancelReason::SelfTrade,
            leaves: 600,
            ..
        }
    )));
    assert_eq!(eng.resting_leaves("mine"), Some(1_000));
    assert!(!eng.is_crossed());
}

#[test]
fn out_of_band_orders_rejected() {
    let mut eng = engine();
    let hi = eng.apply(limit("hi", 1, Side::Sell, 13_651, 100));
    let lo = eng.apply(limit("lo", 1, Side::Buy, 12_349, 100));
    assert_eq!(rejected(&hi.events), Some(RejectReason::PriceBand));
    assert_eq!(rejected(&lo.events), Some(RejectReason::PriceBand));
    let edge = eng.apply(limit("edge", 1, Side::Buy, 13_650, 100));
    assert!(rejected(&edge.events).is_none());
    assert_eq!(eng.resting_leaves("edge"), Some(100));
}

#[test]
fn circuit_breaker_halts_and_blocks_new_orders_until_resume() {
    let mut eng = engine();
    // Inside the 5% band, outside the 2% halt band.
    eng.apply(limit("ask", 1, Side::Sell, 13_300, 1_000));
    let res = eng.apply(limit("buy", 2, Side::Buy, 13_300, 1_000));
    assert_eq!(trade_qty(&res.events), 0);
    assert!(res.events.iter().any(|e| matches!(
        e,
        Event::Halted { reason } if reason == "circuit_breaker"
    )));
    assert_eq!(rejected(&res.events), Some(RejectReason::CircuitBreaker));
    assert!(eng.halted());
    let blocked = eng.apply(limit("later", 3, Side::Buy, 13_000, 100));
    assert_eq!(rejected(&blocked.events), Some(RejectReason::MarketHalted));
    // Cancel still works so a resting order can be pulled during a halt.
    let cancel = eng.apply(Command::Cancel {
        order_id: "ask".into(),
        user_id: 1,
    });
    assert!(matches!(
        &cancel.events[0],
        Event::Canceled {
            reason: CancelReason::User,
            ..
        }
    ));
    eng.apply(Command::Resume);
    assert!(!eng.halted());
    let ok = eng.apply(limit("after", 3, Side::Buy, 13_000, 100));
    assert!(rejected(&ok.events).is_none());
}

#[test]
fn order_types_ioc_fok_post_only_market() {
    let mut eng = engine();
    eng.apply(limit("ask", 1, Side::Sell, 13_000, 1_000));

    let ioc = eng.apply(typed("ioc", 2, Side::Buy, OrderType::Ioc, Some(13_000), 2_500));
    assert_eq!(trade_qty(&ioc.events), 1_000);
    assert!(ioc.events.iter().any(|e| matches!(
        e,
        Event::Canceled {
            reason: CancelReason::Ioc,
            leaves: 1_500,
            ..
        }
    )));
    assert!(eng.resting_leaves("ioc").is_none());

    let fok_fail = eng.apply(typed("fok-no", 2, Side::Buy, OrderType::Fok, Some(13_000), 100));
    assert_eq!(rejected(&fok_fail.events), Some(RejectReason::FokUnfillable));

    eng.apply(limit("ask2", 1, Side::Sell, 13_020, 500));
    let fok = eng.apply(typed("fok", 3, Side::Buy, OrderType::Fok, Some(13_020), 500));
    assert_eq!(trade_qty(&fok.events), 500);
    assert!(rejected(&fok.events).is_none());
    assert!(eng.resting_leaves("ask2").is_none());

    let post = eng.apply(typed(
        "post",
        4,
        Side::Buy,
        OrderType::PostOnly,
        Some(13_000),
        100,
    ));
    // No ask remains at or below 13000, so this rests.
    assert!(post.events.iter().any(|e| matches!(e, Event::Resting { .. })));

    eng.apply(limit("ask3", 1, Side::Sell, 13_050, 50));
    let post_take = eng.apply(typed(
        "post-take",
        5,
        Side::Buy,
        OrderType::PostOnly,
        Some(13_050),
        10,
    ));
    assert_eq!(rejected(&post_take.events), Some(RejectReason::PostOnly));
    assert_eq!(trade_qty(&post_take.events), 0);

    let mkt = eng.apply(typed("mkt", 6, Side::Buy, OrderType::Market, None, 40));
    assert_eq!(trade_qty(&mkt.events), 40);
    let mkt_rest = eng.apply(typed("mkt2", 6, Side::Buy, OrderType::Market, None, 100));
    assert!(mkt_rest.events.iter().any(|e| matches!(
        e,
        Event::Canceled {
            reason: CancelReason::MarketRemainder,
            ..
        }
    )));
    assert!(eng.resting_leaves("mkt2").is_none());
    assert!(!eng.is_crossed());
}

#[test]
fn cancel_not_owner_and_duplicate() {
    let mut eng = engine();
    eng.apply(limit("o", 1, Side::Buy, 12_900, 100));
    let foreign = eng.apply(Command::Cancel {
        order_id: "o".into(),
        user_id: 2,
    });
    assert_eq!(rejected(&foreign.events), Some(RejectReason::NotOwner));
    assert_eq!(eng.resting_leaves("o"), Some(100));
    let again = eng.apply(limit("o", 1, Side::Buy, 12_900, 100));
    assert_eq!(rejected(&again.events), Some(RejectReason::DuplicateOrder));
    eng.apply(Command::Cancel {
        order_id: "o".into(),
        user_id: 1,
    });
    assert!(eng.resting_leaves("o").is_none());
}

#[test]
fn replay_from_journal_matches_hash() {
    let dir = std::env::temp_dir().join(format!("meridex-replay-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("journal.jsonl");
    let mut svc = Service::open(&path, EngineConfig::default(), 1).unwrap();
    let commands = vec![
        limit("s1", 1, Side::Sell, 13_010, 5_000),
        limit("b1", 2, Side::Buy, 13_000, 2_000),
        limit("b2", 2, Side::Buy, 13_010, 1_000),
        limit("self", 1, Side::Buy, 13_010, 100),
        limit("band", 3, Side::Sell, 20_000, 100),
        Command::Cancel {
            order_id: "s1".into(),
            user_id: 1,
        },
    ];
    let mut last = String::new();
    for cmd in commands {
        last = svc.command(cmd).unwrap().state_hash;
    }
    svc.sync().unwrap();
    let verified = svc.verify_replay().unwrap();
    assert_eq!(verified, last);
    drop(svc);
    let (eng, heal) = journal::replay(&path).unwrap();
    assert!(heal.is_none());
    assert_eq!(eng.state_hash(), last);
    assert!(!eng.is_crossed());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn one_hundred_thousand_orders_replay_identical_and_book_uncrossed() {
    const N: u64 = 100_000;
    let mut eng = engine();
    let mut mirror_cmds: Vec<Command> = Vec::with_capacity(N as usize);
    let mut rng = 0xA0E0_1234_5678_9ABCu64;
    let mut next = || {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        rng
    };
    let lo = band_edge(13_000, 200, false);
    let hi = band_edge(13_000, 200, true);
    let mut stp = 0u64;
    let mut band = 0u64;
    let mut trades = 0u64;
    let started = Instant::now();
    for i in 0..N {
        let roll = next() % 100;
        let user = (next() % 25) + 1;
        let side = if next() % 2 == 0 { Side::Buy } else { Side::Sell };
        let qty = 100 + (next() % 5_000);
        let cmd = if roll < 8 {
            let px = if next() % 2 == 0 { 20_000 } else { 1_000 };
            typed(&format!("o{i}"), user, side, OrderType::Limit, Some(px), qty)
        } else {
            let span = (hi - lo) as u128;
            let px = lo + ((next() as u128) % (span + 1)) as u64;
            let kind_roll = next() % 100;
            let kind = if kind_roll < 70 {
                OrderType::Limit
            } else if kind_roll < 82 {
                OrderType::Ioc
            } else if kind_roll < 90 {
                OrderType::Fok
            } else if kind_roll < 96 {
                OrderType::PostOnly
            } else {
                OrderType::Market
            };
            let price = if kind == OrderType::Market {
                None
            } else {
                Some(px)
            };
            typed(&format!("o{i}"), user, side, kind, price, qty)
        };
        mirror_cmds.push(cmd.clone());
        let res = eng.apply(cmd);
        match rejected(&res.events) {
            Some(RejectReason::SelfTrade) => stp += 1,
            Some(RejectReason::PriceBand) => band += 1,
            _ => {}
        }
        trades += res.events.iter().filter(|e| matches!(e, Event::Trade { .. })).count() as u64;
        assert!(!eng.is_crossed(), "book crossed at order {i}");
    }
    let elapsed = started.elapsed();
    let hash = eng.state_hash();
    let replay_started = Instant::now();
    let mut replayed = engine();
    for cmd in &mirror_cmds {
        replayed.apply(cmd.clone());
    }
    let replay_elapsed = replay_started.elapsed();
    assert_eq!(replayed.state_hash(), hash);
    assert_eq!(replayed.trade_count(), eng.trade_count());
    assert!(!replayed.is_crossed());
    assert!(eng.fingerprint_consistent());
    assert!(replayed.fingerprint_consistent());
    assert!(stp > 0, "expected some self-trade rejects, got 0");
    assert!(band > 0, "expected some band rejects, got 0");
    assert!(eng.trade_count() > 0, "expected trades");
    println!(
        "STRESS orders={N} trades={} trade_events={trades} stp_rejects={stp} band_rejects={band} open={} elapsed_ms={} replay_ms={} hash={hash}",
        eng.trade_count(),
        eng.open_order_count(),
        elapsed.as_millis(),
        replay_elapsed.as_millis(),
    );
}

#[test]
fn journal_file_replay_of_many_commands() {
    let dir = std::env::temp_dir().join(format!("meridex-journal-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("journal.jsonl");
    let mut svc = Service::open(&path, EngineConfig::default(), 10_000).unwrap();
    let mut rng = 99u64;
    let mut next = || {
        rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
        rng
    };
    let lo = band_edge(13_000, 200, false);
    let hi = band_edge(13_000, 200, true);
    for i in 0..2_000 {
        let user = (next() % 10) + 1;
        let side = if next() % 2 == 0 { Side::Buy } else { Side::Sell };
        let px = lo + (next() % (hi - lo + 1));
        let qty = 50 + (next() % 500);
        let _ = svc.command(limit(&format!("j{i}"), user, side, px, qty));
    }
    let hash = svc.sync().map(|_| svc.state_hash()).unwrap();
    let verified = svc.verify_replay().unwrap();
    assert_eq!(verified, hash);
    drop(svc);
    let (eng, _) = journal::replay(&path).unwrap();
    assert_eq!(eng.state_hash(), hash);
    assert!(!eng.is_crossed());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn two_books_replay_independently_and_xau_hash_ignores_symbol() {
    let dir = std::env::temp_dir().join(format!("meridex-books-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut xau = Service::open(&dir.join("xau.jsonl"), EngineConfig::default(), 1).unwrap();
    let mut btc = Service::open_named(
        &dir.join("btc.jsonl"),
        EngineConfig { reference_price: 6_500_000, band_bps: 800, halt_bps: 400 },
        "BTC/USD",
        1,
    )
    .unwrap();
    let xau_before = xau.state_hash();
    btc.command(limit("b1", 1, Side::Sell, 6_500_000, 10_000)).unwrap();
    btc.command(limit("b2", 2, Side::Buy, 6_500_000, 10_000)).unwrap();
    assert_eq!(xau.state_hash(), xau_before, "another book must not move the XAU hash");
    assert_eq!(btc.book().symbol, "BTC/USD");
    assert_eq!(btc.book().trade_count, 1);
    let hash = btc.verify_replay().unwrap();
    assert_eq!(hash, btc.state_hash());
    drop(btc);
    let (replayed, _) = journal::replay(&dir.join("btc.jsonl")).unwrap();
    assert_eq!(replayed.state_hash(), hash);
    assert_eq!(replayed.symbol(), "BTC/USD");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn http_roundtrip_and_replay_endpoint() {
    let dir = std::env::temp_dir().join(format!("meridex-http-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("journal.jsonl");
    let server = spawn("127.0.0.1:0", &path, EngineConfig::default(), 1).unwrap();
    let addr = server.addr;
    let client = std::net::TcpStream::connect(addr).unwrap();
    client.set_nodelay(true).unwrap();
    let mut client = client;
    let body = serde_json::to_vec(&limit("h1", 1, Side::Buy, 12_900, 250)).unwrap();
    write_http(&mut client, "POST", "/command", &body);
    let (status, payload) = read_http(&mut client);
    assert_eq!(status, 200, "{payload}");
    assert!(payload.contains("resting") || payload.contains("Resting") || payload.contains("\"type\":\"resting\""));
    write_http(&mut client, "GET", "/book", b"");
    let (status, book) = read_http(&mut client);
    assert_eq!(status, 200);
    assert!(book.contains("XAU/USD"));
    write_http(&mut client, "POST", "/replay-verify", b"{}");
    let (status, verify) = read_http(&mut client);
    assert_eq!(status, 200, "{verify}");
    assert!(verify.contains("\"ok\":true"));
    drop(client);
    server.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}

fn write_http(stream: &mut std::net::TcpStream, method: &str, path: &str, body: &[u8]) {
    use std::io::Write;
    let req = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        body.len()
    );
    stream.write_all(req.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
    stream.flush().unwrap();
}

fn read_http(stream: &mut std::net::TcpStream) -> (u16, String) {
    use std::io::Read;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        let n = stream.read(&mut tmp).unwrap();
        assert!(n > 0);
        buf.extend_from_slice(&tmp[..n]);
        if let Some(header_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            let header = std::str::from_utf8(&buf[..header_end]).unwrap();
            let status: u16 = header
                .split_whitespace()
                .nth(1)
                .unwrap()
                .parse()
                .unwrap();
            let mut len = 0usize;
            for line in header.split("\r\n") {
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let body_start = header_end + 4;
            while buf.len() < body_start + len {
                let n = stream.read(&mut tmp).unwrap();
                buf.extend_from_slice(&tmp[..n]);
            }
            let body = String::from_utf8(buf[body_start..body_start + len].to_vec()).unwrap();
            return (status, body);
        }
    }
}
