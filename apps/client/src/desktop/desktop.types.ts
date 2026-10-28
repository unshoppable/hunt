/**
 * Where the remote desktop of a session answers on this Mac (mirror of `DesktopEndpoint` in
 * src-tauri/src/remote/desktop.rs): `url` is the Waymote gateway's base URL `http://127.0.0.1:<port>`, a forward of the
 * shared SSH connection to the VM's desktop proxy; the SDK connects its WebSockets to `ws://` URLs of its paths.
 */
export type DesktopEndpoint = { url: string };
