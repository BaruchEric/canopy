//! JSON-RPC lines (`src/core/codexrpc.ts`), the pure half only: one line
//! read as a message, and a byte stream cut into lines. `canopy mcp` reads
//! its requests through these. The client that drives `codex app-server`
//! over a child's stdio waits on the runs port.

use serde_json::Value;

/// `RpcMessage`: what one line holds. An id is a number or a string, kept
/// as the JSON it was.
#[derive(Debug, Clone, PartialEq)]
pub enum RpcMessage {
    Response {
        id: Value,
        result: Value,
    },
    Error {
        id: Value,
        code: f64,
        message: String,
        data: Option<Value>,
    },
    /// `params` is None when the line had none (`undefined`).
    Request {
        id: Value,
        method: String,
        params: Option<Value>,
    },
    Notification {
        method: String,
        params: Option<Value>,
    },
}

fn is_id(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Number(_) | Value::String(_)))
}

/// `parseMessage()`: one line as a message, or None for anything that is
/// not one: blank lines, log chatter, JSON that is not a JSON-RPC object.
/// A `jsonrpc` field is allowed and ignored.
pub fn parse_message(line: &str) -> Option<RpcMessage> {
    let text = crate::pathx::js_trim(line);
    if !text.starts_with('{') {
        return None;
    }
    let o: Value = serde_json::from_str(text).ok()?;
    let o = o.as_object()?;
    let id = o.get("id");
    if let Some(method) = o.get("method").and_then(Value::as_str) {
        let params = o.get("params").cloned();
        return Some(if is_id(id) {
            RpcMessage::Request {
                id: id.cloned().unwrap_or(Value::Null),
                method: method.into(),
                params,
            }
        } else {
            RpcMessage::Notification {
                method: method.into(),
                params,
            }
        });
    }
    if !is_id(id) {
        return None;
    }
    let id = id.cloned().unwrap_or(Value::Null);
    if let Some(e) = o.get("error").and_then(Value::as_object) {
        return Some(RpcMessage::Error {
            id,
            code: e.get("code").and_then(Value::as_f64).unwrap_or(0.0),
            message: e
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .into(),
            data: e.get("data").cloned(),
        });
    }
    o.get("result").map(|r| RpcMessage::Response {
        id,
        result: r.clone(),
    })
}

/// `LineSplitter`: cuts a byte stream into lines. A chunk may end mid-line
/// or mid-character: the bytes wait until their line ends. A line is read
/// as UTF-8 with a bad sequence replaced, as `TextDecoder` reads it.
#[derive(Debug, Default)]
pub struct LineSplitter {
    buf: Vec<u8>,
}

impl LineSplitter {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let mut text = String::from_utf8_lossy(&line[..nl]).into_owned();
            if text.ends_with('\r') {
                text.pop();
            }
            out.push(text);
        }
        out
    }

    /// What is left once the stream has ended: a last line with no newline.
    pub fn flush(&mut self) -> Vec<String> {
        let rest = String::from_utf8_lossy(&std::mem::take(&mut self.buf)).into_owned();
        if crate::pathx::js_trim(&rest).is_empty() {
            vec![]
        } else {
            vec![rest]
        }
    }
}

/// codexrpc.test.ts's cases for the line framing and the classifier; its
/// client's cases wait with the client.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_line_split_across_chunks_comes_out_whole_once() {
        let mut s = LineSplitter::default();
        assert!(s.push(br#"{"id":1,"res"#).is_empty());
        assert_eq!(
            s.push(b"ult\":{}}\n{\"method\":\"a\"}\n{\"meth"),
            [r#"{"id":1,"result":{}}"#, r#"{"method":"a"}"#]
        );
        assert_eq!(s.push(b"od\":\"b\"}\r\n"), [r#"{"method":"b"}"#]);
        assert!(s.flush().is_empty());
    }

    #[test]
    fn a_character_split_across_byte_chunks_survives_and_a_last_line_without_a_newline_is_kept() {
        let mut s = LineSplitter::default();
        let bytes = "{\"t\":\"\u{e9}\"}\n{\"t\":\"z\"}".as_bytes();
        // inside the two bytes of é
        let cut = bytes.iter().position(|b| *b == 0xc3).unwrap() + 1;
        assert!(s.push(&bytes[..cut]).is_empty());
        assert_eq!(s.push(&bytes[cut..]), ["{\"t\":\"\u{e9}\"}"]);
        assert_eq!(s.flush(), [r#"{"t":"z"}"#]);
    }

    #[test]
    fn requests_notifications_results_and_errors_with_or_without_jsonrpc() {
        assert_eq!(
            parse_message(r#"{"id":0,"method":"item/tool/requestUserInput","params":{"a":1}}"#),
            Some(RpcMessage::Request {
                id: json!(0),
                method: "item/tool/requestUserInput".into(),
                params: Some(json!({"a": 1}))
            })
        );
        assert_eq!(
            parse_message(r#"{"method":"turn/started","params":{},"emittedAtMs":5}"#),
            Some(RpcMessage::Notification {
                method: "turn/started".into(),
                params: Some(json!({}))
            })
        );
        assert_eq!(
            parse_message(r#"{"jsonrpc":"2.0","id":3,"result":null}"#),
            Some(RpcMessage::Response {
                id: json!(3),
                result: Value::Null
            })
        );
        assert_eq!(
            parse_message(r#"{"id":"x","error":{"code":-32600,"message":"bad","data":{"k":1}}}"#),
            Some(RpcMessage::Error {
                id: json!("x"),
                code: -32600.0,
                message: "bad".into(),
                data: Some(json!({"k": 1}))
            })
        );
        // a request with no params reads as undefined, an id of 0 is an id
        assert_eq!(
            parse_message(r#"  {"jsonrpc":"2.0","id":1,"method":"ping"}"#),
            Some(RpcMessage::Request {
                id: json!(1),
                method: "ping".into(),
                params: None
            })
        );
    }

    #[test]
    fn anything_else_is_not_a_message() {
        for line in [
            "",
            "WARNING: failed to clean up",
            "[1,2]",
            r#"{"id":1}"#,
            r#"{"result":1}"#,
            "{broken",
            r#"{"id":true,"result":1}"#,
        ] {
            assert_eq!(parse_message(line), None, "{line}");
        }
    }
}
