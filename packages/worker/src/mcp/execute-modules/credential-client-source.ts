/**
 * Sandbox source for the `credential()` / `credentials()` scoped clients
 * (ADR 0068), shared by hosted runs (prelude) and CLI `--local` (runtime
 * shim). It defines `__kodyCreateCredentialRuntime(call)`, where `call(name,
 * args)` reaches the host's `credentialClient*` tools.
 *
 * A client holds an opaque, run-scoped handle and never a value. `fetch`
 * sends the handle in an out-of-band header that only the fetch gateway
 * reads; the gateway places the credential and holds redirects back, and the
 * client follows each hop through the gateway again, with the credential only
 * on its hosts.
 */
import { credentialClientHeaderName } from '#worker/credentials/credential-client-header.ts'

export const credentialClientToolNames = {
	open: 'credentialClientOpen',
	openAll: 'credentialClientOpenAll',
	check: 'credentialClientCheck',
	sign: 'credentialClientSign',
	callTool: 'credentialClientCallTool',
	refresh: 'credentialClientRefresh',
} as const

export function createCredentialClientRuntimeSource() {
	return `
function __kodyCreateCredentialRuntime(__kodyCredentialCall) {
  const handleHeader = ${JSON.stringify(credentialClientHeaderName)};
  const codePattern = /^\\[([a-z_]+)\\] /;
  const createUrlPattern = /Create one at (https?:\\/\\/\\S+)/;
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);
  const maxRedirects = 20;
  const toError = (body) => {
    const error = new Error(String(body?.message ?? 'The credential could not be used.'));
    error.name = 'CredentialError';
    error.code = typeof body?.code === 'string' ? body.code : 'credential_error';
    error.retryWith = Array.isArray(body?.retryWith) ? body.retryWith : [];
    if (Array.isArray(body?.options)) error.options = body.options;
    if (Array.isArray(body?.possibleMatches)) error.possibleMatches = body.possibleMatches;
    if (typeof body?.createUrl === 'string') error.createUrl = body.createUrl;
    return error;
  };
  const fromThrown = (error) => {
    const message = String(error?.message ?? error ?? '');
    const match = codePattern.exec(message);
    if (!match) return error;
    const createUrl = createUrlPattern.exec(message)?.[1];
    return toError({
      code: match[1],
      message: message.slice(match[0].length),
      ...(createUrl ? { createUrl } : {}),
    });
  };
  const invoke = async (name, args) => {
    let result;
    try {
      result = await __kodyCredentialCall(name, args);
    } catch (error) {
      throw fromThrown(error);
    }
    if (result && result.ok === false) throw toError(result.error);
    return result?.value;
  };
  const hostAllowed = (hosts, host) => {
    const target = String(host ?? '').toLowerCase();
    return hosts.some((entry) => {
      const normalized = String(entry).trim().toLowerCase();
      if (!normalized.startsWith('*.')) return normalized === target;
      const suffix = normalized.slice(1);
      if (!target.endsWith(suffix)) return false;
      const label = target.slice(0, -suffix.length);
      return label.length > 0 && !label.includes('.');
    });
  };
  const firstExactHost = (hosts) =>
    hosts.find((host) => !String(host).startsWith('*.')) ?? null;
  const urlHostname = (raw) => {
    try {
      return new URL(String(raw)).hostname;
    } catch {
      return null;
    }
  };
  const resolveUrl = (input, hosts) => {
    const raw = input instanceof Request ? input.url : String(input);
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
    const host = firstExactHost(hosts);
    if (!host) {
      throw toError({
        code: 'invalid_request',
        message: 'This credential has no exact host to resolve a relative URL against; pass an absolute https:// URL on one of its hosts.',
      });
    }
    return new URL(raw, 'https://' + host).toString();
  };
  const isReplayableBody = (body) =>
    body == null ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof FormData !== 'undefined' && body instanceof FormData);
  const discard = async (body) => {
    try {
      await body?.cancel();
    } catch {
      // Already consumed, cancelled, or locked: nothing left to release.
    }
  };
  const send = async (target, init, handle) => {
    const headers = new Headers(
      init.headers ?? (target instanceof Request ? target.headers : undefined),
    );
    if (handle) headers.set(handleHeader, handle);
    else headers.delete(handleHeader);
    const next = { ...init, headers, redirect: 'manual' };
    if (next.body != null && typeof next.body.getReader === 'function') next.duplex = 'half';
    try {
      return await globalThis.fetch(target, next);
    } catch (error) {
      // Transport errors (KodyGatewayError, AbortError) keep their shape.
      if (typeof error?.mayHaveReachedOrigin === 'boolean') throw error;
      throw fromThrown(error);
    }
  };
  // An init body goes out as the caller's own value, so in-memory bytes
  // stream without a copy and a refresh replay resends them. A ReadableStream
  // body is sent once and never buffered: its 401 goes back to the caller
  // after the refresh. A Request input keeps a clone for replay, released on
  // every path that does not resend it.
  const createFetch = (opened) => async (input, init) => {
    const redirectMode =
      init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    const url = resolveUrl(input, opened.hosts);
    let target = url;
    let targetInit = { ...(init ?? {}) };
    if (input instanceof Request) {
      target = new Request(url, new Request(input, init));
      targetInit = {};
    }
    let carriesCredential = true;
    for (let hop = 0; ; hop += 1) {
      const request = target instanceof Request ? target : null;
      const replay = request?.body ? request.clone() : request;
      const resendable = request ? true : isReplayableBody(targetInit.body);
      const release = async () => {
        if (replay && replay !== request) await discard(replay.body);
      };
      let response = null;
      try {
        response = await send(target, targetInit, carriesCredential ? opened.handle : null);
        if (opened.kind === 'oauth' && carriesCredential && response.status === 401) {
          const refreshed = await invoke(${JSON.stringify(credentialClientToolNames.refresh)}, { handle: opened.handle });
          if (refreshed?.refreshed && resendable) {
            await discard(response.body);
            response = null;
            const retry = replay?.body ? replay.clone() : (replay ?? target);
            response = await send(retry, targetInit, opened.handle);
          }
        }
      } catch (error) {
        await discard(response?.body);
        await release();
        throw error;
      }
      if (!redirectStatuses.has(response.status) || redirectMode === 'manual') {
        await release();
        return response;
      }
      if (redirectMode === 'error') {
        await discard(response.body);
        await release();
        throw new TypeError('The response redirected and redirect is "error".');
      }
      // A url credential owns its whole URL, so its redirects come back as
      // they are: following one would need the secret URL as the base.
      if (opened.kind === 'url') {
        await release();
        return response;
      }
      const location = response.headers.get('location');
      if (!location) {
        await release();
        return response;
      }
      if (hop >= maxRedirects) {
        await discard(response.body);
        await release();
        throw new TypeError('Too many redirects.');
      }
      const method = request ? request.method : String(targetInit.method ?? 'GET').toUpperCase();
      const rewritesToGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === 'POST');
      // A stream body was already sent, so a redirect that keeps the body
      // comes back to the caller instead.
      if (!rewritesToGet && !resendable) return response;
      await discard(response.body);
      const next = new URL(location, response.url || (request ? request.url : String(target)));
      // The credential follows only to its own hosts over https.
      carriesCredential =
        next.protocol === 'https:' &&
        hostAllowed(opened.hosts, next.hostname);
      const headers = new Headers(request ? replay.headers : targetInit.headers);
      if (!carriesCredential) headers.delete('authorization');
      if (rewritesToGet) {
        headers.delete('content-type');
        headers.delete('content-length');
      }
      if (request) {
        target = new Request(next, {
          method: rewritesToGet ? 'GET' : replay.method,
          headers,
          body: rewritesToGet ? null : replay.body,
          ...(rewritesToGet || !replay.body ? {} : { duplex: 'half' }),
        });
      } else {
        target = next.toString();
        const { body, ...rest } = targetInit;
        targetInit = {
          ...rest,
          method: rewritesToGet ? 'GET' : method,
          headers,
          ...(rewritesToGet || body == null ? {} : { body }),
        };
      }
    }
  };
  const toClient = (opened) => {
    const client = { name: opened.name, scope: opened.scope, kind: opened.kind, hosts: [...opened.hosts] };
    if (opened.hint) client.hint = opened.hint;
    if (opened.kind === 'mcp') {
      client.callTool = async (tool, args) =>
        await invoke(${JSON.stringify(credentialClientToolNames.callTool)}, { handle: opened.handle, tool, args: args ?? {} });
    } else {
      // Keys (secret kind) keep fetch and also expose HMAC sign() so webhook
      // CRC / signature helpers work without re-kinding the Key as signing.
      // JWT sign() still requires kind signing (enforced on the host).
      if (opened.kind === 'signing' || opened.kind === 'secret') {
        // http-signature signs the request it describes, so its host is the
        // url's host; it resolves to the headers to add to that request.
        client.sign = async (operation) => {
          const { host, ...rest } = operation ?? {};
          const httpSignature = rest.type === 'http-signature';
          const result = await invoke(${JSON.stringify(credentialClientToolNames.sign)}, {
            handle: opened.handle,
            host: host ?? (httpSignature ? urlHostname(rest.url) : firstExactHost(opened.hosts)),
            operation: rest,
          });
          return httpSignature ? result?.headers : result?.signature;
        };
      }
      if (opened.kind !== 'signing') {
        client.fetch = createFetch(opened);
      }
    }
    return Object.freeze(client);
  };
  const open = async (args) => toClient(await invoke(${JSON.stringify(credentialClientToolNames.open)}, args));
  const credential = async (key) => await open({ key });
  credential.named = async (name, options) =>
    await open({ name, scope: options?.scope ?? null });
  credential.visitor = async (need) => await open({ visitorNeed: need });
  const credentials = async (key) => {
    const opened = await invoke(${JSON.stringify(credentialClientToolNames.openAll)}, { key });
    return (Array.isArray(opened) ? opened : []).map(toClient);
  };
  return { credential: Object.freeze(credential), credentials };
}
	`.trim()
}
