/** Image types the chat shows; any other type, SVG in particular, stays a placeholder text. */
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Longest base64 data of a single image the chat shows (10 MB); a longer one stays a placeholder text. */
export const MAX_IMAGE_DATA_LENGTH = 10 * 1024 * 1024;

/** Standard base64 alphabet with trailing padding; a single character class matches megabytes in linear time. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The fields of an ACP image block. They come from the agent, possibly on a remote VM, so they are checked at runtime. */
export type ImageBlock = { data?: unknown; mimeType?: unknown };

/**
 * The `data:` URL an `<img>` shows `image` from, or null for an image the chat does not show: a type other than PNG,
 * JPEG, GIF and WebP, data that is not padded base64, or more than `MAX_IMAGE_DATA_LENGTH` of it.
 */
export function imageDataUrl({ data, mimeType }: ImageBlock): string | null {
  if (typeof data !== "string" || typeof mimeType !== "string") return null;
  const type = mimeType.toLowerCase();
  if (!IMAGE_MIME_TYPES.has(type) || data.length > MAX_IMAGE_DATA_LENGTH || !isBase64(data)) return null;
  return `data:${type};base64,${data}`;
}

/** The text that stands in for an image `imageDataUrl` does not show. */
export function imagePlaceholder({ data }: ImageBlock): string {
  if (typeof data === "string" && data.length > MAX_IMAGE_DATA_LENGTH) return `[image too large to show: ${formatMegabytes((data.length * 3) / 4)}]`;
  return "[unsupported image]";
}

function isBase64(data: string): boolean {
  return data.length > 0 && data.length % 4 === 0 && BASE64.test(data);
}

/** `7.5 MB` for a number of bytes. */
function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
