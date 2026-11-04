//! The tokens one turn of the session's agent spent, read from `_meta.quota.token_count` of `claude-agent-acp`'s prompt
//! response: input, output, cache read and cache write tokens of the main agent loop. Subagents work in contexts of
//! their own; their tokens (the `model_usage` rows beside it) are left out.

use agent_client_protocol::schema::v1::Meta;
use serde_json::Value;

/// Tokens the turn whose prompt response carried `meta` spent; 0 when the response reports none.
pub fn turn_tokens(meta: Option<&Meta>) -> u64 {
    meta.and_then(|meta| meta.get("quota"))
        .and_then(|quota| quota.get("token_count"))
        .and_then(|count| count.get("totalTokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(value: Value) -> Meta {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn counts_the_main_agent_only() {
        let meta = meta(json!({ "quota": {
            "token_count": { "totalTokens": 100 },
            "model_usage": [{ "model": "opus", "token_count": { "totalTokens": 120 } }, { "model": "haiku", "token_count": { "totalTokens": 30 } }],
        }}));
        assert_eq!(turn_tokens(Some(&meta)), 100);
    }

    #[test]
    fn counts_nothing_without_a_quota() {
        assert_eq!(turn_tokens(None), 0);
        assert_eq!(turn_tokens(Some(&meta(json!({ "other": 1 })))), 0);
    }
}
