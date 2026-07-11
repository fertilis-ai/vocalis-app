import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { isDesktop } from "@/lib/storage";

// API adapters talk to cloud providers through this indirection. On desktop we
// use the Tauri HTTP plugin's fetch, which routes the request through Rust
// (reqwest) — WKWebView would otherwise block these cross-origin calls on CORS,
// since none of the providers send browser CORS headers. In a plain browser or
// under vitest we fall back to the global fetch (which tests replace).

export type FetchImpl = typeof fetch;

/** The platform fetch: Tauri HTTP on desktop, global fetch elsewhere. */
export function platformFetch(): FetchImpl {
  return isDesktop() ? (tauriFetch as FetchImpl) : fetch;
}

/** Read the API key for a provider from the in-memory settings (keychain-backed). */
export function requireApiKey(
  apiKeys: Record<string, string>,
  provider: string,
): string {
  const key = apiKeys[provider];
  if (!key) throw new Error(`No API key set for ${provider}`);
  return key;
}

/** Shared dependencies every adapter call needs: a fetch and a resolved key. */
export interface ApiDeps {
  fetch: FetchImpl;
  apiKey: string;
}

/** Throw a provider-tagged error carrying the response body on a non-2xx. */
export async function assertOk(
  response: Response,
  provider: string,
): Promise<Response> {
  if (response.ok) return response;
  let detail = "";
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    // body already consumed / unreadable — status alone is enough
  }
  throw new Error(`${provider} request failed (${response.status}): ${detail}`);
}

/** Wrap wav bytes as a Blob for multipart upload. */
export function wavBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: "audio/wav" });
}
