/**
 * Sources for the workerd process behind `execute --local`. User code sees the
 * same `kody:runtime` surface as ad hoc cloud execute; every call becomes a
 * `{ path, args }` hop to the CLI's loopback bridge, which adds the API token
 * and forwards it to CapabilityProxy. The token never enters workerd.
 *
 * Stamped `kody:@…` packages also receive a package-graph CapabilityProxy shim
 * from origin. This host module still binds createAuthenticatedFetch /
 * secretHeaders / oauthClientCredentials / credential / credentials for ad hoc
 * imports, and the entry installs the shared runtime ALS before evaluating user
 * code so published bundles that inline optional runtime exports
 * (Dropbox-style) see a populated store at module evaluation — matching cloud
 * `__kodyRunInRuntime`.
 */

import { credentialClientRuntimeSource } from './credential-client-runtime-source.js'

import {
	egressBlockedHeader,
	egressGateModuleName,
	type LocalEgressPolicy,
} from './local-egress.js'

export const localExecuteCompatibilityDate = '2026-04-16'
export const localExecuteCompatibilityFlags = ['nodejs_compat'] as const

export const localWorkerModuleNames = {
	entry: '__kody_local_entry.js',
	user: 'main.js',
	runtime: 'kody:runtime',
	/**
	 * Flat alias for `kody:runtime`. Path-like package module names
	 * (`kody:@scope/pkg/export`) path-join bare `kody:runtime` into
	 * `kody:@scope/pkg/kody:runtime`; local deps rewrite imports to this
	 * registered name, then prefix `/` on the import reference so workerd
	 * does not still join it onto the importer. Registered names must not
	 * start with `/` — workerd rejects those.
	 */
	runtimeFlatAlias: '.__kody_runtime__.js',
} as const

/** Header carrying the per-run secret on workerd → bridge and CLI → workerd hops. */
export const runSecretHeader = 'x-kody-run-secret'
export const runSecretEnvVar = 'KODY_RUN_SECRET'

/** Runtime ALS symbol shared with stamped / inlined `kody:runtime` helpers. */
export const kodyRuntimeStorageSymbolDescription = 'kody.runtimeStorage'

/**
 * Thin re-export of `kody:runtime` under {@link localWorkerModuleNames.runtimeFlatAlias}.
 * Must not embed a second runtime copy — entry installs the bridge only on
 * `kody:runtime`, and local deps need that same module instance.
 * `export *` omits `default`, so re-export it explicitly.
 */
export function createRuntimeFlatAliasSource(): string {
	const runtime = JSON.stringify(localWorkerModuleNames.runtime)
	return `export * from ${runtime};\nexport { default } from ${runtime};\n`
}

/** Workerd-side `kody.gatewayFetchStream` + bridge install helpers (shared shape). */
export function localGatewayFetchStreamRuntimeSource(options: {
	/** Error when the JSON/call bridge is missing. */
	callUnavailableMessage: string
}): string {
	return `
let __kodyBridge = null;

export function __kodyInstallLocalBridge(bridge) {
	// Object form: { call, gatewayFetch }. Legacy function form still works for /call.
	__kodyBridge =
		typeof bridge === 'function' ? { call: bridge, gatewayFetch: null } : bridge;
}

function __kodyCall(path, args) {
	if (__kodyBridge === null || typeof __kodyBridge.call !== 'function') {
		throw new Error(${JSON.stringify(options.callUnavailableMessage)});
	}
	return __kodyBridge.call(path, args);
}

const __kodyGatewayNullBodyStatuses = new Set([101, 103, 204, 205, 304]);
const __kodySecretResolutionHeader = 'x-kody-secret-resolution';

/**
 * Streaming CapabilityProxy hop (POST /v1/capability-proxy/gateway-fetch via the
 * loopback bridge). Returns a real Response — not the JSON gatewayFetch envelope.
 * See kody-hq/kody docs/contributing/contracts/cli-streaming-gateway-fetch.md.
 */
async function gatewayFetchStream(input) {
	if (__kodyBridge === null || typeof __kodyBridge.gatewayFetch !== 'function') {
		throw new Error(
			'Local execute needs kody.gatewayFetchStream on the host runtime to stream a secret-aware fetch body (multipart, large, or ReadableStream). Upgrade @kodycodes/cli, or buffer the body under 4 MiB for the JSON gatewayFetch hop.',
		);
	}
	const record = input != null && typeof input === 'object' && !Array.isArray(input) ? input : null;
	if (!record) {
		throw new Error('gatewayFetchStream requires a single object argument: { request, packageId? }.');
	}
	const requestValue = record.request;
	if (requestValue == null || typeof requestValue !== 'object' || Array.isArray(requestValue)) {
		throw new Error('gatewayFetchStream requires request: { url, method?, headers?, body? }.');
	}
	const url = typeof requestValue.url === 'string' ? requestValue.url.trim() : '';
	if (!url) {
		throw new Error('gatewayFetchStream request.url must be a non-empty absolute URL.');
	}
	const method =
		typeof requestValue.method === 'string' && requestValue.method.trim()
			? requestValue.method.trim()
			: 'GET';
	const packageId =
		typeof record.packageId === 'string' && record.packageId.trim()
			? record.packageId.trim()
			: undefined;
	const rawHeaders =
		requestValue.headers != null &&
		typeof requestValue.headers === 'object' &&
		!Array.isArray(requestValue.headers)
			? { ...requestValue.headers }
			: {};
	const outboundHeaders = {};
	let contentType = null;
	let secretResolution = null;
	for (const [key, value] of Object.entries(rawHeaders)) {
		if (typeof value !== 'string') continue;
		const lower = key.toLowerCase();
		if (lower === 'content-type') {
			contentType = value;
			continue;
		}
		if (lower === __kodySecretResolutionHeader) {
			secretResolution = value;
			continue;
		}
		outboundHeaders[key] = value;
	}
	const headers = {
		'X-Kody-Gateway-Url': url,
		'X-Kody-Gateway-Method': method,
	};
	if (packageId) headers['X-Kody-Gateway-Package-Id'] = packageId;
	if (Object.keys(outboundHeaders).length > 0) {
		headers['X-Kody-Gateway-Headers'] = JSON.stringify(outboundHeaders);
	}
	if (contentType) headers['Content-Type'] = contentType;
	if (secretResolution) headers[__kodySecretResolutionHeader] = secretResolution;
	const body = Object.hasOwn(requestValue, 'body') ? requestValue.body : null;
	const init = {
		method: 'POST',
		headers,
	};
	const upper = method.toUpperCase();
	if (body != null && upper !== 'GET' && upper !== 'HEAD') {
		init.body = body;
		init.duplex = 'half';
	}
	if (requestValue.signal != null) init.signal = requestValue.signal;
	if (requestValue.redirect != null) init.redirect = requestValue.redirect;
	const response = await __kodyBridge.gatewayFetch(init);
	const cacheControl = response.headers.get('cache-control') ?? '';
	const contentTypeHeader = response.headers.get('content-type') ?? '';
	if (response.status === 413 && !contentTypeHeader.includes('application/json')) {
		throw new Error(
			'Request body exceeds the Worker upload limit of 104857600 bytes (100 MiB).',
		);
	}
	if (cacheControl.includes('no-store') && contentTypeHeader.includes('application/json')) {
		const text = await response.clone().text();
		try {
			const parsed = JSON.parse(text);
			if (parsed != null && typeof parsed === 'object' && parsed.error != null) {
				const err = parsed.error;
				const message =
					typeof err === 'string'
						? err
						: typeof err?.message === 'string'
							? err.message
							: 'gatewayFetchStream failed.';
				throw new Error(message);
			}
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
	}
	if (__kodyGatewayNullBodyStatuses.has(response.status)) {
		return new Response(null, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}
	return response;
}

function __kodyNamespace(path) {
	const label = '[KodyRuntime:' + path.join('.') + ']';
	return new Proxy(function () {}, {
		get(_target, property) {
			if (typeof property === 'symbol' || property === 'then' || property === 'toJSON') {
				return undefined;
			}
			if (property === 'toString' || property === 'inspect') return () => label;
			if (
				path.length === 1 &&
				path[0] === 'kody' &&
				property === 'gatewayFetchStream'
			) {
				return gatewayFetchStream;
			}
			return __kodyNamespace([...path, property]);
		},
		apply(_target, _thisArg, args) {
			return __kodyCall(path, args);
		},
	});
}
`.trimStart()
}

export function createLocalRuntimeModuleSource(): string {
	return `
import { AsyncLocalStorage } from 'node:async_hooks';

${localGatewayFetchStreamRuntimeSource({
	callUnavailableMessage:
		'kody:runtime is only available while an execute --local run is in progress.',
})}

export const kody = __kodyNamespace(['kody']);

export const workflows = {
	create: async (input) => await __kodyCall(['workflows', 'create'], [input ?? {}]),
};

// Always null: there is no author-facing packages.invoke. Use a static
// kody:@scope/package/export import when the name is known, or import(specifier)
// when the name is data. Under --local, static kody:@ imports are resolved into
// the workerd module list via POST /v1/local-execute/package-graph (see
// local-package-graph.ts / kody-hq/kody#2808) — never a whole-module
// CapabilityProxy → kody.execute hop.
export const packages = null;

export function packageStorage() {
	throw new Error(
		'packageStorage() requires package provenance: this module was not bundled from a saved package and the run has no package context. ' +
			'Ad hoc execute has no scratch SQLite helper. Persist durable state from a saved package with packageStorage().',
	);
}

function __kodyPackageSecretsUnavailable() {
	throw new Error(
		'packageSecrets is not available in this execution context. It is bound for stamped saved-package modules and saved-package runtime contexts.',
	);
}

export const packageSecrets = {
	get: async () => __kodyPackageSecretsUnavailable(),
	has: async () => __kodyPackageSecretsUnavailable(),
};
export const packageContext = Object.freeze({});
export const email = null;
export const events = null;

const __kodyNullBodyStatuses = new Set([204, 205, 304]);

function __kodyBytesToBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary);
}

function __kodyBase64ToBytes(value) {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

async function __kodyBodyToBytes(body) {
	if (typeof body === 'string') {
		return new TextEncoder().encode(body);
	}
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	if (typeof Blob !== 'undefined' && body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
		return new TextEncoder().encode(body.toString());
	}
	if (body && typeof body.getReader === 'function') {
		return new Uint8Array(await new Response(body).arrayBuffer());
	}
	if (typeof FormData !== 'undefined' && body instanceof FormData) {
		throw new Error(
			'Local execute createAuthenticatedFetch does not support FormData bodies yet; use Uint8Array, Blob, or string.',
		);
	}
	throw new Error(
		'Local execute createAuthenticatedFetch could not serialize the request body.',
	);
}

export async function createAuthenticatedFetch(providerName) {
	const name = String(providerName ?? '').trim();
	if (!name) {
		throw new Error('Integration name is required.');
	}
	return async (input, init) => {
		let url;
		let method = 'GET';
		let headers = {};
		let bodyBytes = null;
		if (typeof input === 'string' || input instanceof URL) {
			url = String(input);
			method = String(init?.method ?? 'GET');
			headers = Object.fromEntries(new Headers(init?.headers).entries());
			if (init?.body != null) {
				bodyBytes = await __kodyBodyToBytes(init.body);
			}
		} else {
			const merged = new Request(input, init);
			url = merged.url;
			method = merged.method;
			headers = Object.fromEntries(merged.headers.entries());
			if (method !== 'GET' && method !== 'HEAD') {
				bodyBytes = new Uint8Array(await merged.arrayBuffer());
			}
		}
		const result = await __kodyCall(['kody', 'authenticatedFetch'], [{
			providerName: name,
			request: {
				url,
				method,
				headers,
				...(bodyBytes != null
					? { bodyBase64: __kodyBytesToBase64(bodyBytes) }
					: {}),
			},
		}]);
		const bytes = __kodyBase64ToBytes(result.bodyBase64 ?? '');
		return new Response(
			__kodyNullBodyStatuses.has(result.status) ? null : bytes,
			{
				status: result.status,
				statusText: result.statusText,
				headers: result.headers,
			},
		);
	};
}

export const secretHeaders = {
	basic(input) {
		const usernameSecret = String(input?.usernameSecret ?? '').trim();
		const passwordSecret = String(input?.passwordSecret ?? '').trim();
		if (!usernameSecret || !passwordSecret) {
			throw new Error(
				'secretHeaders.basic requires usernameSecret and passwordSecret.',
			);
		}
		const scope =
			typeof input?.scope === 'string' && input.scope.trim()
				? input.scope.trim()
				: null;
		return scope
			? \`{{secret-basic:username=\${usernameSecret},password=\${passwordSecret}|scope=\${scope}}}\`
			: \`{{secret-basic:username=\${usernameSecret},password=\${passwordSecret}}}\`;
	},
};

export async function oauthClientCredentials(input) {
	return await __kodyCall(['kody', 'oauthClientCredentials'], [input ?? {}]);
}

// Scoped credential clients (ADR 0068): open/sign/callTool/refresh through
// CapabilityProxy \`kody.credentialClient*\`. Fetches carry only an opaque
// handle; origin's gateway places the credential. Secret values never enter
// local workerd — same security as hosted and the package-graph shim.
${credentialClientRuntimeSource}
const __kodyCredentialRuntime = __kodyCreateCredentialRuntime((name, args) =>
	__kodyCall(['kody', name], [args ?? {}]),
);
export const credential = __kodyCredentialRuntime.credential;
export const credentials = __kodyCredentialRuntime.credentials;

const __kodyRuntimeStorageSymbol = Symbol.for(${JSON.stringify(kodyRuntimeStorageSymbolDescription)});
const __globalAny = globalThis;
const __kodyRuntimeStorage =
	__globalAny[__kodyRuntimeStorageSymbol] ??
	(__globalAny[__kodyRuntimeStorageSymbol] = new AsyncLocalStorage());

export function hasScope(request, scope) {
	if (typeof scope !== 'string') return false;
	try {
		const raw = request?.headers?.get('X-Kody-Visitor');
		if (!raw) return false;
		const visitor = JSON.parse(raw);
		return (
			typeof visitor?.userId === 'string' &&
			visitor.userId.length > 0 &&
			Array.isArray(visitor.scopes) &&
			visitor.scopes.includes(scope)
		);
	} catch {
		return false;
	}
}
export function hasVisitorCredential(request, key) {
	return typeof key === 'string' && hasScope(request, \`need:\${key}\`);
}

const __kodyRuntimeDefault = Object.freeze({
	kody,
	hasScope,
	hasVisitorCredential,
	packageStorage,
	createAuthenticatedFetch,
	secretHeaders,
	oauthClientCredentials,
	credential,
	credentials,
	packageContext,
	packageSecrets,
	email,
	workflows,
	packages,
	events,
});
export default __kodyRuntimeDefault;
export const KodyRuntime = Object.freeze({ defaultValue: __kodyRuntimeDefault });

/** Enter the shared runtime ALS before evaluating user / package modules. */
export function __kodyRunInLocalRuntime(callback) {
	return __kodyRuntimeStorage.run(__kodyRuntimeDefault, callback);
}
`.trimStart()
}

/**
 * Local workerd entry. Optional `sideEffectModules` are imported for their
 * evaluation side effects before the user module runs — used to load the
 * origin-supplied gateway-fetch shim so ambient `{{secret:…}}` fetch hops
 * even when the entry has no `kody:@` imports (kody-hq/kody#3020).
 */
export function createLocalEntrySource(
	input: {
		sideEffectModules?: ReadonlyArray<string>
	} = {},
): string {
	const sideEffectImports = [...new Set(input.sideEffectModules ?? [])]
		.filter((name) => typeof name === 'string' && name.trim().length > 0)
		.map((name) => `import ${JSON.stringify(name)};`)
		.join('\n')
	const sideEffectBlock = sideEffectImports ? `${sideEffectImports}\n` : ''
	return `
${sideEffectBlock}import {
	__kodyInstallLocalBridge,
	__kodyRunInLocalRuntime,
} from ${JSON.stringify(localWorkerModuleNames.runtime)};

const __kodyRunSecretHeader = ${JSON.stringify(runSecretHeader)};
let __kodyClaimed = false;

const __kodyNativeFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
	const response = await __kodyNativeFetch(...args);
	if (response.headers.get(${JSON.stringify(egressBlockedHeader)}) === '1') {
		throw new TypeError(await response.text());
	}
	return response;
};

function __kodyFormatLogArgs(args) {
	return args.map(String).join(' ');
}

export default {
	async fetch(request, env) {
		const secret = env.${runSecretEnvVar};
		if (__kodyClaimed || !secret || request.headers.get(__kodyRunSecretHeader) !== secret) {
			return new Response('Forbidden: missing run secret, or this one-shot run was already claimed. Only the kody process that started this workerd may call it.', { status: 403 });
		}
		__kodyClaimed = true;
		const { params } = await request.json();
		__kodyInstallLocalBridge({
			call: async (path, args) => {
				const response = await env.KODY_BRIDGE.fetch('http://kody-bridge/call', {
					method: 'POST',
					headers: { 'content-type': 'application/json', [__kodyRunSecretHeader]: secret },
					body: JSON.stringify({ path, args }),
				});
				const data = await response.json();
				if (data.error) throw new Error(data.error);
				return data.result;
			},
			gatewayFetch: async (init) => {
				const headers = new Headers(init?.headers);
				headers.set(__kodyRunSecretHeader, secret);
				return await env.KODY_BRIDGE.fetch('http://kody-bridge/gateway-fetch', {
					...init,
					method: 'POST',
					headers,
				});
			},
		});
		const logs = [];
		const nativeConsole = globalThis.console;
		globalThis.console = {
			...nativeConsole,
			log: (...a) => { logs.push(__kodyFormatLogArgs(a)); },
			info: (...a) => { logs.push('[info] ' + __kodyFormatLogArgs(a)); },
			debug: (...a) => { logs.push('[debug] ' + __kodyFormatLogArgs(a)); },
			warn: (...a) => { logs.push('[warn] ' + __kodyFormatLogArgs(a)); },
			error: (...a) => { logs.push('[error] ' + __kodyFormatLogArgs(a)); },
		};
		try {
			// Evaluate user + stamped package modules inside the runtime ALS so
			// inlined optional exports capture callable helpers (cloud parity).
			const result = await __kodyRunInLocalRuntime(async () => {
				const module = await import(${JSON.stringify(`./${localWorkerModuleNames.user}`)});
				if (typeof module?.default !== 'function') {
					throw new Error('Kody execute modules must default export a function.');
				}
				return await module.default(params);
			});
			return new Response(JSON.stringify({ result, logs }), {
				headers: { 'content-type': 'application/json' },
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json({ error: message, logs });
		} finally {
			globalThis.console = nativeConsole;
		}
	},
};
`.trimStart()
}

export type WorkerdPackageModuleFile = {
	/** Exact module name as imported from user / package code (e.g. `kody:@scope/pkg/export`). */
	name: string
	/** Path relative to the workerd config file. */
	file: string
}

/**
 * workerd text config. `files` are embedded relative to the config file.
 * Outbound fetch is public-only unless private-network access is explicitly
 * enabled. The loopback bridge remains a separate external service.
 *
 * Optional `packageModules` are stamped `kody:@…` (and nested) modules from
 * POST /v1/local-execute/package-graph — embedded alongside the user module so
 * imports resolve inside local workerd without a remote `kody.execute`.
 */
export function createWorkerdConfig(input: {
	bridgePort: number
	files: { entry: string; user: string; runtime: string }
	packageModules?: Array<WorkerdPackageModuleFile>
	allowPrivateNetwork?: boolean
	/** Routes outbound fetch through the egress gate (`createEgressGateSource`). */
	egress?: { policy: LocalEgressPolicy; gateFile: string }
}): string {
	const flags = localExecuteCompatibilityFlags
		.map((flag) => JSON.stringify(flag))
		.join(', ')
	const networkAllow = input.allowPrivateNetwork
		? '["public", "private", "local"]'
		: '["public"]'
	const packageEntries = (input.packageModules ?? [])
		.map(
			(module) =>
				`    (name = ${JSON.stringify(module.name)}, esModule = embed ${JSON.stringify(module.file)}),`,
		)
		.join('\n')
	const packageBlock = packageEntries ? `\n${packageEntries}` : ''
	const egressService = input.egress
		? `\n    (name = "egress-gate", worker = (modules = [(name = ${JSON.stringify(egressGateModuleName)}, esModule = embed ${JSON.stringify(input.egress.gateFile)})], compatibilityDate = ${JSON.stringify(localExecuteCompatibilityDate)}, globalOutbound = "internet", bindings = [(name = "KODY_EGRESS_POLICY", json = ${JSON.stringify(JSON.stringify(input.egress.policy))})])),`
		: ''
	// Flat re-export of kody:runtime (same module instance). Callers must write
	// createRuntimeFlatAliasSource() to this filename before serving.
	const runtimeFlatAliasFile = localWorkerModuleNames.runtimeFlatAlias
	const runtimeFlatAlias = `    (name = ${JSON.stringify(localWorkerModuleNames.runtimeFlatAlias)}, esModule = embed ${JSON.stringify(runtimeFlatAliasFile)}),`
	return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "main", worker = .kodyWorker),
    (name = "kody-bridge", external = (address = "127.0.0.1:${input.bridgePort}", http = ())),
    (name = "internet", network = (allow = ${networkAllow}, tlsOptions = (trustBrowserCas = true))),${egressService}
  ],
  sockets = [ (name = "http", address = "127.0.0.1:0", http = (), service = "main") ],
);

const kodyWorker :Workerd.Worker = (
  modules = [
    (name = ${JSON.stringify(localWorkerModuleNames.entry)}, esModule = embed ${JSON.stringify(input.files.entry)}),
    (name = ${JSON.stringify(localWorkerModuleNames.user)}, esModule = embed ${JSON.stringify(input.files.user)}),
    (name = ${JSON.stringify(localWorkerModuleNames.runtime)}, esModule = embed ${JSON.stringify(input.files.runtime)}),
${runtimeFlatAlias}${packageBlock}
  ],
  compatibilityDate = ${JSON.stringify(localExecuteCompatibilityDate)},
  compatibilityFlags = [${flags}],
  globalOutbound = ${JSON.stringify(input.egress ? 'egress-gate' : 'internet')},
  bindings = [
    (name = "KODY_BRIDGE", service = "kody-bridge"),
    (name = ${JSON.stringify(runSecretEnvVar)}, fromEnvironment = ${JSON.stringify(runSecretEnvVar)}),
  ],
);
`
}
