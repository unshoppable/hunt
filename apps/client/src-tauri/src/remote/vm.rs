//! The names of session VMs: the gateway creates one VM per session, named after the session's ID, starts it when the
//! session needs it and deletes it with the session; the VM shuts itself down when idle.

use uuid::Uuid;

use super::VmRef;

/// What every session VM's name starts with.
const SESSION_VM_PREFIX: &str = "vm-hunt-s-";

/// The first 8 hex digits of session `id`, which name its VM and its preview hosts.
pub fn short_id(id: Uuid) -> String {
    id.simple().to_string()[..8].to_string()
}

/// The name of the VM of session `id`.
pub fn session_vm_name(id: Uuid) -> String {
    format!("{SESSION_VM_PREFIX}{}", short_id(id))
}

/// Whether `vm` is the VM of session `id`, which deleting the session may delete.
pub fn is_session_vm(vm: &VmRef, id: Uuid) -> bool {
    vm.instance == session_vm_name(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_vm_name_takes_the_first_eight_hex_digits() {
        let id = Uuid::parse_str("AB12CD34-0000-4000-8000-000000000001").unwrap();
        assert_eq!(session_vm_name(id), "vm-hunt-s-ab12cd34");
        assert!(is_session_vm(&VmRef { project: "p".into(), zone: "z".into(), instance: "vm-hunt-s-ab12cd34".into() }, id));
        assert!(!is_session_vm(&VmRef { project: "p".into(), zone: "z".into(), instance: "vm-hunt-medc".into() }, id));
    }
}
