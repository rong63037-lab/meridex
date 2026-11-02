//! Tiny single-threaded HTTP/1.1 server. One command is applied at a time,
//! which matches the engine's deterministic total order.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::{json, Value};

use crate::engine::EngineConfig;
use crate::exchange::Exchange;
use crate::types::{Command, SYMBOL};

pub struct ServerHandle {
    pub addr: SocketAddr,
    shutdown: Sender<()>,
    thread: Option<JoinHandle<()>>,
}

impl ServerHandle {
    pub fn shutdown(mut self) {
        let _ = self.shutdown.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        let _ = self.shutdown.send(());
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

pub fn spawn(
    bind: &str,
    journal_path: &std::path::Path,
    config: EngineConfig,
    fsync_every: u64,
) -> Result<ServerHandle, String> {
    let listener = TcpListener::bind(bind).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let addr = listener.local_addr().map_err(|e| e.to_string())?;
    let mut exchange = Exchange::open(journal_path, config, fsync_every)?;
    eprintln!("meridex-engine books: {}", exchange.symbols().len());
    let (shutdown, rx) = mpsc::channel();
    let thread = thread::spawn(move || {
        if let Err(err) = serve_loop(listener, &mut exchange, rx) {
            eprintln!("meridex-engine: server stopped: {err}");
        }
        let _ = exchange.sync();
    });
    Ok(ServerHandle {
        addr,
        shutdown,
        thread: Some(thread),
    })
}

fn serve_loop(
    listener: TcpListener,
    exchange: &mut Exchange,
    shutdown: Receiver<()>,
) -> std::io::Result<()> {
    loop {
        if shutdown.try_recv().is_ok() {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = handle_conn(stream, exchange);
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(2));
            }
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

fn handle_conn(mut stream: TcpStream, exchange: &mut Exchange) {
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(300)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
    loop {
        let req = match read_request(&mut stream) {
            Ok(Some(req)) => req,
            Ok(None) => break,
            Err(_) => break,
        };
        let (status, body) = route(exchange, &req);
        if write_json(&mut stream, status, &body).is_err() {
            break;
        }
    }
}

struct Request {
    method: String,
    path: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<Request>> {
    let mut buf = Vec::with_capacity(1024);
    let mut tmp = [0u8; 8192];
    let header_end = loop {
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > 64 * 1024 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "headers too large",
            ));
        }
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            if buf.is_empty() {
                return Ok(None);
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "truncated headers",
            ));
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let header_text = std::str::from_utf8(&buf[..header_end]).map_err(|_| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "headers are not utf-8")
    })?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().unwrap_or("");
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let mut content_length = 0usize;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                content_length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    if content_length > 8 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "body too large",
        ));
    }
    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut tmp)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "truncated body",
            ));
        }
        body.extend_from_slice(&tmp[..n]);
    }
    body.truncate(content_length);
    Ok(Some(Request { method, path, body }))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4)
}

fn write_json(stream: &mut TcpStream, status: u16, body: &Value) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(body).unwrap();
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n",
        bytes.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(&bytes)?;
    stream.flush()?;
    Ok(())
}

fn query_param(raw_path: &str, key: &str) -> Option<String> {
    let query = raw_path.split_once('?')?.1;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return Some(percent_decode(v));
        }
    }
    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&input[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn health_body(exchange: &Exchange, symbol: &str) -> Result<Value, String> {
    let book = exchange.book(symbol)?;
    Ok(json!({
        "ok": true,
        "symbol": book.symbol,
        "reference_price": book.reference_price,
        "band_bps": book.band_bps,
        "halt_bps": book.halt_bps,
        "band_low": book.band_low,
        "band_high": book.band_high,
        "halt_low": book.halt_low,
        "halt_high": book.halt_high,
        "halted": book.halted,
        "state_hash": book.state_hash,
        "command_seq": book.command_seq,
        "trade_count": book.trade_count,
        "last_trade_price": book.last_trade_price,
        "qty_unit": book.qty_unit,
        "price_unit": book.price_unit,
        "open_orders": exchange.open_orders(symbol)?,
        "bids": book.bids,
        "asks": book.asks,
    }))
}

fn route(exchange: &mut Exchange, req: &Request) -> (u16, Value) {
    let path = req.path.split('?').next().unwrap_or("/");
    let symbol = query_param(&req.path, "symbol").unwrap_or_else(|| SYMBOL.to_string());
    match (req.method.as_str(), path) {
        ("GET", "/health") | ("GET", "/state") => match health_body(exchange, SYMBOL) {
            Ok(body) => (200, body),
            Err(err) => (500, json!({"error": err})),
        },
        ("GET", "/book") => match exchange.book(SYMBOL) {
            Ok(book) => (200, serde_json::to_value(book).unwrap()),
            Err(err) => (500, json!({"error": err})),
        },
        ("POST", "/command") => match serde_json::from_slice::<Command>(&req.body) {
            Ok(cmd) => match exchange.command(SYMBOL, cmd) {
                Ok(result) => (
                    200,
                    json!({
                        "seq": result.seq,
                        "events": result.events,
                        "state_hash": result.state_hash,
                    }),
                ),
                Err(err) => (400, json!({"error": err})),
            },
            Err(err) => (400, json!({"error": format!("bad command: {err}")})),
        },
        ("POST", "/replay-verify") => match exchange.verify(SYMBOL) {
            Ok(hash) => (200, json!({"ok": true, "state_hash": hash})),
            Err(err) => (500, json!({"ok": false, "error": err})),
        },
        ("GET", "/books") => {
            let mut rows = Vec::new();
            for sym in exchange.symbols() {
                match exchange.book(sym) {
                    Ok(book) => rows.push(json!({
                        "symbol": book.symbol,
                        "state_hash": book.state_hash,
                        "reference_price": book.reference_price,
                        "last_trade_price": book.last_trade_price,
                        "halted": book.halted,
                        "trade_count": book.trade_count,
                        "band_low": book.band_low,
                        "band_high": book.band_high,
                        "command_seq": book.command_seq,
                    })),
                    Err(err) => return (500, json!({"error": err})),
                }
            }
            (200, json!({ "books": rows }))
        }
        ("GET", "/books/view") => match exchange.book(&symbol) {
            Ok(book) => (200, serde_json::to_value(book).unwrap()),
            Err(err) => (404, json!({"error": err})),
        },
        ("GET", "/books/health") => match health_body(exchange, &symbol) {
            Ok(body) => (200, body),
            Err(err) => (404, json!({"error": err})),
        },
        ("POST", "/books/command") => {
            let parsed: Value = match serde_json::from_slice(&req.body) {
                Ok(v) => v,
                Err(err) => return (400, json!({"error": format!("bad command: {err}")})),
            };
            let sym = parsed.get("symbol").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let cmd = match parsed.get("command") {
                Some(c) => match serde_json::from_value::<Command>(c.clone()) {
                    Ok(cmd) => cmd,
                    Err(err) => return (400, json!({"error": format!("bad command: {err}")})),
                },
                None => return (400, json!({"error": "bad command: missing command"})),
            };
            match exchange.command(&sym, cmd) {
                Ok(result) => (
                    200,
                    json!({
                        "seq": result.seq,
                        "events": result.events,
                        "state_hash": result.state_hash,
                    }),
                ),
                Err(err) => (400, json!({"error": err})),
            }
        }
        ("POST", "/books/replay") => match exchange.verify_all() {
            Ok(rows) => (
                200,
                json!({
                    "ok": true,
                    "books": rows.into_iter().map(|(symbol, state_hash)| json!({ "symbol": symbol, "state_hash": state_hash })).collect::<Vec<_>>(),
                }),
            ),
            Err(err) => (500, json!({"ok": false, "error": err})),
        },
        ("GET", "/books/order") => {
            let id = query_param(&req.path, "id").unwrap_or_default();
            match exchange.order_view(&symbol, &id) {
                Ok(Some(view)) => (200, serde_json::to_value(view).unwrap()),
                Ok(None) => (
                    200,
                    json!({"order_id": id, "found": false, "resting": false, "events": []}),
                ),
                Err(err) => (404, json!({"error": err})),
            }
        }
        ("GET", path) if path.starts_with("/order/") => {
            let id = &path["/order/".len()..];
            match exchange.order_view(SYMBOL, id) {
                Ok(Some(view)) => (200, serde_json::to_value(view).unwrap()),
                Ok(None) => (
                    200,
                    json!({"order_id": id, "found": false, "resting": false, "events": []}),
                ),
                Err(err) => (500, json!({"error": err})),
            }
        }
        _ => (404, json!({"error": "not_found"})),
    }
}

pub fn fsync_from_env() -> u64 {
    std::env::var("ENGINE_FSYNC_EVERY")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(1)
}

pub fn config_from_env() -> EngineConfig {
    EngineConfig {
        reference_price: std::env::var("ENGINE_REF_PRICE")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(13_000),
        band_bps: std::env::var("ENGINE_BAND_BPS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(500),
        halt_bps: std::env::var("ENGINE_HALT_BPS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(200),
    }
}

