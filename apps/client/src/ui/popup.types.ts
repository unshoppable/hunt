/** A window's bounds in logical screen px. */
export type ScreenRect = { x: number; y: number; width: number; height: number };

/**
 * A host window's request to the popup window of `kind` (see ui/detached-popup.hook.ts): show `content` for the popup
 * `token` of `hostLabel`. A hidden window opens at `placement`; a shown one stays where it is and takes the focus
 * only with `focus`. `content` is the plain data ui/popup-protocol.utils.ts types per kind.
 */
export type PopupShowRequest = { kind: string; hostLabel: string; token: string; content: unknown; placement: ScreenRect; focus: boolean };
