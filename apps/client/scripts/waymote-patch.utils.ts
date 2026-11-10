/**
 * The burst of video chunks Waymote's SDK keeps: the gateway encodes a frame only when the desktop changes, with a
 * keyframe every 30 frames, and sends a new client everything since the last keyframe at once, up to 30 chunks.
 */
const BURST_CHUNKS = 64;

/**
 * The places of `@rockorager/waymote`'s `waymote.js` that drop a burst of more than six chunks, keyframe included: the
 * queue that holds chunks while the decoder is configured, and the decoder's own queue. After either, the SDK waits
 * for the next keyframe, which a desktop that stands still never sends, so the canvas stays black.
 */
const REPLACEMENTS: readonly { find: string; replace: string }[] = [
  { find: "pendingDecoderMessages.length >= 6", replace: `pendingDecoderMessages.length >= ${BURST_CHUNKS}` },
  { find: "decoder.decodeQueueSize > 6", replace: `decoder.decodeQueueSize > ${BURST_CHUNKS}` },
];

/** Whether the module `id` is the SDK file `patchWaymoteSdk` changes. */
export function isWaymoteSdk(id: string): boolean {
  return id.split("?")[0].endsWith("/@rockorager/waymote/waymote.js");
}

/**
 * The SDK's source `code` with room for a whole burst in both queues. Throws when a place is missing or ambiguous, so
 * an SDK update that moved it fails the build instead of bringing the black canvas back.
 */
export function patchWaymoteSdk(code: string): string {
  let patched = code;
  for (const { find, replace } of REPLACEMENTS) {
    const parts = patched.split(find);
    if (parts.length !== 2) {
      throw new Error(`failed to patch @rockorager/waymote: expected "${find}" once, found it ${parts.length - 1} times`);
    }
    patched = parts.join(replace);
  }
  return patched;
}
