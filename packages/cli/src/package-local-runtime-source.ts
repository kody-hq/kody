/**
 * `kody:runtime` for unpublished package runs (`kody dev`, local export/job/
 * webhook/subscription). Same CapabilityProxy bridge as local-execute, plus a
 * real `packageContext` and mock-backed `packageStorage()` hops.
 */

import { credentialClientRuntimeSource } from './credential-client-runtime-source.js'
import {
	kodyRuntimeStorageSymbolDescription,
	localExecuteCompatibilityDate,
	localExecuteCompatibilityFlags,
	localGatewayFetchStreamRuntimeSource,
	localWorkerModuleNames,
	runSecretEnvVar,
	runSecretHeader,
} from './local-runtime-source.js'
import {
	appLogMarker,
	devErrorHeader,
	devRequestIdHeader,
} from './dev/dev-protocol.js'
import { devPublicUrlHeader } from './dev/dev-proxy-origin.js'

export type PackageLocalContext = {
	packageId: string
	kodyId: string
	sourceId?: string
	publishedCommit?: string | null
	appBasePath: string
	hostedUrl: string
	assetBasePath: string
	clientModuleUrl: string | null
	cookiePrefix: string
}

export {
	localExecuteCompatibilityDate,
	localExecuteCompatibilityFlags,
	localWorkerModuleNames,
	runSecretEnvVar,
	runSecretHeader,
}

/**
 * Runtime module for package-local workerd. `packageStorage()` hops through the
 * bridge to mock `__mockPackageStorage*` (or refuses clearly on prod until the
 * package is published).
 *
 * `packageBinding` must be a signed `kpb1.…` token from package-graph. Bare
 * package UUIDs are never accepted here — CapabilityProxy only trusts bindings
 * verified by `authorizeLocalExecutePackageBinding`.
 */
export function createPackageLocalRuntimeModuleSource(input: {
	packageContext: PackageLocalContext
	/** When true, packageStorage uses mock capability hops. */
	mockStorage: boolean
	/**
	 * Signed local-execute package binding (`kpb1.…`). When set, CAF and
	 * oauthClientCredentials send it as `packageId` on CapabilityProxy hops.
	 */
	packageBinding?: string
}): string {
	const ctxLiteral = JSON.stringify(input.packageContext)
	const packageBinding =
		typeof input.packageBinding === 'string' &&
		input.packageBinding.startsWith('kpb1.')
			? input.packageBinding
			: null
	const packageBindingLiteral = JSON.stringify(packageBinding)
	const storageBlock = input.mockStorage
		? `
export function packageStorage() {
	return {
		async get(key) {
			const result = await __kodyCall(['kody', '__mockPackageStorageGet'], [{ key: String(key) }]);
			return result?.value ?? null;
		},
		async set(key, value) {
			await __kodyCall(['kody', '__mockPackageStorageSet'], [{ key: String(key), value }]);
		},
		async delete(key) {
			const result = await __kodyCall(['kody', '__mockPackageStorageDelete'], [{ key: String(key) }]);
			return Boolean(result?.deleted);
		},
		async list() {
			const result = await __kodyCall(['kody', '__mockPackageStorageList'], [{}]);
			return result?.entries ?? [];
		},
		/** Scratch SQLite bucket (same shape hosted packageStorage().sql returns). */
		async sql(query, bindings = []) {
			const result = await __kodyCall(
				['kody', '__mockPackageStorageSql'],
				[{ query: String(query), bindings: Array.isArray(bindings) ? bindings : [] }],
			);
			return result ?? { rows: [] };
		},
	};
}
`
		: `
export function packageStorage() {
	throw new Error(
		'packageStorage() against --target prod requires a published package with real storage. ' +
			'Use \`--target mock\` for scratch storage while iterating on an unpublished package.',
	);
}
`

	return `
import { AsyncLocalStorage } from 'node:async_hooks';

${localGatewayFetchStreamRuntimeSource({
	callUnavailableMessage:
		'kody:runtime is only available while a local package run is in progress.',
})}

export const kody = __kodyNamespace(['kody']);

export const workflows = {
	create: async (input) => await __kodyCall(['workflows', 'create'], [input ?? {}]),
};

export const packages = null;
${storageBlock}

function __kodyPackageSecretsUnavailable() {
	throw new Error(
		'packageSecrets is not available in this local package context on the CLI mock/prod bridge yet.',
	);
}

export const packageSecrets = {
	get: async () => __kodyPackageSecretsUnavailable(),
	has: async () => __kodyPackageSecretsUnavailable(),
};
export const packageContext = Object.freeze(${ctxLiteral});
export const email = null;
export const events = null;

// Signed binding from package-graph only (never a bare package UUID). Origin
// verifies via authorizeLocalExecutePackageBinding.
const __kodyPackageBinding = ${packageBindingLiteral};

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
	if (body == null) return null;
	if (typeof body === 'string') return new TextEncoder().encode(body);
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
			'Local package createAuthenticatedFetch does not support FormData bodies yet; use Uint8Array, Blob, or string.',
		);
	}
	throw new Error(
		'Local package createAuthenticatedFetch could not serialize the request body.',
	);
}

/**
 * Match local-execute: hop through CapabilityProxy \`kody.authenticatedFetch\`
 * (not a non-existent \`kody.createAuthenticatedFetch\` runtime function).
 */
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
			...(__kodyPackageBinding ? { packageId: __kodyPackageBinding } : {}),
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
	bearer(input) {
		const name = String(input?.name ?? input ?? '').trim();
		if (!name) throw new Error('secretHeaders.bearer requires a secret name.');
		const scope =
			typeof input?.scope === 'string' && input.scope.trim()
				? input.scope.trim()
				: null;
		return scope
			? \`{{secret-bearer:\${name}|scope=\${scope}}}\`
			: \`{{secret-bearer:\${name}}}\`;
	},
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
	const { packageId: _ignored, ...rest } = input ?? {};
	return await __kodyCall(['kody', 'oauthClientCredentials'], [{
		...rest,
		...(__kodyPackageBinding ? { packageId: __kodyPackageBinding } : {}),
	}]);
}

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

const __kodyRuntimeDefault = Object.freeze({
	kody,
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

export function __kodyRunInLocalRuntime(callback) {
	return __kodyRuntimeStorage.run(__kodyRuntimeDefault, callback);
}

// Keep unused helpers referenced so esbuild/workerd does not strip them in future.
void __kodyNullBodyStatuses;
void __kodyBytesToBase64;
void __kodyBase64ToBytes;
`.trimStart()
}

/** Execute-style entry: default export function(params). */
export function createPackageModuleEntrySource(
	input: { sideEffectModules?: ReadonlyArray<string> } = {},
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
			const result = await __kodyRunInLocalRuntime(async () => {
				const module = await import(${JSON.stringify(`./${localWorkerModuleNames.user}`)});
				if (typeof module?.default !== 'function') {
					throw new Error('Package modules must default export a function.');
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

/**
 * App fetch entry: wraps user `kody.app.entry` so the host always sees a Worker
 * `{ fetch }` export. Mount is already stripped by the Node proxy before this
 * request reaches workerd (pathname is the rest path).
 */
/**
 * workerd entry for `kody dev` apps. Beyond resolving the fetch handler it:
 * tags every `console.*` call with the proxy's request id (written to stdout
 * behind {@link appLogMarker} so the CLI can stream it), strips the internal
 * run-secret / request-id headers before the app sees the request, and turns
 * uncaught handler errors into a {@link devErrorHeader} response carrying the
 * raw stack for the CLI to source-map.
 */
export function createPackageAppEntrySource(
	input: { sideEffectModules?: ReadonlyArray<string> } = {},
): string {
	const sideEffectImports = [...new Set(input.sideEffectModules ?? [])]
		.filter((name) => typeof name === 'string' && name.trim().length > 0)
		.map((name) => `import ${JSON.stringify(name)};`)
		.join('\n')
	const sideEffectBlock = sideEffectImports ? `${sideEffectImports}\n` : ''
	return `
${sideEffectBlock}import { AsyncLocalStorage } from 'node:async_hooks';
import { formatWithOptions } from 'node:util';
import {
	__kodyInstallLocalBridge,
	__kodyRunInLocalRuntime,
} from ${JSON.stringify(localWorkerModuleNames.runtime)};

const __kodyRunSecretHeader = ${JSON.stringify(runSecretHeader)};
const __kodyRequestIdHeader = ${JSON.stringify(devRequestIdHeader)};
const __kodyPublicUrlHeader = ${JSON.stringify(devPublicUrlHeader)};
const __kodyDevErrorHeader = ${JSON.stringify(devErrorHeader)};
const __kodyLogMarker = ${JSON.stringify(appLogMarker)};
const __kodyDevRequest = new AsyncLocalStorage();
const __kodyNativeConsole = globalThis.console;

function __kodyFormatArgs(args) {
	try {
		return formatWithOptions({ colors: false, depth: 6 }, ...args);
	} catch {
		return args.map((value) => String(value)).join(' ');
	}
}

function __kodyDevLog(level, args) {
	const request = __kodyDevRequest.getStore() ?? null;
	__kodyNativeConsole.log(
		__kodyLogMarker + JSON.stringify({ level, message: __kodyFormatArgs(args), request }),
	);
}

const __kodyDevConsole = Object.create(__kodyNativeConsole);
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
	__kodyDevConsole[level] = (...args) => __kodyDevLog(level, args);
}
globalThis.console = __kodyDevConsole;

function __kodyResolveFetch(module) {
	if (typeof module?.default === 'function') return module.default.bind(module);
	if (module?.default && typeof module.default.fetch === 'function') {
		return module.default.fetch.bind(module.default);
	}
	if (typeof module?.fetch === 'function') return module.fetch.bind(module);
	throw new Error(
		'kody.app.entry must default-export a fetch handler, { fetch }, or a named fetch export.',
	);
}

function __kodyErrorResponse(error) {
	const value = error instanceof Error ? error : new Error(String(error));
	return new Response(
		JSON.stringify({ name: value.name, message: value.message, stack: value.stack ?? String(value) }),
		{
			status: 500,
			headers: { 'content-type': 'application/json', [__kodyDevErrorHeader]: '1' },
		},
	);
}

export default {
	async fetch(request, env) {
		const secret = env.${runSecretEnvVar};
		if (!secret || request.headers.get(__kodyRunSecretHeader) !== secret) {
			return new Response(
				'Forbidden: missing dev run secret. Open the URL kody dev printed; this internal workerd port only answers its proxy.',
				{ status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' } },
			);
		}
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
		// Public URL is set only by the Node proxy from the trusted listen
		// origin (never from client Host). Rebuild request.url so CSRF checks
		// comparing Origin to new URL(request.url).origin see the dev origin.
		const publicUrl = request.headers.get(__kodyPublicUrlHeader);
		const appUrl = publicUrl || request.url;
		const url = new URL(appUrl);
		const tag = {
			id: request.headers.get(__kodyRequestIdHeader) ?? '-',
			method: request.method,
			path: url.pathname + url.search,
		};
		const appRequest = new Request(appUrl, request);
		appRequest.headers.delete(__kodyRunSecretHeader);
		appRequest.headers.delete(__kodyRequestIdHeader);
		appRequest.headers.delete(__kodyPublicUrlHeader);
		appRequest.headers.set('host', url.host);
		return await __kodyDevRequest.run(tag, async () => {
			try {
				return await __kodyRunInLocalRuntime(async () => {
					const module = await import(${JSON.stringify(`./${localWorkerModuleNames.user}`)});
					const fetchHandler = __kodyResolveFetch(module);
					return await fetchHandler(appRequest, env);
				});
			} catch (error) {
				return __kodyErrorResponse(error);
			}
		});
	},
};
`.trimStart()
}
