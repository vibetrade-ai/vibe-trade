/**
 * Centralised backend URL resolution.
 *
 * - Dev / hosted mode: NEXT_PUBLIC_* env vars are set at build time → used directly.
 * - CLI / standalone mode: env vars are absent → derive from window.location (same origin).
 * - SSG build phase (no window): fall back to localhost:3001 (never actually used at runtime).
 */

export function getBackendHttpUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_URL;
  }
  if (process.env.NEXT_PUBLIC_BACKEND_HTTP_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_HTTP_URL;
  }
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return "http://localhost:3001";
}

export function getBackendWsUrl(): string {
  if (process.env.NEXT_PUBLIC_BACKEND_WS_URL) {
    return process.env.NEXT_PUBLIC_BACKEND_WS_URL;
  }
  if (typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}`;
  }
  return "ws://localhost:3001";
}
