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
  const send = async (request, handle) => {
    const headers = new Headers(request.headers);
    if (handle) headers.set(handleHeader, handle);
    else headers.delete(handleHeader);
    try {
      return await globalThis.fetch(new Request(request, { headers, redirect: 'manual' }));
    } catch (error) {
      throw fromThrown(error);
    }
  };
  const createFetch = (opened) => async (input, init) => {
    const redirectMode =
      init?.redirect ?? (input instanceof Request ? input.redirect : 'follow');
    const url = resolveUrl(input, opened.hosts);
    let request =
      input instanceof Request
        ? new Request(url, new Request(input, init))
        : new Request(url, init);
    let carriesCredential = true;
    for (let hop = 0; ; hop += 1) {
      const replay = request.body ? request.clone() : request;
      let response = await send(request, carriesCredential ? opened.handle : null);
      if (opened.kind === 'oauth' && carriesCredential && response.status === 401) {
        const refreshed = await invoke(${JSON.stringify(credentialClientToolNames.refresh)}, { handle: opened.handle });
        if (refreshed?.refreshed) {
          await response.body?.cancel();
          const retry = replay.body ? replay.clone() : replay;
          response = await send(retry, opened.handle);
        }
      }
      if (!redirectStatuses.has(response.status) || redirectMode === 'manual') {
        return response;
      }
      if (redirectMode === 'error') {
        await response.body?.cancel();
        throw new TypeError('The response redirected and redirect is "error".');
      }
      // A url credential owns its whole URL, so its redirects come back as
      // they are: following one would need the secret URL as the base.
      if (opened.kind === 'url') return response;
      const location = response.headers.get('location');
      if (!location) return response;
      if (hop >= maxRedirects) {
        await response.body?.cancel();
        throw new TypeError('Too many redirects.');
      }
      await response.body?.cancel();
      const next = new URL(location, response.url || request.url);
      const rewritesToGet =
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && request.method === 'POST');
      // The credential follows only to its own hosts over https.
      carriesCredential =
        next.protocol === 'https:' &&
        hostAllowed(opened.hosts, next.hostname);
      const headers = new Headers(replay.headers);
      if (!carriesCredential) headers.delete('authorization');
      if (rewritesToGet) {
        headers.delete('content-type');
        headers.delete('content-length');
      }
      request = new Request(next, {
        method: rewritesToGet ? 'GET' : replay.method,
        headers,
        body: rewritesToGet ? null : replay.body,
        ...(rewritesToGet || !replay.body ? {} : { duplex: 'half' }),
      });
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
        client.sign = async (operation) => {
          const { host, ...rest } = operation ?? {};
          const result = await invoke(${JSON.stringify(credentialClientToolNames.sign)}, {
            handle: opened.handle,
            host: host ?? firstExactHost(opened.hosts),
            operation: rest,
          });
          return result?.signature;
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
