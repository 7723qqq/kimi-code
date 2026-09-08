//! High-concurrency network benchmarks and stress tests for the native HTTP/WS server.
//!
//! Measures:
//! 1. Concurrent REST request throughput (1000 requests across concurrent tasks)
//! 2. High-fanout WebSocket event broadcasting across multiple concurrent connections
//!
//! Run with:
//!   cargo test --test server_concurrency_bench -- --nocapture

use std::sync::Arc;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use kimi_agent::events::EngineEvent;
use kimi_agent::server::HttpServer;
use kimi_agent::server::hub::EventHub;
use kimi_agent::session::sqlite_store::SqliteSessionStore;
use serde_json::Value;

#[tokio::test]
async fn bench_concurrent_rest_throughput() {
    let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
    let hub = Arc::new(EventHub::new());
    let server = HttpServer::with_hub(store, hub);

    let handle = kimi_agent::server::http::serve("127.0.0.1:0", Arc::new(server))
        .await
        .expect("server must bind to ephemeral port");
    let addr = handle.local_addr;
    let base_url = format!("http://{addr}");

    let concurrency = 20;
    let requests_per_task = 50;
    let total_requests = concurrency * requests_per_task;

    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(concurrency)
        .build()
        .unwrap();

    let start = Instant::now();
    let mut tasks = Vec::with_capacity(concurrency);

    for task_idx in 0..concurrency {
        let client = client.clone();
        let base_url = base_url.clone();
        tasks.push(tokio::spawn(async move {
            let mut ok_count = 0;
            for i in 0..requests_per_task {
                let url = if i % 2 == 0 {
                    format!("{base_url}/api/v1/health")
                } else {
                    format!("{base_url}/api/v1/meta")
                };
                let res = client.get(&url).send().await;
                if let Ok(resp) = res
                    && resp.status() == 200
                {
                    ok_count += 1;
                }
            }
            (task_idx, ok_count)
        }));
    }

    let mut total_ok = 0;
    for t in tasks {
        let (_, ok) = t.await.unwrap();
        total_ok += ok;
    }

    let duration = start.elapsed();
    let rps = (total_requests as f64) / duration.as_secs_f64();
    let avg_latency_ms = duration.as_secs_f64() * 1000.0 / (total_requests as f64);

    println!(
        "\n--- Concurrent REST Throughput Benchmark ---\n\
         Total requests:    {}\n\
         Concurrency:       {}\n\
         Successful:        {} (100%)\n\
         Elapsed:           {:?}\n\
         Throughput:        {:.1} req/sec\n\
         Avg Latency:       {:.3} ms/req\n\
         --------------------------------------------",
        total_requests, concurrency, total_ok, duration, rps, avg_latency_ms
    );

    assert_eq!(total_ok, total_requests);
    handle.shutdown();
}

#[tokio::test]
async fn bench_concurrent_websocket_fanout_stress() {
    let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
    let hub = Arc::new(EventHub::new());
    let server = HttpServer::with_hub(store.clone(), hub.clone());

    let handle = kimi_agent::server::http::serve("127.0.0.1:0", Arc::new(server))
        .await
        .expect("server must bind to ephemeral port");
    let addr = handle.local_addr;

    let client_count = 10;
    let events_to_broadcast = 100;
    let session_id = "sess-bench-fanout";
    store
        .create_session(session_id, Some("Bench Session"))
        .unwrap();

    // Establish N concurrent WebSocket connections
    let mut streams = Vec::with_capacity(client_count);
    for _ in 0..client_count {
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let handshake = concat!(
            "GET /api/v1/ws HTTP/1.1\r\n",
            "Host: 127.0.0.1\r\n",
            "Upgrade: websocket\r\n",
            "Connection: Upgrade\r\n",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
            "Sec-WebSocket-Version: 13\r\n",
            "\r\n"
        );
        stream.write_all(handshake.as_bytes()).await.unwrap();

        // Read handshake response
        let mut handshake_bytes = Vec::new();
        while !handshake_bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0u8; 1];
            if stream.read(&mut byte).await.unwrap() == 0 {
                break;
            }
            handshake_bytes.push(byte[0]);
        }

        // Read server_hello frame
        read_ws_text(&mut stream).await;

        // Send client_hello subscribing to target session
        let payload = format!(
            "{{\"type\":\"client_hello\",\"id\":\"c-sub\",\"payload\":{{\"subscriptions\":[\"{session_id}\"]}}}}"
        );
        let frame = make_masked_text_frame(payload.as_bytes());
        stream.write_all(&frame).await.unwrap();

        // Read ack frame
        let ack_text = read_ws_text(&mut stream).await;
        let ack: Value = serde_json::from_str(&ack_text).unwrap();
        assert_eq!(ack["type"], "ack");
        assert_eq!(ack["code"], 0);

        streams.push(stream);
    }

    // Wait until all connections attach to the hub
    for _ in 0..100 {
        if hub.subscriber_count() == client_count {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(hub.subscriber_count(), client_count);

    // Spawn N reader tasks
    let mut reader_handles = Vec::with_capacity(client_count);
    for (idx, mut stream) in streams.into_iter().enumerate() {
        reader_handles.push(tokio::spawn(async move {
            let mut received_seqs = Vec::with_capacity(events_to_broadcast);
            for _ in 0..events_to_broadcast {
                let text = read_ws_text(&mut stream).await;
                let frame: Value = serde_json::from_str(&text).unwrap();
                if let Some(seq) = frame["seq"].as_u64() {
                    received_seqs.push(seq);
                }
            }
            (idx, received_seqs)
        }));
    }

    // Measure broadcast fan-out latency
    let start = Instant::now();
    let bus = hub.bus_for(session_id);
    for step in 1..=events_to_broadcast {
        bus.publish(&EngineEvent::AssistantDelta {
            agent_id: "main".into(),
            turn_id: 1,
            delta: format!("token_{step} "),
        });
    }

    // Await all readers
    for h in reader_handles {
        let (idx, seqs) = h.await.unwrap();
        assert_eq!(
            seqs.len(),
            events_to_broadcast,
            "client {idx} missed events"
        );
        for (expected_idx, &seq) in seqs.iter().enumerate() {
            assert_eq!(
                seq,
                (expected_idx as u64) + 1,
                "client {idx} saw out-of-order sequence"
            );
        }
    }

    let duration = start.elapsed();
    let total_delivered = client_count * events_to_broadcast;
    let fanout_rate = (total_delivered as f64) / duration.as_secs_f64();

    println!(
        "\n--- WebSocket Fan-out Concurrency Benchmark ---\n\
         Clients:           {}\n\
         Events Published:  {}\n\
         Total Delivered:   {} (100%)\n\
         Broadcast Elapsed: {:?}\n\
         Delivery Rate:     {:.1} deliveries/sec\n\
         -----------------------------------------------",
        client_count, events_to_broadcast, total_delivered, duration, fanout_rate
    );

    handle.shutdown();
}

async fn read_ws_text(client: &mut TcpStream) -> String {
    let mut head = [0u8; 2];
    client.read_exact(&mut head).await.unwrap();
    assert_eq!(head[0], 0x81, "expected text frame");
    assert_eq!(head[1] & 0x80, 0, "server frames must not be masked");
    let len = match head[1] & 0x7F {
        126 => {
            let mut wide = [0u8; 2];
            client.read_exact(&mut wide).await.unwrap();
            u16::from_be_bytes(wide) as usize
        }
        short => short as usize,
    };
    let mut payload = vec![0u8; len];
    client.read_exact(&mut payload).await.unwrap();
    String::from_utf8(payload).unwrap()
}

fn make_masked_text_frame(payload: &[u8]) -> Vec<u8> {
    let payload_len = payload.len();
    let mut frame = Vec::new();
    frame.push(0x81);
    if payload_len < 126 {
        frame.push(0x80 | (payload_len as u8));
    } else {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(payload_len as u16).to_be_bytes());
    }

    let mask_key = [0x12, 0x34, 0x56, 0x78];
    frame.extend_from_slice(&mask_key);

    let mut masked_payload = Vec::with_capacity(payload_len);
    for (i, &b) in payload.iter().enumerate() {
        masked_payload.push(b ^ mask_key[i % 4]);
    }
    frame.extend_from_slice(&masked_payload);
    frame
}
