//! The ID of a Hunt session and the names derived from it.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// What every session VM's name starts with.
const VM_NAME_PREFIX: &str = "vm-hunt-s-";

/// The ID of a Hunt session, a UUID; serialized as its plain string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub Uuid);

impl SessionId {
    /// The first 8 hex digits of the ID, lowercase, which name the session's VM, its preview hosts and the branch a
    /// retrieval falls back to.
    pub fn short(self) -> String {
        self.0.simple().to_string()[..8].to_string()
    }

    /// The name of the session's VM, `vm-hunt-s-<short>`.
    pub fn vm_name(self) -> String {
        format!("{VM_NAME_PREFIX}{}", self.short())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "AB12CD34-0000-4000-8000-000000000001";

    #[test]
    fn short_takes_the_first_eight_hex_digits_in_lowercase() {
        assert_eq!(SessionId(Uuid::parse_str(ID).unwrap()).short(), "ab12cd34");
        assert_eq!(SessionId(Uuid::nil()).short(), "00000000");
    }

    #[test]
    fn vm_name_prefixes_the_short_id() {
        assert_eq!(SessionId(Uuid::parse_str(ID).unwrap()).vm_name(), "vm-hunt-s-ab12cd34");
    }

    #[test]
    fn serializes_as_the_plain_uuid_string() {
        let id = SessionId(Uuid::parse_str(ID).unwrap());
        let serialized = serde_json::to_value(id).unwrap();
        assert_eq!(serialized, serde_json::json!("ab12cd34-0000-4000-8000-000000000001"));
        assert_eq!(serde_json::from_value::<SessionId>(serialized).unwrap(), id);
        assert!(serde_json::from_value::<SessionId>(serde_json::json!("ab12cd34")).is_err());
    }
}
