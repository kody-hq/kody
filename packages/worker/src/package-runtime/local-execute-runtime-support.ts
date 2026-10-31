/**
 * Local-execute runtime shim source builders and inlined-CAF rewrite.
 *
 * Loaded on the Worker through the pre-bundled additional module
 * `node_modules/.kody-generated/local-execute-runtime-support.mjs` so the
 * platform/runtime startup entries do not carry these templates or the
 * rewrite AST walk (kody#2831). Node tests import this TypeScript module
 * directly (or via the vitest alias of that generated specifier).
 */

import { credentialClientHeaderName } from '#worker/credentials/credential-client-header.ts'
import { createCredentialClientRuntimeSource } from '#worker/mcp/execute-modules/credential-client-source.ts'
import {
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
	runtimeModulePath,
} from './module-graph-path-basics.ts'
import {
	createPackageBoundRuntimeExportLines,
	packageBoundRuntimeCreatorNames,
	packageBoundRuntimeExportNames,
	sharedRuntimeExportReasons,
} from './package-bound-runtime-exports.ts'

export {
	moduleSourceHasInlinedKodyRuntime,
	rewriteInlinedLocalExecuteBundleSource,
} from './rewrite-inlined-local-runtime.ts'

/** Host module name the CLI registers in local workerd (`localWorkerModuleNames.runtime`). */
export const localExecuteHostRuntimeModuleName = 'kody:runtime'

/**
 * Null-prototype object literal for the shim's package binding table. Keys
 * that would act as prototype setters are dropped (package ids are UUIDs).
 */
function createPackageBindingsLiteral(bindings: Record<string, string>) {
	const entries = Object.entries(bindings)
		.filter(
			([packageId, binding]) =>
				packageId &&
				packageId !== '__proto__' &&
				typeof binding === 'string' &&
				binding,
		)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(
			([packageId, binding]) =>
				`\t${JSON.stringify(packageId)}: ${JSON.stringify(binding)},`,
		)
	return `{\n\t__proto__: null,\n${entries.join('\n')}${entries.length ? '\n' : ''}}`
}

/**
 * Local workerd supplies `kody:runtime` (CapabilityProxy bridge). Stamped
 * package modules still import `.__kody_virtual__/runtime.js` / package-runtime
 * facades; this shim re-exports the host runtime and binds stamped
 * packageStorage / packageSecrets / createAuthenticatedFetch through
 * CapabilityProxy hops so long-lived OAuth tokens never enter local workerd
 * (kody#2810).
 *
 * `modulePath` must be the workerd module name this source is registered under.
 * The host import uses a relative specifier so workerd resolves it to the
 * exact `kody:runtime` module name — bare `"kody:runtime"` from a path-like
 * module (`.__kody_virtual__/runtime.js` or a nested published-bundle copy)
 * path-joins to `…/.__kody_virtual__/kody:runtime` and fails.
 */
export function createLocalExecuteRuntimeShimSource(
	modulePath: string = runtimeModulePath,
	options: {
		/**
		 * Package id to the binding the package graph signed for it. Origin
		 * accepts only these in place of a package id.
		 */
		packageBindings?: Record<string, string>
	} = {},
) {
	const packageBindingsLiteral = createPackageBindingsLiteral(
		options.packageBindings ?? {},
	)
	const hostRuntimeSpecifier = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(modulePath),
		localExecuteHostRuntimeModuleName,
	)
	return `
import {
	kody,
	packageContext,
	email,
	workflows,
	packages,
	events,
	default as __kodyHostRuntimeDefault,
} from ${JSON.stringify(hostRuntimeSpecifier)};

export {
	kody,
	packageContext,
	email,
	workflows,
	packages,
	events,
};

// Shared visitor-consent helpers (same header as package apps). Facades
// re-export these from sharedRuntimeExportReasons; without them here,
// local package-graph linking fails on \`export { hasScope } from …\`.
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

// Package identity for CapabilityProxy calls (GHSA-5fv3-qv7j-rqf5). Origin
// accepts only a binding the package graph signed for this org and actor,
// never a bare package id, so code cannot claim a package by naming it. The
// bindings stay module-private: package code reaches its own only through its
// per-package \`kody:runtime\` facade, and nothing here is exported or put on
// globalThis. The table is a null-prototype literal and lookups use plain
// property reads, so patched intrinsics cannot observe it.
const __kodyPackageBindings = ${packageBindingsLiteral};
function __kodyPackageBinding(packageId) {
	if (typeof packageId !== "string") return null;
	const binding = __kodyPackageBindings[packageId];
	return typeof binding === "string" ? binding : null;
}

// Pure placeholder builders — same shape as cloud execute helpers (including
// opaque refs from packageSecrets.get). Local isolate wraps globalThis.fetch
// with __kodyGatewayFetch so secret-bearing calls hop through CapabilityProxy
// (same as cloud), including frozen dependency copies that call
// globalThis.fetch instead of free \`fetch\`. Non-secret requests still use
// the captured native fetch (no 4 MiB hop).
export function __kodySecretRef(name, scope) {
	const trimmed = String(name ?? "").trim();
	if (!trimmed) {
		throw new Error("__kodySecretRef requires a non-empty secret name.");
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
		throw new Error(
			"__kodySecretRef name must use letters, numbers, dots, underscores, or hyphens.",
		);
	}
	if (scope == null) {
		return "{{" + "secret:" + trimmed + "}}";
	}
	if (scope === "package" || scope === "session" || scope === "user") {
		return "{{" + "secret:" + trimmed + "|scope=" + scope + "}}";
	}
	throw new Error(\`Unsupported secret scope "\${scope}".\`);
}

const __kodyParseSecretNameOrPlaceholder = (value, fieldName) => {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) {
		throw new Error(\`secretHeaders.basic requires \${fieldName}.\`);
	}
	if (trimmed.startsWith("{{") && trimmed.endsWith("}}")) {
		const match =
			/^\\{\\{secret:([a-zA-Z0-9._-]+)(?:\\|scope=(session|package|user))?\\}}$/.exec(
				trimmed,
			);
		if (!match) {
			throw new Error(
				\`\${fieldName} must be a saved secret name or a single {{secret:…}} opaque ref.\`,
			);
		}
		const scope = match[2];
		return {
			name: match[1],
			scope:
				scope === "package" || scope === "session" || scope === "user"
					? scope
					: null,
		};
	}
	if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
		throw new Error(
			\`\${fieldName} must be a saved secret name using letters, numbers, dots, underscores, or hyphens, or a single {{secret:…}} opaque ref.\`,
		);
	}
	return { name: trimmed, scope: null };
};
const __kodyNormalizeOptionalSecretScope = (scope) => {
	if (scope == null) return null;
	if (scope === "package" || scope === "session" || scope === "user") return scope;
	throw new Error(\`Unsupported secret scope "\${scope}".\`);
};
const __kodyResolveBasicAuthSecretScope = (input) => {
	const explicit = __kodyNormalizeOptionalSecretScope(input.explicitScope);
	if (explicit != null) return explicit;
	const usernameScope = input.usernameScope;
	const passwordScope = input.passwordScope;
	if (usernameScope == null) return passwordScope;
	if (passwordScope == null) return usernameScope;
	if (usernameScope !== passwordScope) {
		throw new Error(
			"usernameSecret and passwordSecret opaque refs disagree on scope. Pass scope explicitly or use matching refs.",
		);
	}
	return usernameScope;
};
export const secretHeaders = {
	basic(input) {
		const username = __kodyParseSecretNameOrPlaceholder(
			input?.usernameSecret,
			"usernameSecret",
		);
		const password = __kodyParseSecretNameOrPlaceholder(
			input?.passwordSecret,
			"passwordSecret",
		);
		const scope = __kodyResolveBasicAuthSecretScope({
			explicitScope: input?.scope,
			usernameScope: username.scope,
			passwordScope: password.scope,
		});
		return scope
			? \`{{secret-basic:username=\${username.name},password=\${password.name}|scope=\${scope}}}\`
			: \`{{secret-basic:username=\${username.name},password=\${password.name}}}\`;
	},
};

// Client-credentials grants need host-side secret expansion — hop through
// CapabilityProxy so long-lived secret values never enter local workerd.
export async function oauthClientCredentials(input) {
	return await kody.oauthClientCredentials(input ?? {});
}

export function __kodyCreatePackageBoundOauthClientCredentials(packageId) {
	const binding = __kodyPackageBinding(packageId);
	return async function oauthClientCredentials(input) {
		const { packageId: _ignored, ...rest } = input ?? {};
		return await kody.oauthClientCredentials({
			...rest,
			...(binding ? { packageId: binding } : {}),
		});
	};
}

// Scoped credential clients (ADR 0068) open and sign through CapabilityProxy
// \`kody.credentialClient*\`; their fetches carry only an opaque handle, which
// the fetch gateway on origin turns into the credential.
${createCredentialClientRuntimeSource()}
const __kodyCredentialRuntime = __kodyCreateCredentialRuntime((name, args) =>
	kody[name](args ?? {}),
);
export const credential = __kodyCredentialRuntime.credential;
export const credentials = __kodyCredentialRuntime.credentials;

export function __kodyCreatePackageBoundCredentialRuntime(packageId) {
	const binding = __kodyPackageBinding(packageId);
	return __kodyCreateCredentialRuntime((name, args) => {
		const { packageId: _ignored, ...rest } = args ?? {};
		return kody[name]({ ...rest, ...(binding ? { packageId: binding } : {}) });
	});
}

const __kodyNullBodyStatuses = new Set([204, 205, 304]);
const __kodyNativeFetch = globalThis.fetch.bind(globalThis);

// Blob bodies become ordinary byte streams once inside a Request, so the
// clone probe cannot tell them from string/bytes. Remember the Blob at
// construction so fetch(request) can scan blob.stream() and forward the
// same Blob without a tee/arrayBuffer copy (kody#3152).
const __kodyRequestBlobBodiesSymbol = Symbol.for(
	"kody.localExecuteRequestBlobBodies",
);
const __kodyRequestBlobBodies =
	globalThis[__kodyRequestBlobBodiesSymbol] ??
	(globalThis[__kodyRequestBlobBodiesSymbol] = new WeakMap());
const __kodyLocalExecuteRequestPatchedSymbol = Symbol.for(
	"kody.localExecuteRequestPatched",
);
const __kodyRequestBaseSymbol = Symbol.for("kody.localExecuteRequestBase");
// Prefer the pre-patch Request class for instanceof: after we subclass
// globalThis.Request, native/clone() Requests are not instances of the child.
/** @type {typeof Request} */
const __kodyRequestBase =
	globalThis[__kodyRequestBaseSymbol] ?? globalThis.Request;
if (!globalThis[__kodyLocalExecuteRequestPatchedSymbol]) {
	globalThis[__kodyRequestBaseSymbol] = __kodyRequestBase;
	globalThis.Request = class extends __kodyRequestBase {
		constructor(input, init) {
			super(input, init);
			if (
				typeof Blob !== "undefined" &&
				init?.body != null &&
				init.body instanceof Blob
			) {
				__kodyRequestBlobBodies.set(this, init.body);
			} else if (
				input instanceof __kodyRequestBase &&
				__kodyRequestBlobBodies.has(input) &&
				(init == null || init.body == null)
			) {
				__kodyRequestBlobBodies.set(
					this,
					__kodyRequestBlobBodies.get(input),
				);
			}
		}
		clone() {
			const cloned = super.clone();
			const blob = __kodyRequestBlobBodies.get(this);
			if (blob) __kodyRequestBlobBodies.set(cloned, blob);
			return cloned;
		}
	};
	globalThis[__kodyLocalExecuteRequestPatchedSymbol] = true;
}

function __kodyIsRequest(value) {
	return value instanceof __kodyRequestBase;
}

function __kodyTrackedRequestBlob(input, init) {
	if (typeof Blob === "undefined") return null;
	if (init?.body != null) {
		return init.body instanceof Blob ? init.body : null;
	}
	if (__kodyIsRequest(input)) {
		// A consumed Request must not re-upload a remembered Blob (#3152 review).
		if (input.bodyUsed) return null;
		return __kodyRequestBlobBodies.get(input) ?? null;
	}
	return null;
}

function __kodyBytesToBase64(bytes) {
	let binary = "";
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
	if (typeof body === "string") {
		return new TextEncoder().encode(body);
	}
	if (body instanceof Uint8Array) return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) {
		return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
	}
	if (typeof Blob !== "undefined" && body instanceof Blob) {
		return new Uint8Array(await body.arrayBuffer());
	}
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
		return new TextEncoder().encode(body.toString());
	}
	if (body && typeof body.getReader === "function") {
		return new Uint8Array(await new Response(body).arrayBuffer());
	}
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		throw new Error(
			"Local execute createAuthenticatedFetch does not support FormData bodies yet; use Uint8Array, Blob, or string.",
		);
	}
	throw new Error(
		"Local execute createAuthenticatedFetch could not serialize the request body.",
	);
}

export function __kodyCreatePackageBoundAuthenticatedFetch(packageId) {
	const binding = __kodyPackageBinding(packageId);
	return async function createAuthenticatedFetch(providerName) {
		return __kodyCreateAuthenticatedFetch(providerName, binding);
	};
}

export async function createAuthenticatedFetch(providerName) {
	return __kodyCreateAuthenticatedFetch(providerName, null);
}

async function __kodyCreateAuthenticatedFetch(providerName, packageBinding) {
	const name = String(providerName ?? "").trim();
	if (!name) {
		throw new Error("Integration name is required.");
	}
	return async (input, init) => {
		let url;
		let method = "GET";
		let headers = {};
		let bodyBytes = null;
		if (typeof input === "string" || input instanceof URL) {
			url = String(input);
			method = String(init?.method ?? "GET");
			headers = Object.fromEntries(new Headers(init?.headers).entries());
			if (init?.body != null) {
				bodyBytes = await __kodyBodyToBytes(init.body);
			}
		} else {
			// Match cloud createAuthenticatedFetch: new Request(input, init) so
			// init overrides method/headers/body when input is already a Request.
			const merged = new Request(input, init);
			url = merged.url;
			method = merged.method;
			headers = Object.fromEntries(merged.headers.entries());
			if (method !== "GET" && method !== "HEAD") {
				bodyBytes = new Uint8Array(await merged.arrayBuffer());
			}
		}
		const result = await kody.authenticatedFetch({
			providerName: name,
			...(packageBinding ? { packageId: packageBinding } : {}),
			request: {
				url,
				method,
				headers,
				...(bodyBytes != null
					? { bodyBase64: __kodyBytesToBase64(bodyBytes) }
					: {}),
			},
		});
		const bytes = __kodyBase64ToBytes(result.bodyBase64 ?? "");
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

/**
 * Secret-aware ambient fetch for local execute: hops through CapabilityProxy
 * \`kody.gatewayFetch\` when the request carries secret / integration-token
 * placeholders so expansion happens on origin via the same fetch gateway as
 * cloud execute. Non-secret requests use the captured native fetch (no 4 MiB
 * hop cap, no CapabilityProxy round-trip).
 *
 * Bound fetch sends the calling package's binding (never a bare id), so the
 * gateway sees that package's identity and nothing else (GHSA-5fv3-qv7j-rqf5).
 */
export function __kodyCreatePackageBoundGatewayFetch(packageId) {
	const binding = __kodyPackageBinding(packageId);
	return async function gatewayFetch(input, init) {
		return __kodyGatewayFetchCall(input, init, binding);
	};
}

export async function __kodyGatewayFetch(input, init) {
	return __kodyGatewayFetchCall(input, init, null);
}

function __kodyHasPlaceholderText(value) {
	if (typeof value !== "string" || !value.includes("{{")) return false;
	return (
		// Escape the scope pipe (| in generated source): bare | is regex
		// alternation and would miss {{secret:name|scope=user}} from
		// __kodySecretRef.
		/{{secret:[a-zA-Z0-9._-]+(?:\\|scope=(?:session|package|user))?}}/.test(
			value,
		) ||
		/{{secret-basic:[^}]+}}/.test(value) ||
		/{{integration-token:[a-zA-Z0-9._-]+}}/.test(value) ||
		/{{secret\\/[a-zA-Z0-9._-]+:[^}]+}}/.test(value)
	);
}

// Request.url percent-encodes braces in the path, and URLSearchParams encodes
// every placeholder character in the query, so decode before checking.
function __kodyRequestHasSecretPlaceholders(url, headers) {
	if (
		headers &&
		Object.keys(headers).some(
			(name) => name.toLowerCase() === ${JSON.stringify(credentialClientHeaderName)},
		)
	) {
		return true;
	}
	if (
		typeof url === "string" &&
		__kodyHasPlaceholderText(__kodyDecodePlaceholderPunctuation(url))
	) {
		return true;
	}
	for (const value of Object.values(headers ?? {})) {
		if (__kodyHasPlaceholderText(value)) return true;
	}
	return false;
}

function __kodyDecodePlaceholderPunctuation(text) {
	return text.replace(/%(7B|7D|3A|2F|3D|2C|7C)/gi, (_, hex) =>
		String.fromCharCode(Number.parseInt(hex, 16)),
	);
}

function __kodyIsVerbatimBodyMode(resolutionMode) {
	return resolutionMode === "off" || resolutionMode === "headers-only";
}

// The fetch gateway fills a placeholder in a text or multipart body, so a
// body that holds one hops through it. x-kody-secret-resolution: headers-only
// or off sends the body as written.
function __kodyBodyIsFillSite(headers, resolutionMode) {
	if (__kodyIsVerbatimBodyMode(resolutionMode)) return false;
	return true;
}

function __kodyIsMultipartType(contentType) {
	return (
		typeof contentType === "string" &&
		contentType.toLowerCase().startsWith("multipart/")
	);
}

// JSON CapabilityProxy hop cap (matches capabilityProxyAuthenticatedFetchMaxBodyBytes).
const __kodyGatewayFetchMaxBufferedBodyBytes = 4 * 1024 * 1024;

// A placeholder is short, so scanning overlapping windows finds one that
// straddles a chunk boundary without holding a large body as text.
const __kodyBodyScanOverlap = 8192;
const __kodyBodyScanChunkBytes = 64 * 1024;

function __kodyCreateBodyScanner() {
	let tail = "";
	return (bytes) => {
		const text = tail + __kodyBytesToAscii(bytes);
		tail = text.slice(-__kodyBodyScanOverlap);
		return __kodyHasPlaceholderText(__kodyDecodePlaceholderPunctuation(text));
	};
}

function __kodyBytesHoldPlaceholder(bytes) {
	const scan = __kodyCreateBodyScanner();
	for (
		let offset = 0;
		offset < bytes.byteLength;
		offset += __kodyBodyScanChunkBytes
	) {
		if (scan(bytes.subarray(offset, offset + __kodyBodyScanChunkBytes))) {
			return true;
		}
	}
	return false;
}

async function __kodyStreamHoldsPlaceholder(stream) {
	const reader = stream.getReader();
	const scan = __kodyCreateBodyScanner();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (scan(value instanceof Uint8Array ? value : new Uint8Array(value))) {
				return true;
			}
		}
	} finally {
		// A cloned body is a tee branch, and cancelling one branch settles only
		// after the other is cancelled too, so this must not be awaited.
		reader.cancel().catch(() => {});
	}
}

// Scans the caller's in-memory body where it is, so a large upload is not
// copied just to decide the hop.
async function __kodyBodyValueHoldsPlaceholder(body) {
	if (typeof body === "string") {
		return __kodyHasPlaceholderText(__kodyDecodePlaceholderPunctuation(body));
	}
	if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
		return __kodyHasPlaceholderText(
			__kodyDecodePlaceholderPunctuation(body.toString()),
		);
	}
	if (typeof Blob !== "undefined" && body instanceof Blob) {
		return await __kodyStreamHoldsPlaceholder(body.stream());
	}
	if (body instanceof ArrayBuffer) {
		return __kodyBytesHoldPlaceholder(new Uint8Array(body));
	}
	if (ArrayBuffer.isView(body)) {
		return __kodyBytesHoldPlaceholder(
			new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
		);
	}
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		// FormData is multipart; hop when resolution is on so parts fill.
		return true;
	}
	return false;
}

async function __kodyGatewayFetchStreamCall(input) {
	if (typeof kody.gatewayFetchStream !== "function") {
		throw __kodyStreamingHostMissingError();
	}
	return kody.gatewayFetchStream(input);
}

function __kodyReadFetchSignal(input, init) {
	return init?.signal ?? (__kodyIsRequest(input) ? input.signal : null);
}

function __kodyReadFetchRedirect(input, init) {
	return init?.redirect ?? (__kodyIsRequest(input) ? input.redirect : null);
}

function __kodyNativeStreamInit({ method, headers, body, input, init }) {
	const next = { method, headers };
	if (body != null) {
		next.body = body;
		next.duplex = "half";
	}
	const signal = __kodyReadFetchSignal(input, init);
	if (signal != null) next.signal = signal;
	const redirect = __kodyReadFetchRedirect(input, init);
	if (redirect != null) next.redirect = redirect;
	return next;
}

function __kodyNativeRequestOverlay({ input, init }) {
	const next = {};
	const signal = __kodyReadFetchSignal(input, init);
	if (signal != null) next.signal = signal;
	const redirect = __kodyReadFetchRedirect(input, init);
	if (redirect != null) next.redirect = redirect;
	return Object.keys(next).length > 0 ? next : undefined;
}

function __kodyGatewayStreamControlFields({ input, init }) {
	const next = {};
	const signal = __kodyReadFetchSignal(input, init);
	if (signal != null) next.signal = signal;
	const redirect = __kodyReadFetchRedirect(input, init);
	if (redirect != null) next.redirect = redirect;
	return next;
}

function __kodyIsCallerByteStream(body) {
	return Boolean(
		body &&
			typeof body.getReader === "function" &&
			!(typeof Blob !== "undefined" && body instanceof Blob) &&
			!(typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) &&
			!(typeof FormData !== "undefined" && body instanceof FormData),
	);
}

// String and bytes bodies inside a Request are byte streams. A caller
// ReadableStream is not, so BYOB acquisition fails. Probe before any read so
// the body stays usable. Blob-backed Requests are tracked separately.
function __kodyIsNonByteStream(body) {
	if (!body || typeof body.getReader !== "function") return false;
	let reader;
	try {
		reader = body.getReader({ mode: "byob" });
	} catch (error) {
		return error instanceof TypeError;
	}
	try {
		reader.releaseLock();
	} catch {
		// The body stays a byte stream either way.
	}
	return false;
}

function __kodyBytesToAscii(bytes) {
	return new TextDecoder("latin1").decode(bytes);
}

function __kodyStreamingHostMissingError() {
	return new Error(
		"Local execute needs kody.gatewayFetchStream on the host runtime to stream a secret-aware fetch body (multipart, large, or ReadableStream). Upgrade @kodycodes/cli, or buffer the body under 4 MiB for the JSON gatewayFetch hop.",
	);
}

const __kodySecretResolutionHeader = "x-kody-secret-resolution";

// init.headers replaces a Request's headers outright, matching new Request().
function __kodyReadSecretResolutionHeader(input, init) {
	if (init?.headers != null) {
		return new Headers(init.headers).get(__kodySecretResolutionHeader);
	}
	if (__kodyIsRequest(input)) {
		return input.headers.get(__kodySecretResolutionHeader);
	}
	return null;
}

function __kodyWithoutSecretResolutionHeader(headers) {
	const stripped = new Headers(headers);
	stripped.delete(__kodySecretResolutionHeader);
	return stripped;
}

async function __kodyGatewayFetchCall(input, init, packageBinding) {
	// The resolution mode instructs the fetch gateway. It is never sent to the
	// remote on a native fetch, and only the gateway hop carries it.
	const resolutionHeader = __kodyReadSecretResolutionHeader(input, init);
	const resolutionMode = String(resolutionHeader ?? "")
		.trim()
		.toLowerCase();
	if (resolutionHeader != null && init?.headers != null) {
		init = {
			...init,
			headers: __kodyWithoutSecretResolutionHeader(init.headers),
		};
	}
	let url;
	let method = "GET";
	let headers = {};
	let bodyBytes = null;
	let streamingBody = null;
	// True when the stream hop is required to fill (known placeholders / multipart).
	let streamingBodyNeedsFill = false;
	// Prefer ambient fetch(input, init) when nothing consumed the original
	// body - that keeps implicit Content-Type from string /
	// URLSearchParams / Blob that a reconstructed Uint8Array body would drop.
	let reuseOriginal = true;
	let preservedRequest = null;
	if (typeof input === "string" || input instanceof URL) {
		url = String(input);
		method = String(init?.method ?? "GET");
		headers = Object.fromEntries(new Headers(init?.headers).entries());
		if (init?.body != null) {
			const body = init.body;
			if (__kodyIsCallerByteStream(body)) {
				// Streamed bodies hop through gatewayFetchStream when resolution
				// fills the body (or URL/headers), matching hosted streaming fill.
				reuseOriginal = false;
				if (__kodyIsVerbatimBodyMode(resolutionMode)) {
					return __kodyNativeFetch(
						url,
						__kodyNativeStreamInit({
							method,
							headers,
							body,
							input,
							init,
						}),
					);
				}
				streamingBody = body;
				// Caller streams are opaque; the gateway hop fills when needed.
				streamingBodyNeedsFill = true;
			} else if (
				typeof Blob !== "undefined" &&
				body instanceof Blob &&
				typeof body.stream === "function" &&
				!__kodyIsVerbatimBodyMode(resolutionMode) &&
				(__kodyRequestHasSecretPlaceholders(url, headers) ||
					(await __kodyBodyValueHoldsPlaceholder(body)) ||
					__kodyIsMultipartType(
						new Headers(headers).get("content-type") ?? body.type,
					))
			) {
				// Prefer Blob.stream() over arrayBuffer so large Blobs stay streamed.
				const encoded = new Request(url, { method, headers, body });
				method = encoded.method;
				headers = Object.fromEntries(encoded.headers.entries());
				streamingBody = body.stream();
				streamingBodyNeedsFill = true;
				reuseOriginal = false;
			} else if (
				__kodyRequestHasSecretPlaceholders(url, headers) ||
				(__kodyBodyIsFillSite(headers, resolutionMode) &&
					(await __kodyBodyValueHoldsPlaceholder(body)))
			) {
				// The hop copy carries the implicit Content-Type (and multipart
				// boundary) of a string, URLSearchParams, or FormData body.
				// Keep the pre-Request url string so path {{secret:…}}
				// placeholders are not percent-encoded by Request.
				const encoded = new Request(url, { method, headers, body });
				method = encoded.method;
				headers = Object.fromEntries(encoded.headers.entries());
				bodyBytes = new Uint8Array(await encoded.arrayBuffer());
				reuseOriginal = false;
			}
		}
	} else {
		// Probe the caller's body before copying it into a new Request. That
		// copy drops BYOB, so a string body would look like a caller stream.
		const inputRequest = __kodyIsRequest(input) ? input : null;
		const requestStream =
			(init == null || init.body == null) &&
			inputRequest != null &&
			__kodyIsNonByteStream(inputRequest.body);
		const trackedBlob = __kodyTrackedRequestBlob(input, init);
		// A remembered Blob is scanned via blob.stream() and forwarded as the
		// same Blob — never clone().arrayBuffer() — so large uploads stay one
		// copy. String/bytes Requests keep the clone probe below (kody#3152).
		if (
			trackedBlob != null &&
			!requestStream &&
			!__kodyIsCallerByteStream(init?.body)
		) {
			const headerSource =
				init?.headers != null
					? init.headers
					: inputRequest != null
						? inputRequest.headers
						: undefined;
			url = inputRequest != null ? inputRequest.url : String(input);
			method = String(
				init?.method ?? (inputRequest != null ? inputRequest.method : "GET"),
			);
			let headerList = new Headers(headerSource);
			if (headerList.has(__kodySecretResolutionHeader)) {
				headerList = __kodyWithoutSecretResolutionHeader(headerList);
				reuseOriginal = false;
			}
			headers = Object.fromEntries(headerList.entries());
			if (method !== "GET" && method !== "HEAD") {
				const urlOrHeaderSecrets = __kodyRequestHasSecretPlaceholders(
					url,
					headers,
				);
				if (
					typeof trackedBlob.stream === "function" &&
					!__kodyIsVerbatimBodyMode(resolutionMode) &&
					(urlOrHeaderSecrets ||
						(await __kodyBodyValueHoldsPlaceholder(trackedBlob)) ||
						__kodyIsMultipartType(
							headerList.get("content-type") ?? trackedBlob.type,
						))
				) {
					const encoded = new Request(url, {
						method,
						headers,
						body: trackedBlob,
					});
					method = encoded.method;
					headers = Object.fromEntries(encoded.headers.entries());
					streamingBody = trackedBlob.stream();
					streamingBodyNeedsFill = true;
					reuseOriginal = false;
				} else if (urlOrHeaderSecrets) {
					// URL/header placeholders still need a gateway hop, but a
					// verbatim (or non-placeholder) Blob body must stay attached.
					streamingBody = trackedBlob.stream();
					streamingBodyNeedsFill = false;
					reuseOriginal = false;
				} else if (reuseOriginal) {
					return __kodyNativeFetch(input, init);
				} else {
					return __kodyNativeFetch(
						url,
						__kodyNativeStreamInit({
							method,
							headers,
							body: trackedBlob,
							input,
							init,
						}),
					);
				}
			} else if (reuseOriginal) {
				return __kodyNativeFetch(input, init);
			} else {
				preservedRequest = new Request(url, {
					method,
					headers,
					...(__kodyNativeRequestOverlay({ input, init }) ?? {}),
				});
			}
		} else {
			let merged = new Request(input, init);
			if (merged.headers.has(__kodySecretResolutionHeader)) {
				merged = new Request(merged, {
					headers: __kodyWithoutSecretResolutionHeader(merged.headers),
				});
				// The caller's Request still carries the header, so only the
				// stripped copy may be forwarded.
				reuseOriginal = false;
			}
			url = merged.url;
			method = merged.method;
			headers = Object.fromEntries(merged.headers.entries());
			if (method !== "GET" && method !== "HEAD" && merged.body) {
				if (__kodyIsCallerByteStream(init?.body) || requestStream) {
					if (__kodyIsVerbatimBodyMode(resolutionMode)) {
						return __kodyNativeFetch(
							merged,
							__kodyNativeRequestOverlay({ input, init }),
						);
					}
					streamingBody = merged.body;
					streamingBodyNeedsFill = true;
					reuseOriginal = false;
				} else {
					// String, bytes, and URLSearchParams become streams inside a
					// Request. A clone is scanned chunk by chunk to decide the hop,
					// and only a hop buffers the body. Otherwise the original Request
					// is forwarded so cache, credentials, and redirect replay stay
					// intact. Caller ReadableStream bodies are handled above.
					// Blob-backed Requests are handled via __kodyTrackedRequestBlob.
					if (
						__kodyRequestHasSecretPlaceholders(url, headers) ||
						(__kodyBodyIsFillSite(headers, resolutionMode) &&
							(await __kodyStreamHoldsPlaceholder(merged.clone().body)))
					) {
						bodyBytes = new Uint8Array(await merged.clone().arrayBuffer());
					}
					reuseOriginal = false;
					preservedRequest = merged;
				}
			} else {
				preservedRequest = merged;
			}
		}
	}
	const hopHeaders =
		resolutionHeader != null
			? { ...headers, [__kodySecretResolutionHeader]: resolutionHeader }
			: headers;
	if (streamingBody != null && !__kodyIsVerbatimBodyMode(resolutionMode)) {
		if (typeof kody.gatewayFetchStream === "function") {
			return __kodyGatewayFetchStreamCall({
				...(packageBinding ? { packageId: packageBinding } : {}),
				request: {
					url,
					method,
					headers: hopHeaders,
					body: streamingBody,
					...__kodyGatewayStreamControlFields({ input, init }),
				},
			});
		}
		// Older CLI: never forward a body that needs fill unfilled. Buffer to
		// classify — JSON hop under 4 MiB, otherwise require gatewayFetchStream.
		if (
			streamingBodyNeedsFill ||
			__kodyRequestHasSecretPlaceholders(url, headers)
		) {
			const buffered = new Uint8Array(
				await new Response(streamingBody).arrayBuffer(),
			);
			if (
				__kodyRequestHasSecretPlaceholders(url, headers) ||
				__kodyBytesHoldPlaceholder(buffered) ||
				__kodyIsMultipartType(headers["content-type"])
			) {
				if (buffered.byteLength > __kodyGatewayFetchMaxBufferedBodyBytes) {
					throw __kodyStreamingHostMissingError();
				}
				bodyBytes = buffered;
				streamingBody = null;
			} else {
				return __kodyNativeFetch(
					url,
					__kodyNativeStreamInit({
						method,
						headers,
						body: buffered,
						input,
						init,
					}),
				);
			}
		} else {
			return __kodyNativeFetch(
				url,
				__kodyNativeStreamInit({
					method,
					headers,
					body: streamingBody,
					input,
					init,
				}),
			);
		}
	}
	if (bodyBytes == null && !__kodyRequestHasSecretPlaceholders(url, headers)) {
		if (reuseOriginal) {
			return __kodyNativeFetch(input, init);
		}
		if (preservedRequest) {
			return __kodyNativeFetch(
				preservedRequest,
				__kodyNativeRequestOverlay({ input, init }),
			);
		}
		return __kodyNativeFetch(
			url,
			__kodyNativeStreamInit({
				method,
				headers,
				body: undefined,
				input,
				init,
			}),
		);
	}
	// Large buffered bodies use the streaming hop (no 4 MiB JSON cap).
	if (
		bodyBytes != null &&
		bodyBytes.byteLength > __kodyGatewayFetchMaxBufferedBodyBytes
	) {
		return __kodyGatewayFetchStreamCall({
			...(packageBinding ? { packageId: packageBinding } : {}),
			request: {
				url,
				method,
				headers: hopHeaders,
				body: bodyBytes,
				...__kodyGatewayStreamControlFields({ input, init }),
			},
		});
	}
	// Multipart always uses the streaming hop so part placeholders fill the
	// same way as hosted (and so we never base64 a multipart body).
	if (bodyBytes != null && __kodyIsMultipartType(headers["content-type"])) {
		return __kodyGatewayFetchStreamCall({
			...(packageBinding ? { packageId: packageBinding } : {}),
			request: {
				url,
				method,
				headers: hopHeaders,
				body: bodyBytes,
				...__kodyGatewayStreamControlFields({ input, init }),
			},
		});
	}
	const result = await kody.gatewayFetch({
		...(packageBinding ? { packageId: packageBinding } : {}),
		request: {
			url,
			method,
			headers: hopHeaders,
			...(bodyBytes != null
				? { bodyBase64: __kodyBytesToBase64(bodyBytes) }
				: {}),
		},
	});
	const bytes = __kodyBase64ToBytes(result.bodyBase64 ?? "");
	return new Response(
		__kodyNullBodyStatuses.has(result.status) ? null : bytes,
		{
			status: result.status,
			statusText: result.statusText,
			headers: result.headers,
		},
	);
}

export function __kodyCreatePackageBoundStorage(packageId) {
	// The binding (not the id) goes on the wire; origin maps it back to the
	// package after checking it was signed for this org and actor.
	const binding = __kodyPackageBinding(packageId) ?? "";
	return function packageStorage() {
		return {
			id: "package:" + encodeURIComponent(packageId),
			get: async (key) =>
				(await kody.packageStorageGet({ key, packageId: binding })).value,
			list: async (options = {}) =>
				await kody.packageStorageList({ ...options, packageId: binding }),
			sql: async (query, params = []) =>
				await kody.packageStorageSql({
					query,
					params,
					writable: true,
					packageId: binding,
				}),
			set: async (key, value) =>
				await kody.packageStorageSet({ key, value, packageId: binding }),
			delete: async (key) =>
				await kody.packageStorageDelete({ key, packageId: binding }),
			clear: async () =>
				await kody.packageStorageClear({ packageId: binding }),
		};
	};
}

// Same exports as the hosted per-package facade, so artifacts bundled against
// it run locally. Package-scoped calls carry this package's binding (any
// packageId the caller passes is replaced); every other call goes to the
// run's own host dispatcher unchanged.
const __kodyBindingScopedKodyCalls = new Set([
	"packageStorageGet",
	"packageStorageList",
	"packageStorageSql",
	"packageStorageSet",
	"packageStorageDelete",
	"packageStorageClear",
	"packageSecretGet",
	"packageSecretHas",
]);

export function __kodyCreatePackageBoundFetch(packageId) {
	const binding = __kodyPackageBinding(packageId);
	return function fetch(input, init) {
		return __kodyGatewayFetchCall(input, init, binding);
	};
}

// Captured before package code runs. The host \`kody\` is the CLI's path
// proxy: every property read (including \`.call\` / \`.apply\`) extends the
// runtime path, so \`fn.call(kody, args)\` would hop as \`kody.<name>.call\`
// and fail with "Unknown runtime function". Reflect.apply reaches the
// proxy's apply trap directly with the \`kody.<name>\` path.
const __kodyReflectApply = Reflect.apply;

export function __kodyCreatePackageBoundKody(packageId) {
	const binding = __kodyPackageBinding(packageId);
	return new Proxy(Object.create(null), {
		get(_target, property) {
			if (typeof property === "symbol" || property === "then") return undefined;
			if (property === "mcp" || property === "command") return kody[property];
			const name = String(property);
			return function (args) {
				const fn = kody[name];
				if (typeof fn !== "function") {
					throw new Error(
						\`kody:runtime export "kody.\${name}" is not callable in this execution context.\`,
					);
				}
				if (__kodyBindingScopedKodyCalls.has(name)) {
					const input = args && typeof args === "object" ? args : {};
					return __kodyReflectApply(fn, kody, [
						{ ...input, packageId: binding ?? "" },
					]);
				}
				return __kodyReflectApply(fn, kody, [args]);
			};
		},
	});
}

const __kodyLocalExecuteFetchPatchedSymbol = Symbol.for(
	"kody.localExecuteFetchPatched",
);
if (!globalThis[__kodyLocalExecuteFetchPatchedSymbol]) {
	globalThis.fetch = (input, init) => __kodyGatewayFetch(input, init);
	globalThis[__kodyLocalExecuteFetchPatchedSymbol] = true;
}

export function __kodyCreatePackageBoundSecrets(packageId) {
	const binding = __kodyPackageBinding(packageId);
	const call = async (method, alias) => {
		const normalizedAlias = typeof alias === "string" ? alias.trim() : "";
		if (!normalizedAlias) {
			throw new Error(\`packageSecrets.\${method} requires a non-empty alias.\`);
		}
		const args = {
			alias: normalizedAlias,
			...(binding ? { packageId: binding } : {}),
		};
		if (method === "get") {
			const result = await kody.packageSecretGet(args);
			return typeof result?.value === "string" ? result.value : "";
		}
		const result = await kody.packageSecretHas(args);
		return result?.has === true;
	};
	return {
		get: async (alias) => await call("get", alias),
		has: async (alias) => await call("has", alias),
	};
}

// Artifacts published before the shared runtime was externalized inline a
// full cloud runtime copy that looks up packageStorage / packageSecrets
// through the shared runtime store by package id. Hosted runs answer those
// lookups only as the run's own package (GHSA-5fv3-qv7j-rqf5), so local runs
// no longer add id-keyed factories to that store either: a lookup by id would
// let any module claim another package. Such copies get the inlined runtime's
// own "not available" error; republishing the package fixes them.

/**
 * Local counterpart of cloud \`__kodyMeterStaticPackageExport\`: metering only.
 * No secret authority is entered around the call (GHSA-5fv3). Nested package
 * identity for fetch/secrets comes from module-bound helpers, not ambient ALS.
 */
export function __kodyMeterStaticPackageExport(packageId, exportValue) {
	if (typeof exportValue !== "function") return exportValue;
	return exportValue;
}

export function packageStorage() {
	throw new Error(
		"packageStorage() requires package provenance: this module was not bundled from a saved package and the run has no package context. " +
			"Ad hoc execute has no scratch SQLite helper. Persist durable state from a saved package with packageStorage().",
	);
}

function __kodyPackageSecretsUnavailable() {
	throw new Error(
		"packageSecrets is not available in this execution context. It is bound for stamped saved-package modules and saved-package runtime contexts.",
	);
}

export const packageSecrets = {
	get: async () => __kodyPackageSecretsUnavailable(),
	has: async () => __kodyPackageSecretsUnavailable(),
};

const __kodyLocalRuntimeDefault = Object.freeze({
	...(__kodyHostRuntimeDefault && typeof __kodyHostRuntimeDefault === "object"
		? __kodyHostRuntimeDefault
		: {}),
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
export default __kodyLocalRuntimeDefault;
export const KodyRuntime = Object.freeze({
	defaultValue: __kodyLocalRuntimeDefault,
});
`.trim()
}

/**
 * Per-package virtual runtime for local execute: same surface as cloud's
 * createPackageRuntimeModuleSource, built from the same
 * `packageBoundRuntimeExports` list, so every export that reaches a
 * credential (createAuthenticatedFetch, oauthClientCredentials, credential,
 * packageSecrets, ...) closes over the stamped package id and CapabilityProxy
 * / fetch-gateway approvals see package identity.
 */
export function createLocalExecutePackageRuntimeModuleSource(
	packageId: string,
) {
	const baseRuntimeSpecifier = '../runtime.js'
	const boundNames = packageBoundRuntimeExportNames
	const sharedNames = Object.keys(sharedRuntimeExportReasons)
	return `
export { ${sharedNames.join(', ')} } from ${JSON.stringify(baseRuntimeSpecifier)};
import __kodyBaseRuntimeDefault, {
	${packageBoundRuntimeCreatorNames().join(',\n\t')},
} from ${JSON.stringify(baseRuntimeSpecifier)};
// Same lexical bindings as the hosted facade (GHSA-5fv3-qv7j-rqf5): stamped
// modules import \`fetch\` and \`kody\` from here, so they act as this package.
${createPackageBoundRuntimeExportLines(packageId)}
const __kodyPackageBound = { ${boundNames.join(', ')} };
// Local base runtime default is Object.freeze'd. Proxying that frozen target
// while returning different package-bound values violates Proxy invariants
// and throws on default-export property access. Clone with the bound
// overrides first.
const __kodyPackageRuntimeDefault = new Proxy(
	Object.freeze({
		...__kodyBaseRuntimeDefault,
		...__kodyPackageBound,
	}),
	{
		get(target, property, receiver) {
			if (Object.hasOwn(__kodyPackageBound, property)) return __kodyPackageBound[property];
			return Reflect.get(target, property, receiver);
		},
		has(target, property) {
			return Object.hasOwn(__kodyPackageBound, property) || Reflect.has(target, property);
		},
	},
);
export default __kodyPackageRuntimeDefault;
export const KodyRuntime = Object.freeze({ defaultValue: __kodyPackageRuntimeDefault });
`.trim()
}
