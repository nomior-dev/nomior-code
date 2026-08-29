/**
 * Is the client on the same machine as this server?
 *
 * Only the connectors panel asks. Google's installed-app flow redirects to a
 * loopback listener that `GoogleAuth` binds on 127.0.0.1 of the *server's*
 * host, so a browser anywhere else cannot deliver the authorization code — the
 * panel has to say so instead of opening a URL that will hang.
 *
 * The signal is the socket the upgrade arrived on: a loopback peer address is
 * the same kernel, which is the same machine. Two known blind spots, both of
 * which fail toward offering the flow rather than hiding it: a reverse proxy
 * on this host makes every client look local, so a request carrying forwarding
 * headers is treated as remote; and a tunnel that terminates on loopback
 * without setting them (an SSH `-L` forward, `tailscale serve`) still reads as
 * local. Nothing breaks in that case — the browser opens the URL and the
 * redirect never arrives, which is the same outcome as before this check.
 *
 * @module nomior/rpc/clientLocality
 */
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/** Headers a proxy or tunnel adds; any of them means the peer is not the client. */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded"] as const;

/** Same set as `isLoopbackHostname` in `http.ts`, inlined to keep this leaf-free. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "localhost"]);

/** Node's IPv4-mapped IPv6 form, as `auth/utils.ts` normalizes it. */
const normalizeAddress = (address: string): string => {
  const bare = address
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return bare.startsWith("::ffff:") ? bare.slice("::ffff:".length) : bare;
};

const peerAddress = (source: unknown): string | undefined => {
  if (source === null || typeof source !== "object") {
    return undefined;
  }
  const candidate = source as {
    readonly remoteAddress?: string | null;
    readonly socket?: { readonly remoteAddress?: string | null };
  };
  const address = candidate.socket?.remoteAddress ?? candidate.remoteAddress;
  return typeof address === "string" && address.length > 0 ? address : undefined;
};

export const isLocalClientRequest = (request: HttpServerRequest.HttpServerRequest): boolean => {
  if (FORWARDING_HEADERS.some((header) => request.headers[header] !== undefined)) {
    return false;
  }
  const address = peerAddress(request.source);
  return address !== undefined && LOOPBACK_ADDRESSES.has(normalizeAddress(address));
};
