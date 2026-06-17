/**
 * Self-contained "share link" encoding.
 *
 * Encodes an entire project — the raw SQL schema text and the serialized
 * diagram layout — into a single URL fragment so a recipient can open the
 * diagram with no files on their machine. Everything lives in the URL hash
 * (`#d=…`), which is never sent to a server, so it bypasses request-size
 * limits and stays out of server logs.
 *
 * Compression uses the browser-native `CompressionStream`/`DecompressionStream`
 * with the `deflate-raw` format. No extra dependency; available in modern
 * Chromium/Safari/Firefox and in Node 22 (our test runtime).
 *
 * @module shareLink
 */

/**
 * Current envelope format version. Bumped if the envelope shape changes so
 * older decoders can reject incompatible blobs instead of silently misreading.
 */
const SHARE_VERSION = 1;

/**
 * URL hash key carrying the share blob (e.g. `#d=<blob>`).
 */
const URL_KEY = 'd';

/**
 * Generated links longer than this (in characters) get a non-blocking warning:
 * the browser handles far more, but some chat apps / link unfurlers truncate.
 */
export const SHARE_SIZE_WARN = 8000;

/**
 * @typedef {Object} ShareEnvelope
 * @property {string} sql - Raw SQL schema text.
 * @property {string} diagram - Serialized `.erd-pets.json` (JSONC) string.
 */

/**
 * Whether share-link encoding/decoding is available in this environment.
 * @returns {boolean}
 */
export function isShareSupported() {
  return (
    typeof CompressionStream !== 'undefined' &&
    typeof DecompressionStream !== 'undefined'
  );
}

/**
 * Compress bytes with raw DEFLATE.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function deflateRaw(bytes) {
  const cs = new CompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decompress raw DEFLATE bytes.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Encode bytes as base64url (no padding). Chunked so large arrays don't blow
 * the argument limit of `String.fromCharCode`.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64Url(bytes) {
  let binary = '';
  const CHUNK = 0x8000; // 32 KB per chunk keeps the spread within argument limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url (no padding) string back into bytes.
 * @param {string} blob
 * @returns {Uint8Array}
 */
function base64UrlToBytes(blob) {
  const base64 = blob.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a project into a share blob (the part after `#d=`). The caller builds
 * the full URL via {@link buildShareUrl}.
 * @param {ShareEnvelope} project
 * @returns {Promise<string>} base64url blob
 * @throws {Error} If share encoding is unsupported.
 */
export async function encodeShareLink({ sql, diagram }) {
  if (!isShareSupported()) {
    throw new Error('Share links are not supported in this browser.');
  }
  const envelope = { v: SHARE_VERSION, sql, diagram };
  const json = JSON.stringify(envelope);
  const bytes = new TextEncoder().encode(json);
  const compressed = await deflateRaw(bytes);
  return bytesToBase64Url(compressed);
}

/**
 * Decode a share blob back into a project.
 * @param {string} blob - base64url blob (the part after `#d=`).
 * @returns {Promise<ShareEnvelope>}
 * @throws {Error} On malformed, corrupt, or unknown-version input.
 */
export async function decodeShareLink(blob) {
  if (!isShareSupported()) {
    throw new Error('Share links are not supported in this browser.');
  }
  if (typeof blob !== 'string' || blob.length === 0) {
    throw new Error('Empty share link.');
  }

  let envelope;
  try {
    const compressed = base64UrlToBytes(blob);
    const bytes = await inflateRaw(compressed);
    const json = new TextDecoder().decode(bytes);
    envelope = JSON.parse(json);
  } catch {
    throw new Error('Share link is corrupted or unreadable.');
  }

  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Share link is corrupted or unreadable.');
  }
  if (envelope.v !== SHARE_VERSION) {
    throw new Error(`Unsupported share link version: ${envelope.v}.`);
  }
  if (typeof envelope.sql !== 'string' || typeof envelope.diagram !== 'string') {
    throw new Error('Share link is missing required data.');
  }

  return { sql: envelope.sql, diagram: envelope.diagram };
}

/**
 * Read the share blob from the current URL hash (e.g. `#d=…`).
 * @returns {string | null}
 */
export function getUrlShareBlob() {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get(URL_KEY);
}

/**
 * Build a full share URL from a blob. Drops any existing hash (a share isn't a
 * local recent, so we deliberately omit `#p=`).
 * @param {string} blob
 * @returns {string}
 */
export function buildShareUrl(blob) {
  return `${window.location.origin}${window.location.pathname}#${URL_KEY}=${blob}`;
}
