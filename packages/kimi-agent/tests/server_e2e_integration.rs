//! End-to-end integration test for the native HTTP + WebSocket server.
//!
//! Exercises real TCP network traffic across the native REST and WebSocket surfaces:
//! 1. Starts `kimi_agent::server::http::serve` on an ephemeral port (127.0.0.1:0)
//! 2. Drives full REST CRUD via real HTTP requests (health, meta, workspaces, sessions, interactions)
//! 3. Establishes a true RFC 6455 WebSocket handshake and exchanges control frames

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use kimi_agent::server::HttpServer;
use kimi_agent::server::hub::EventHub;
use kimi_agent::session::sqlite_store::SqliteSessionStore;
use serde_json::{Value, json};

#[tokio::test]
async fn server_e2e_http_rest_full_roundtrip() {
    let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
    let hub = Arc::new(EventHub::new());
    let server = Arc::new(HttpServer::with_hub(store.clone(), hub));

    let handle = kimi_agent::server::http::serve("127.0.0.1:0", server.clone())
        .await
        .expect("server must bind to ephemeral port");
    let addr = handle.local_addr;
    let base_url = format!("http://{addr}");

    let client = reqwest::Client::new();

    // Every response over the wire carries the kap-server envelope
    // (`{ code, msg, data, request_id }`, see `serve_connection`); sections
    // of this test predate that convention, so all reads go through this
    // unwrap — which also tolerates handlers that reply pre-enveloped.
    fn data(value: &Value) -> &Value {
        value.get("data").unwrap_or(value)
    }

    // 1. Health check
    let res = client
        .get(format!("{base_url}/api/v1/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let health = data(&body);
    assert_eq!(health["status"], "ok");
    assert_eq!(health["version"], "0.1.0");

    // 2. Meta check
    let res = client
        .get(format!("{base_url}/api/v1/meta"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let meta = data(&body);
    assert_eq!(meta["backend"], "rust");
    assert_eq!(meta["server_version"], "0.1.0");

    // 3. Workspace CRUD & Trust
    let res = client
        .post(format!("{base_url}/api/v1/workspaces"))
        .json(&json!({
            "root": "/tmp/test-e2e-ws",
            "name": "E2E Workspace"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    let ws_created: Value = res.json().await.unwrap();
    let ws_id = data(&ws_created)["id"].as_str().unwrap().to_string();

    let res = client
        .get(format!("{base_url}/api/v1/workspaces"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let ws_list: Value = res.json().await.unwrap();
    assert!(
        data(&ws_list)["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|w| w["id"] == ws_id)
    );

    // Workspace trust toggle
    let res = client
        .post(format!("{base_url}/api/v1/workspaces/{ws_id}/trust"))
        .json(&json!({ "trusted": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let trust_val: Value = res.json().await.unwrap();
    assert_eq!(data(&trust_val)["trusted"], true);

    // 4. Session CRUD & Profile
    let res = client
        .post(format!("{base_url}/api/v1/sessions"))
        .json(&json!({
            "title": "E2E Session",
            "workspaceId": ws_id
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    let sess_created: Value = res.json().await.unwrap();
    let session_id = data(&sess_created)["sessionId"]
        .as_str()
        .unwrap()
        .to_string();

    // Session profile update
    let res = client
        .post(format!("{base_url}/api/v1/sessions/{session_id}:profile"))
        .json(&json!({
            "title": "Renamed E2E Session",
            "agent_config": {
                "model": "kimi-latest",
                "thinking": "high"
            }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let prof_updated: Value = res.json().await.unwrap();
    let profile = data(&prof_updated);
    assert_eq!(profile["session"]["title"], "Renamed E2E Session");
    assert!(profile["session"]["metadata"]["cwd"].is_string());
    assert!(profile["session"]["agent_config"]["model"].is_string());
    assert!(profile["session"]["usage"]["context_tokens"].is_number());
    assert_eq!(profile["agent_config"]["thinking"], "high");

    // 5. Interaction Question Flow (Engine registers -> HTTP client lists & resolves)
    let q_req = kimi_agent::rpc::types::AskQuestionRequest {
        question_id: "q_e2e_1".into(),
        turn_id: "turn-e2e".into(),
        tool_call_id: "call_q".into(),
        background: false,
        timeout_ms: None,
        questions: vec![kimi_agent::rpc::types::AskQuestionItem {
            question: "Proceed with deployment?".into(),
            header: None,
            options: vec![
                kimi_agent::rpc::types::AskQuestionOption {
                    label: "Yes".into(),
                    description: None,
                },
                kimi_agent::rpc::types::AskQuestionOption {
                    label: "No".into(),
                    description: None,
                },
            ],
            multi_select: false,
        }],
    };
    let rx_q = server
        .interaction_manager()
        .register_question(&session_id, q_req);

    let res = client
        .get(format!("{base_url}/api/v1/sessions/{session_id}/questions"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let q_list: Value = res.json().await.unwrap();
    assert!(
        data(&q_list)["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|q| q["question_id"] == "q_e2e_1")
    );

    let res = client
        .post(format!(
            "{base_url}/api/v1/sessions/{session_id}/questions/q_e2e_1:reply"
        ))
        .json(&json!({
            "answers": { "Proceed with deployment?": "Yes" }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    let q_resp = rx_q.await.unwrap();
    assert_eq!(
        q_resp.answers.get("Proceed with deployment?").unwrap(),
        "Yes"
    );

    // 6. Interaction Approval Flow (Engine registers -> HTTP client lists & resolves)
    let appr_req = kimi_agent::rpc::types::PermissionCheckRequest {
        tool_name: "Bash".into(),
        tool_call_id: "call_bash_e2e".into(),
        arguments: json!({ "command": "npm test" }),
    };
    let (approval_id, rx_a) =
        server
            .interaction_manager()
            .register_approval(&session_id, appr_req, "Run test command");

    let res = client
        .get(format!("{base_url}/api/v1/sessions/{session_id}/approvals"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let app_list: Value = res.json().await.unwrap();
    assert!(
        data(&app_list)["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|a| a["approval_id"] == approval_id)
    );

    let res = client
        .post(format!(
            "{base_url}/api/v1/sessions/{session_id}/approvals/{approval_id}:resolve"
        ))
        .json(&json!({ "feedback": "Go ahead" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    let a_resp = rx_a.await.unwrap();
    assert!(a_resp.is_allow());

    // 6.5 Global full-text search endpoint
    store
        .save_turn(
            &session_id,
            "turn-search",
            1,
            &[kimi_agent::turn_loop::types::LLMMessage::user(
                "Searching for integration keywords in e2e test.",
            )],
            None,
        )
        .unwrap();

    let res = client
        .post(format!("{base_url}/api/v1/search"))
        .json(&json!({ "query": "integration" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let search_val: Value = res.json().await.unwrap();
    let search_items = if let Some(data) = search_val.get("data") {
        data["items"].as_array().unwrap()
    } else {
        search_val["items"].as_array().unwrap()
    };
    assert!(!search_items.is_empty());
    assert_eq!(search_items[0]["session_id"], session_id);
    assert!(
        search_items[0]["snippet"]
            .as_str()
            .unwrap()
            .contains("integration")
    );

    // 6.6 Snapshot, Transcript and Connections
    let res = client
        .get(format!("{base_url}/api/v1/sessions/{session_id}/snapshot"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let snap_val: Value = res.json().await.unwrap();
    let snap_data = snap_val.get("data").unwrap_or(&snap_val);
    assert_eq!(snap_data["session"]["id"], session_id);
    assert!(
        !snap_data["messages"]["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let res = client
        .get(format!(
            "{base_url}/api/v1/sessions/{session_id}/transcript"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let trans_val: Value = res.json().await.unwrap();
    let trans_data = trans_val.get("data").unwrap_or(&trans_val);
    assert_eq!(trans_data["agent_id"], "main");
    assert!(trans_data["items"].is_array());
    assert!(trans_data["has_more"].is_boolean());

    let res = client
        .get(format!("{base_url}/api/v1/connections"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let conn_val: Value = res.json().await.unwrap();
    let conn_data = conn_val.get("data").unwrap_or(&conn_val);
    assert!(conn_data.get("connections").is_some());

    // 6.7 Global Tools and File History Roundtrip
    let res = client
        .get(format!("{base_url}/api/v1/tools"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let tools_val: Value = res.json().await.unwrap();
    let tools_data = tools_val.get("data").unwrap_or(&tools_val);
    let tools_list = tools_data["tools"].as_array().unwrap();
    assert!(tools_list.len() >= 8);
    assert!(tools_list.iter().any(|t| t["name"] == "Read"));
    assert!(tools_list.iter().any(|t| t["name"] == "Write"));

    // Record file history change and query via HTTP
    store
        .record_file_change(
            &session_id,
            1,
            "src/e2e.rs",
            None,
            Some("fn e2e() -> bool { true }\n"),
        )
        .unwrap();

    let res = client
        .get(format!(
            "{base_url}/api/v1/sessions/{session_id}/file-history/changes?turn_id=1"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let fh_changes: Value = res.json().await.unwrap();
    let fh_data = fh_changes.get("data").unwrap_or(&fh_changes);
    assert_eq!(fh_data["recorded"], true);
    assert_eq!(fh_data["changes"][0]["path"], "src/e2e.rs");
    assert_eq!(fh_data["changes"][0]["status"], "added");

    let res = client
        .get(format!(
            "{base_url}/api/v1/sessions/{session_id}/file-history/content?turn_id=1&path=src/e2e.rs"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let fh_content: Value = res.json().await.unwrap();
    let fh_cdata = fh_content.get("data").unwrap_or(&fh_content);
    assert!(fh_cdata["content"].as_str().unwrap().contains("fn e2e()"));

    // 6.8 Filesystem and Git Action Endpoints
    // 6.8.1 mkdir
    let res = client
        .post(format!("{base_url}/api/v1/sessions/{session_id}/fs:mkdir"))
        .json(&json!({ "path": "test_folder", "recursive": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);

    // 6.8.2 list
    let res = client
        .post(format!("{base_url}/api/v1/sessions/{session_id}/fs:list"))
        .json(&json!({ "path": "." }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let list_res: Value = res.json().await.unwrap();
    let list_data = data(&list_res);
    assert!(
        list_data
            .get("items")
            .or_else(|| list_data.get("entries"))
            .is_some()
    );

    // 6.8.3 git_status
    let res = client
        .post(format!(
            "{base_url}/api/v1/sessions/{session_id}/fs:git_status"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let gs_res: Value = res.json().await.unwrap();
    assert!(data(&gs_res).get("entries").is_some());

    // 6.9 Native Terminal Lifecycle Endpoints
    let res = client
        .post(format!("{base_url}/api/v1/sessions/{session_id}/terminals"))
        .json(&json!({ "cols": 80, "rows": 24 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201);
    let term_val: Value = res.json().await.unwrap();
    let term_id = data(&term_val)["id"].as_str().unwrap();

    let res = client
        .get(format!("{base_url}/api/v1/sessions/{session_id}/terminals"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let term_list: Value = res.json().await.unwrap();
    assert!(
        data(&term_list)["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["id"] == term_id)
    );

    let res = client
        .post(format!(
            "{base_url}/api/v1/sessions/{session_id}/terminals/{term_id}:close"
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    let term_close: Value = res.json().await.unwrap();
    assert_eq!(data(&term_close)["closed"], true);

    // 7. Delete Session and Workspace
    let res = client
        .delete(format!("{base_url}/api/v1/sessions/{session_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    let res = client
        .delete(format!("{base_url}/api/v1/workspaces/{ws_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);

    // 8. Verify 404 for deleted session
    let res = client
        .get(format!("{base_url}/api/v1/sessions/{session_id}"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);

    handle.shutdown();
}

#[tokio::test]
async fn server_e2e_websocket_full_roundtrip() {
    let store = Arc::new(SqliteSessionStore::in_memory().unwrap());
    let hub = Arc::new(EventHub::new());
    let server = HttpServer::with_hub(store, hub);

    let handle = kimi_agent::server::http::serve("127.0.0.1:0", Arc::new(server))
        .await
        .expect("server must bind to ephemeral port");
    let addr = handle.local_addr;

    // Connect raw TCP socket
    let mut stream = TcpStream::connect(addr).await.unwrap();

    // 1. Send RFC 6455 handshake
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

    // 2. Read handshake response byte-by-byte until \r\n\r\n to avoid over-reading
    let mut handshake_bytes = Vec::new();
    while !handshake_bytes.ends_with(b"\r\n\r\n") {
        let mut byte = [0u8; 1];
        if stream.read(&mut byte).await.unwrap() == 0 {
            break;
        }
        handshake_bytes.push(byte[0]);
    }
    let response = String::from_utf8_lossy(&handshake_bytes);
    assert!(response.starts_with("HTTP/1.1 101 Switching Protocols\r\n"));
    assert!(response.contains("Upgrade: websocket\r\n"));
    assert!(response.contains("Connection: Upgrade\r\n"));

    // Helper to read an unmasked text frame
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

    // 3. Read server_hello frame sent immediately on connect
    let hello_text = read_ws_text(&mut stream).await;
    let hello_json: Value =
        serde_json::from_str(&hello_text).expect("server must reply valid JSON");
    assert_eq!(hello_json["type"], "server_hello");
    assert!(hello_json["payload"]["ws_connection_id"].is_string());

    // 4. Send masked client_hello frame
    // Client text frame with mask: 0x81 (FIN + text)
    // Payload: {"type":"client_hello","id":"c-1","payload":{}}
    let payload = b"{\"type\":\"client_hello\",\"id\":\"c-1\",\"payload\":{}}";
    let payload_len = payload.len();
    let mut frame = Vec::new();
    frame.push(0x81);
    frame.push(0x80 | (payload_len as u8)); // MASK flag set

    let mask_key = [0x12, 0x34, 0x56, 0x78];
    frame.extend_from_slice(&mask_key);

    let mut masked_payload = Vec::with_capacity(payload_len);
    for (i, &b) in payload.iter().enumerate() {
        masked_payload.push(b ^ mask_key[i % 4]);
    }
    frame.extend_from_slice(&masked_payload);

    stream.write_all(&frame).await.unwrap();

    // 5. Read server's unmasked text response (client_hello_ack)
    let ack_text = read_ws_text(&mut stream).await;
    let ack_json: Value = serde_json::from_str(&ack_text).expect("server must reply valid JSON");
    assert_eq!(ack_json["type"], "ack");
    assert_eq!(ack_json["code"], 0);
    assert_eq!(ack_json["id"], "c-1");

    // 6. Send close frame: 0x88, length 0, masked
    let close_frame = [0x88, 0x80, 0x00, 0x00, 0x00, 0x00];
    let _ = stream.write_all(&close_frame).await;

    handle.shutdown();
}
