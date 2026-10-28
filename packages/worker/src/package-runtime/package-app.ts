import {
	isUnrepairablePreBindingArtifact,
	publishedArtifactNeedsPackageBindingRebuild,
} from './pre-binding-artifact-repair.ts'
import { type PublishedBundleArtifact } from './published-runtime-artifacts.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import {
	WorkerEntrypoint,
	exports as workerExports,
	waitUntil as scheduleWorkerWaitUntil,
} from 'cloudflare:workers'
import { requireLocalPackageAppRuntimeBridge } from '#worker/runtime-worker-service.ts'
import {
	packageAppRuntimeErrorHeader,
	packageAppRuntimeRunIdHeader,
} from '#worker/package-runtime/package-app-diagnostics.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { requestLineage } from '#worker/request-context/request-context.ts'
import {
	getPackageAppEntryPath,
	parseAuthoredPackageJson,
} from '#worker/package-registry/manifest.ts'
import {
	type AuthoredPackageJson,
	type PackageAppVisitorNeed,
} from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	buildKodyFns,
	collectPackageStorageGrantIds,
} from '#mcp/run-kody-registry.ts'
import { getCapabilityRegistryForContext } from '#mcp/capabilities/registry.ts'
import { listVisibleEnabledMcpServerRefsCached } from '#worker/mcp-client/settings-service.ts'
import { createAuthenticatedFetch } from '#mcp/execute-modules/kody-runtime-utils.ts'
import {
	buildKodyAppBundle,
	createPublishedPackageAppBundleCacheKey,
	hydrateKodyRuntimeModules,
} from './module-graph.ts'
import { runtimeModulePath } from './module-graph-paths.ts'
import { assertPublishedSourceCanRebuildWithoutInstallingDeps } from './published-source-dependencies.ts'
import {
	isPublishedBundleArtifactCurrentForCommit,
	loadPublishedBundleArtifactByIdentity,
	persistPublishedBundleArtifact,
} from './published-bundle-artifacts.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { getEntitySourceById } from '#worker/repo/entity-sources.ts'
import { timingSafeEqualString } from '@kody-internal/shared/timing-safe.ts'
import { type FetchGatewayProps } from '#mcp/fetch-gateway.ts'
import { buildPackageStorageId } from '#worker/storage-ids.ts'
import {
	assertStorageRunnerWriteWithinEntitlement,
	createPackageStorageAccessDeniedMessage,
	createPackageStorageOwnerOnlyMessage,
	createStorageBytesEntitlementRunCache,
	isReadOnlyStorageSqlQuery,
	storageRunnerRpc,
} from '#worker/storage-runner.ts'
import {
	assertWithinComputeInclude,
	estimateEntitlementStorageEntryByteDelta,
	estimateEntitlementStorageSqlWriteBytes,
} from '#worker/entitlements/service.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'
import { createDynamicWorkerCompatibilityOptions } from '#worker/dynamic-worker-compatibility.ts'
import { packageRealtimeSessionRpc } from './realtime-session.ts'
import { gatePackageAppUsage } from './package-app-usage-breaker.ts'
import {
	createDynamicCallableWorkflow,
	type PackageWorkflowCreateInput,
} from './package-workflows.ts'
import { isPackageSecretAccessUnavailableError } from '#mcp/secrets/package-access.ts'
import {
	createPackageSecretRefKey,
	issuePackageSecretRef,
} from '#mcp/secrets/package-secret-ref.ts'
import { buildSecretPlaceholder } from '#mcp/secrets/placeholders.ts'
import { attestedPackageStamp } from '#worker/credentials/package-stamp.ts'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { newRunCredentialClientBinding } from '#worker/credentials/credential-client-handle.ts'
import { loadRunCredentialNeeds } from '#worker/credentials/credential-client.ts'
import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import { type OwnerCredentialScope } from '#worker/credentials/owner-credential-for-visitors.ts'
import { type SavedCredentialNeed } from '#worker/credentials/credential-needs.ts'
import {
	createCredentialClientRuntimeSource,
	credentialClientToolNames,
} from '#worker/mcp/execute-modules/credential-client-source.ts'
import {
	createCredentialClientKodyTools,
	resolveCallerCredentialPackageId,
} from '#worker/mcp/credential-client-tools.ts'
import { type AdditionalKodyTools } from '#worker/mcp/runtime-helper-manifest.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	runWithCurrentSecretAuthority,
	runWithSecretAuthorityScope,
	secretAuthorityHeaderName,
	takeSecretAuthorityFromCapabilityArgs,
} from '#mcp/secrets/secret-authority.ts'
import {
	createExecutionSecretRedactor,
	type ExecutionSecretRedactor,
	trackRunSecretToolName,
	trackSecretValueForms,
} from '#mcp/secrets/execution-secret-redactor.ts'
import { pathSegmentEncodingWarningHeaderName } from '#mcp/secrets/path-segment-encoding-warning.ts'
import { beginRunRecord, finishRunRecord } from '#worker/run-records/service.ts'
import {
	type RunRecordHandle,
	type RunRecordLogInput,
	type RunTerminalStatus,
} from '#worker/run-records/types.ts'
import {
	buildPackageAppPath,
	buildPackageAppSubdomainPath,
	resolveHostedPackageAppUrl,
	type PackageAppMount,
} from '@kody-internal/shared/public-urls.ts'
import {
	getPackageAppBaseUrl,
	listPackageAppOrigins,
} from '#worker/app-base-url.ts'
import { createPackageAppSetCookieScrubHostSource } from '#worker/package-runtime/package-app-set-cookie.ts'
import { packageAppCookiePrefix } from '#worker/package-runtime/package-app-cookie-prefix.ts'
import { checkPackageAppRateLimit } from '#worker/package-runtime/package-app-rate-limit.ts'
import { packageAppSpendGet } from '#worker/package-runtime/package-app-spend.ts'
import { resolvePublicPackageAppLocation } from '#worker/package-app-public-url.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import {
	packageAppSyntheticHeaderName,
	packageAppSyntheticHeaderValue,
} from './package-app-synthetic.ts'
import { packageAppVisitorHeaderName } from './package-app-visitor-header.ts'
import {
	createPackageAppRequestVisit,
	packageAppVisitTicketHeaderName,
	type PackageAppRequestVisit,
	type PackageAppVisitAudience,
	type PackageAppVisitClaims,
	verifyPackageAppVisitTicket,
	withPackageAppVisitTicket,
} from './package-app-visit-ticket.ts'
import {
	createPackageAppCredentialAuthority,
	createPackageAppVisitorCredentialRequest,
	loadPackageAppRunsAs,
	packageAppRunsAsUnavailableMessages,
	packageAppIdentityCapabilityName,
	packageAppVisitorConsents,
	packageAppVisitorNeedCallName,
	PackageAppRunsAsUnavailableError,
	PackageAppVisitorConsentError,
	type PackageAppAuthorityMode,
	type PackageAppAuthorityScope,
	type PackageAppRunsAs,
	type PackageAppVisitorGrantScope,
} from './package-app-authority.ts'
import {
	PackageAppCapabilityNotDeclaredError,
	PackageAppCapabilityUnavailableError,
	packageAppAuthorityFallbackKindOf,
	packageAppAuthorityFallbackKindOfResult,
	schedulePackageAppAuthorityFallback,
	type PackageAppAuthorityDifferenceKind,
} from './package-app-authority-fallback.ts'
import { findLivePackageAppOauthGrant } from '#app/package-app-oauth-grants.ts'
import { scopesIncludeEmail } from '#app/package-app-oauth-scopes.ts'
import {
	buildPackageAppAssetBasePath,
	buildPackageAppClientModuleUrl,
	resolvePackageAppClientArtifact,
} from './package-app-assets.ts'
import { recordUniqueDynamicWorkerDay } from '#worker/usage/dynamic-worker-day.ts'
import { usageConnectionKey } from '#worker/usage/record-usage.ts'
import {
	createNullPackagesInvokeRewriteHostSource,
	modulesContainUnboundPackagesInvokeAccess,
} from './unbound-runtime-helpers.ts'
import { modulesReferenceKodyMcp } from './package-app-mcp-preload.ts'
import {
	createRandomPackageBindingToken,
	packageAppBindingTokenFor,
} from './package-app-binding-token.ts'

const packageAppEntrypointName = 'PackageAppWorker'
const packageAppRuntimeBindingName = 'KODY_RUNTIME'

function createPackageAppWorkerSource(input: {
	mainModule: string
	rewriteNullPackagesInvoke: boolean
	preloadMcpServerNames: boolean
	/** Package ids that get a trusted per-package binding (the run grant set). */
	packageBindingIds: Array<string>
	/** Per-build bridge capability; lives only in this module's private scope. */
	packageBindingToken: string
	/**
	 * Owning org slug. The shared worker reads `X-Kody-Visitor` per request
	 * for identity-only `metaGetCurrentUser` when there is no visit ticket.
	 * A ticket means the visitor acts as themselves and the bridge answers.
	 */
	identityOnlyOrgSlug: string | null
	/**
	 * Package-app apex hostnames (canonical + legacy). Used to strip Set-Cookie
	 * Domain attributes that would cover the shared apex or another tenant.
	 */
	packageAppApexHostnames: Array<string>
	packageAppCookiePrefix: string
}) {
	const mcpServerNamesExpr = input.preloadMcpServerNames
		? 'await runtimeBridge.listMcpServerNames().catch(() => [])'
		: '() => runtimeBridge.listMcpServerNames().catch(() => [])'
	return `
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { AsyncLocalStorage } from 'node:async_hooks';

const __kodyRuntimeStorageSymbol = Symbol.for('kody.runtimeStorage');
// Resolve the AsyncLocalStorage instance synchronously at module load,
// then publish it under the well-known symbol exactly once. The runtime
// virtual module reads the same symbol, so wrapper and user code are
// guaranteed to share the same ALS instance even when several requests
// race during cold start.
const __kodyRuntimeStorage = (() => {
	const globalAny = globalThis;
	const existing = globalAny[__kodyRuntimeStorageSymbol];
	if (existing) return existing;
	const created = new AsyncLocalStorage();
	globalAny[__kodyRuntimeStorageSymbol] = created;
	return created;
})();

// Do not statically import ${JSON.stringify(`./${runtimeModulePath}`)} at
// entry load. That virtual module freezes optional exports (credential, …)
// from __kodyInitialRuntime at first evaluation — before any
// __kodyRuntimeStorage.run — so credential stayed undefined forever after
// createRuntime bound it (#3886). Instead preload runtime inside ALS.run
// (before the user module) so optional exports see the bound store.
const __kodyRuntimeModuleSpecifier = ${JSON.stringify(`./${runtimeModulePath}`)};
let __kodyRunWithPackageBindingsFn = null;
async function __kodyEnsureRuntimeLoaded() {
	if (typeof __kodyRunWithPackageBindingsFn === 'function') return;
	const runtimeModule = await import(__kodyRuntimeModuleSpecifier);
	__kodyRunWithPackageBindingsFn = runtimeModule.__kodyRunWithPackageBindings;
}

// Trusted per-package bindings (GHSA-5fv3). Package identity is never a
// header, argument, or ambient value package code can set: each binding
// calls the runtime bridge with a per-build capability that lives only in
// this module's private scope, and the host binds the package id it was
// given here to the bridge / gateway call. The bindings are handed only to
// the runtime module's private scope. Intrinsics are captured at module
// load, before any package code has run in this isolate.
const __kodyReflectApplyCaptured = Reflect.apply;
const __kodyMapCaptured = Map;
const __kodyMapSetCaptured = Map.prototype.set;
const __kodyObjectFreezeCaptured = Object.freeze;
const __kodyRequestCaptured = Request;
const __kodyStringTrimCaptured = String.prototype.trim;
const __kodyPackageBindingToken = ${JSON.stringify(input.packageBindingToken)};
const __kodyPackageBindingIds = __kodyObjectFreezeCaptured(${JSON.stringify(input.packageBindingIds)});
const __kodyIdentityOnlyOrgSlug = ${JSON.stringify(input.identityOnlyOrgSlug)};
const __kodyJsonParseCaptured = JSON.parse;
const __kodyVisitTicketHeaderName = ${JSON.stringify(packageAppVisitTicketHeaderName)};
const __kodyVisitStorage = new AsyncLocalStorage();

function __kodyCurrentVisitTicket() {
	try {
		return __kodyVisitStorage.getStore()?.ticket ?? null;
	} catch {
		return null;
	}
}
function __kodyReadVisitTicket(request) {
	try {
		const ticket = request?.headers?.get(__kodyVisitTicketHeaderName);
		return typeof ticket === 'string' && ticket ? ticket : null;
	} catch {
		return null;
	}
}

// An anonymous build serves signed-in people who cannot run the app as
// anonymous visitors. The platform names them in ${packageAppVisitorHeaderName}
// (inbound X-Kody-* headers are stripped before it is set), so
// metaGetCurrentUser can say who is visiting. That answer is the only thing
// the header changes: it grants no storage, credentials, or capability.
// A visit ticket means the visitor acts as themselves; skip this shortcut.
function __kodyReadIdentityOnlyVisitor(request) {
	if (__kodyIdentityOnlyOrgSlug === null) return null;
	let raw = null;
	try {
		raw = request?.headers?.get(${JSON.stringify(packageAppVisitorHeaderName)}) ?? null;
	} catch {
		return null;
	}
	if (!raw) return null;
	try {
		const parsed = __kodyJsonParseCaptured(raw);
		if (
			!parsed ||
			typeof parsed.userId !== 'string' ||
			!parsed.userId ||
			typeof parsed.username !== 'string'
		) {
			return null;
		}
		return __kodyObjectFreezeCaptured({
			user_id: parsed.userId,
			username: parsed.username,
			email: '',
			display_name: parsed.username,
			org: __kodyObjectFreezeCaptured({ slug: __kodyIdentityOnlyOrgSlug }),
			scopes: Array.isArray(parsed.scopes)
				? parsed.scopes.filter((scope) => typeof scope === 'string')
				: [],
		});
	} catch {
		return null;
	}
}
function hasScope(request, scope) {
	if (typeof scope !== 'string') return false;
	try {
		const raw = request?.headers?.get(
			${JSON.stringify(packageAppVisitorHeaderName)},
		);
		if (!raw) return false;
		const visitor = __kodyJsonParseCaptured(raw);
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
function __kodyIdentityOnlyAnswer(identity, name) {
	if (!identity || name !== 'metaGetCurrentUser') return null;
	return {
		user_id: identity.user_id,
		username: identity.username,
		email: identity.email,
		display_name: identity.display_name,
		org: { slug: identity.org.slug },
		scopes: identity.scopes,
	};
}
let __kodyCapturedRuntimeBridge = null;
function __kodyCaptureRuntimeBridge(env) {
	// First capture happens on the first request, before the user module is
	// imported, so later package code cannot swap the binding it calls.
	if (__kodyCapturedRuntimeBridge == null) {
		__kodyCapturedRuntimeBridge = env.${packageAppRuntimeBindingName};
	}
	return __kodyCapturedRuntimeBridge;
}
function __kodyCreateAppPackageBindings(bridge, identity) {
	const map = new __kodyMapCaptured();
	for (let index = 0; index < __kodyPackageBindingIds.length; index += 1) {
		const packageId = __kodyPackageBindingIds[index];
		const token = __kodyPackageBindingToken;
		const boundCapability = async (callInput) => {
			const visitTicket = __kodyCurrentVisitTicket();
			const identityAnswer = visitTicket
				? null
				: __kodyIdentityOnlyAnswer(identity, callInput?.name);
			if (identityAnswer) return identityAnswer;
			return await bridge.packageBoundCall({
				token,
				packageId,
				op: 'capability',
				name: callInput?.name,
				args: callInput?.args ?? {},
				visitTicket,
			});
		};
		let mcp = null;
		const binding = __kodyObjectFreezeCaptured({
			// Package-locked MCP servers check the caller's package, so this
			// package's kody.mcp goes through its own binding too.
			kodyMcp: () => {
				if (mcp == null) {
					mcp = createKodyProxy(
						{ callCapability: boundCapability },
						() => bridge.listMcpServerNames().catch(() => []),
					).mcp;
				}
				return mcp;
			},
			fetch: async (requestInput, init) =>
				await bridge.packageBoundFetch(
					token,
					packageId,
					new __kodyRequestCaptured(requestInput, init),
					__kodyCurrentVisitTicket(),
				),
			kodyCall: async (name, args) => await boundCapability({ name, args }),
			// credential() for this package only (GHSA-5fv3).
			credentialCall: async (name, args) =>
				await bridge.packageBoundCall({
					token,
					packageId,
					op: 'credentialClient',
					name,
					args: args ?? {},
					visitTicket: __kodyCurrentVisitTicket(),
				}),
			// packageStorage() for this package only (GHSA-5fv3).
			packageStorageCall: async (method, args) =>
				await bridge.packageBoundCall({
					token,
					packageId,
					op: 'packageStorage',
					name: method,
					args: args ?? {},
					visitTicket: __kodyCurrentVisitTicket(),
				}),
			packageSecretGet: async (alias) => {
				const result = await bridge.packageBoundCall({
					token,
					packageId,
					op: 'packageSecretGet',
					alias,
					visitTicket: __kodyCurrentVisitTicket(),
				});
				return typeof result?.value === 'string' ? result.value : '';
			},
			packageSecretHas: async (alias) => {
				const result = await bridge.packageBoundCall({
					token,
					packageId,
					op: 'packageSecretHas',
					alias,
					visitTicket: __kodyCurrentVisitTicket(),
				});
				return result?.has === true;
			},
		});
		__kodyReflectApplyCaptured(__kodyMapSetCaptured, map, [packageId, binding]);
	}
	return map;
}
async function __kodyRunUserCode(env, callback, identity = null) {
	await __kodyEnsureRuntimeLoaded();
	const bindings = __kodyCreateAppPackageBindings(__kodyCaptureRuntimeBridge(env), identity);
	if (typeof __kodyRunWithPackageBindingsFn !== 'function') {
		return await callback();
	}
	return await __kodyRunWithPackageBindingsFn(bindings, callback);
}

const __kodyEvaluateFetchPatchedSymbol = Symbol.for('kody.evaluateFetchPatched');
if (!globalThis[__kodyEvaluateFetchPatchedSymbol]) {
	const __kodyNativeFetch = globalThis.fetch.bind(globalThis);
	globalThis.fetch = (input, init) => {
		const headers = new Headers(
			init?.headers ??
				(input && typeof input === 'object' && 'headers' in input
					? input.headers
					: undefined),
		);
		// Identity never rides on a header (GHSA-5fv3); strip any forgery.
		headers.delete(${JSON.stringify(secretAuthorityHeaderName)});
		headers.delete(__kodyVisitTicketHeaderName);
		const visitTicket = __kodyCurrentVisitTicket();
		if (visitTicket) headers.set(__kodyVisitTicketHeaderName, visitTicket);
		// Leave x-kody-credential-client alone: globalOutbound KodyFetchGateway
		// matches it against the run binding on its props and places the
		// credential. Stripping it would send an unauthenticated upstream
		// request; throwing would block legitimate credential().fetch.
		return __kodyNativeFetch(input, { ...init, headers }).then((response) => {
			const warning = response.headers.get(
				${JSON.stringify(pathSegmentEncodingWarningHeaderName)},
			);
			if (warning) console.warn(warning);
			return response;
		});
	};
	globalThis[__kodyEvaluateFetchPatchedSymbol] = true;
}

function buildFacetName(rawFacetName) {
	return typeof rawFacetName === 'string' && rawFacetName.trim().length > 0
		? rawFacetName.trim()
		: 'main';
}

function fnv1a32(input) {
	let hash = 2166136261;
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function buildFacetClassExportName(rawFacetName) {
	const canonicalName = buildFacetName(rawFacetName);
	const sanitizedFacetName = canonicalName.replace(/[^a-zA-Z0-9_]/g, '_');
	const hashSuffix = fnv1a32(canonicalName).toString(16).padStart(8, '0');
	return canonicalName === 'main'
		? 'App'
		: \`App_\${sanitizedFacetName}_\${hashSuffix}\`;
}

function createKodyProxy(runtimeBridge, mcpServerNamesOrLoader, identity = null) {
	const isProxyLookupKey = (name) =>
		typeof name !== 'string' || name === 'then';
	const createOpenNamespaceProxy = (getValue) =>
		new Proxy({}, {
			get(_target, name) {
				if (isProxyLookupKey(name)) return undefined;
				return getValue(name);
			},
			has(_target, name) {
				return !isProxyLookupKey(name);
			},
			getOwnPropertyDescriptor(_target, name) {
				if (isProxyLookupKey(name)) return undefined;
				return {
					configurable: true,
					enumerable: true,
					writable: true,
					value: getValue(name),
				};
			},
		});
	// Workerd destructures \`const { home } = kody.mcp\` via ownKeys then
	// GOPD. Advertise connected server names so home is not undefined.
	// Empty/missing names stay open (GOPD still returns getValue) so a
	// listing failure does not hide Get. Only a non-empty list restricts
	// has/GOPD. Tool namespaces stay fully open.
	//
	// Entrypoints that statically reference kody.mcp preload names before
	// author code runs (array argument). Hello-world / non-MCP apps pass a
	// loader instead so listMcpServerNames runs only on first kody.mcp touch.
	const mcpNamesState = { known: [], restrict: false };
	let mcpNamesLoadPromise = null;
	const applyMcpServerNames = (names) => {
		mcpNamesState.known = [
			...new Set(
				(Array.isArray(names) ? names : []).filter(
					(name) => typeof name === 'string' && name.length > 0,
				),
			),
		];
		mcpNamesState.restrict = mcpNamesState.known.length > 0;
		return mcpNamesState.known;
	};
	const ensureMcpServerNames = () => {
		if (mcpNamesLoadPromise) return mcpNamesLoadPromise;
		if (Array.isArray(mcpServerNamesOrLoader)) {
			applyMcpServerNames(mcpServerNamesOrLoader);
			mcpNamesLoadPromise = Promise.resolve(mcpNamesState.known);
			return mcpNamesLoadPromise;
		}
		const loader =
			typeof mcpServerNamesOrLoader === 'function'
				? mcpServerNamesOrLoader
				: async () => [];
		mcpNamesLoadPromise = Promise.resolve()
			.then(() => loader())
			.then((names) => applyMcpServerNames(names))
			.catch(() => applyMcpServerNames([]));
		return mcpNamesLoadPromise;
	};
	if (Array.isArray(mcpServerNamesOrLoader)) {
		ensureMcpServerNames();
	}
	const createMcpServerNamespaceProxy = (getValue) =>
		new Proxy({}, {
			get(_target, name) {
				if (isProxyLookupKey(name)) return undefined;
				void ensureMcpServerNames();
				return getValue(name);
			},
			has(_target, name) {
				if (isProxyLookupKey(name)) return false;
				if (!mcpNamesState.restrict) return true;
				return mcpNamesState.known.includes(name);
			},
			ownKeys() {
				return [...mcpNamesState.known];
			},
			getOwnPropertyDescriptor(_target, name) {
				if (isProxyLookupKey(name)) return undefined;
				if (mcpNamesState.restrict && !mcpNamesState.known.includes(name)) {
					return undefined;
				}
				return {
					configurable: true,
					enumerable: true,
					writable: true,
					value: getValue(name),
				};
			},
		});
	const mcp = createMcpServerNamespaceProxy((serverName) =>
		createOpenNamespaceProxy((toolName) => async (args = {}) =>
			await runtimeBridge.callCapability({
				name: \`mcp:\${serverName}:\${toolName}\`,
				args,
				visitTicket: __kodyCurrentVisitTicket(),
			}),
		),
	);
	const touchMcp = () => {
		void ensureMcpServerNames();
		return mcp;
	};
	return new Proxy({}, {
		get(_target, property) {
			if (typeof property !== 'string' || property === 'then') return undefined;
			if (property === 'mcp') return touchMcp();
			if (property.startsWith('mcp:')) {
				throw new Error(
					\`MCP server tool "\${property}" is not available as a flat kody function. Use kody.mcp[serverName].toolName(input) instead.\`,
				);
			}
			if (property === 'appRateLimit') {
				return async (args = {}) => await runtimeBridge.appRateLimit(args);
			}
			if (property === 'appSpendGet') {
				return async () => await runtimeBridge.appSpendGet();
			}
			return async (args = {}) => {
				const visitTicket = __kodyCurrentVisitTicket();
				const identityAnswer = visitTicket
					? null
					: __kodyIdentityOnlyAnswer(identity, property);
				if (identityAnswer) return identityAnswer;
				return await runtimeBridge.callCapability({
					name: property,
					args,
					visitTicket,
				});
			};
		},
		has(_target, property) {
			return property === 'mcp';
		},
		ownKeys() {
			return ['mcp'];
		},
		getOwnPropertyDescriptor(_target, property) {
			if (property !== 'mcp') return undefined;
			return {
				configurable: true,
				enumerable: true,
				writable: true,
				value: touchMcp(),
			};
		},
	});
}

function createRealtimeProxy(runtimeBridge) {
	return {
		emit: async (sessionId, data) =>
			await runtimeBridge.realtimeEmit({
				sessionId,
				data,
			}),
		broadcast: async (input = {}) =>
			await runtimeBridge.realtimeBroadcast({
				data: input.data,
				topic: input.topic,
				facet: input.facet,
			}),
		listSessions: async (input = {}) =>
			await runtimeBridge.realtimeListSessions({
				topic: input.topic,
				facet: input.facet,
			}),
		disconnect: async (sessionId, input = {}) =>
			await runtimeBridge.realtimeDisconnect({
				sessionId,
				code: input.code,
				reason: input.reason,
			}),
	};
}

function createPackageSecretsProxy(runtimeBridge) {
	// Run-identity secrets only; package-bound secrets go through the
	// trusted per-package binding. Alias trimmed with a captured intrinsic.
	const secretArgs = (alias) => ({
		alias,
		visitTicket: __kodyCurrentVisitTicket(),
	});
	return {
		get: async (alias) => {
			const normalizedAlias =
				typeof alias === 'string' ? __kodyReflectApplyCaptured(__kodyStringTrimCaptured, alias, []) : ''
			if (!normalizedAlias) {
				throw new Error('packageSecrets.get requires a non-empty alias.')
			}
			const result = await runtimeBridge.packageSecretGet(
				secretArgs(normalizedAlias),
			)
			if (typeof result?.value !== 'string') {
				throw new Error(
					'packageSecretGet returned invalid response for alias "' +
						normalizedAlias +
						'".',
				)
			}
			return result.value
		},
		has: async (alias) => {
			const normalizedAlias =
				typeof alias === 'string' ? __kodyReflectApplyCaptured(__kodyStringTrimCaptured, alias, []) : ''
			if (!normalizedAlias) {
				throw new Error('packageSecrets.has requires a non-empty alias.')
			}
			const result = await runtimeBridge.packageSecretHas(
				secretArgs(normalizedAlias),
			)
			if (typeof result?.has !== 'boolean') {
				throw new Error(
					'packageSecretHas returned invalid response for alias "' +
						normalizedAlias +
						'".',
				)
			}
			return result.has
		},
	};
}

function createWorkflowsProxy(runtimeBridge) {
	const isoRunAtPattern =
		/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?(?:Z|[+-]\\d{2}:\\d{2})$/;
	const normalizeOptionalString = (input, fieldName) => {
		const value = input?.[fieldName];
		return typeof value === 'string' && value.trim() ? value : null;
	};
	const normalizeRunAt = (input) => {
		const value = input?.runAt;
		if (value === undefined || value === null || value === '') {
			return null;
		}
		const date =
			value instanceof Date
				? value
				: typeof value === 'string'
					? isoRunAtPattern.test(value)
						? new Date(value)
						: null
					: null;
		if (!date || Number.isNaN(date.getTime())) {
			throw new Error(
				'workflows.create requires a valid runAt ISO-8601 date-time string or Date.',
			);
		}
		return date;
	};
	return {
		create: async (input) => {
			if (!input || typeof input !== 'object' || Array.isArray(input)) {
				throw new Error('workflows.create requires a workflow input object.');
			}
			const exportName = normalizeOptionalString(input, 'exportName');
			const code = normalizeOptionalString(input, 'code');
			if ((exportName ? 1 : 0) + (code ? 1 : 0) !== 1) {
				throw new Error('workflows.create requires exactly one of exportName or code.');
			}
			const workflowName = normalizeOptionalString(input, 'workflowName');
			const packageId = normalizeOptionalString(input, 'packageId');
			const runAt = normalizeRunAt(input);
			const idempotencyKey = normalizeOptionalString(input, 'idempotencyKey');
			const payload = {
				...(runAt ? { runAt } : {}),
				...(idempotencyKey ? { idempotencyKey } : {}),
				...(input.params === undefined ? {} : { params: input.params }),
				...(workflowName ? { workflowName } : {}),
				...(packageId ? { packageId } : {}),
				...(exportName ? { exportName } : {}),
				...(code ? { code } : {}),
			};
			return await runtimeBridge.workflowCreate(
				payload,
				__kodyCurrentVisitTicket(),
			);
		},
	};
}

function createEventsProxy(runtimeBridge) {
	return {
		dispatch: async (input) =>
			await runtimeBridge.packageEventDispatch(
				input ?? {},
				__kodyCurrentVisitTicket(),
			),
	};
}

function createAuthenticatedFetchHelper(runtimeBridge) {
	return async function createAuthenticatedFetch(providerName) {
		return async (input, init) =>
			await runtimeBridge.authenticatedFetch({
				providerName,
				visitTicket: __kodyCurrentVisitTicket(),
				request: {
					url:
						typeof input === 'string'
							? input
							: input instanceof URL
								? input.toString()
								: input.url,
					method:
						input instanceof Request
							? input.method
							: init?.method ?? 'GET',
					headers: Object.fromEntries(
						new Headers(input instanceof Request ? input.headers : init?.headers).entries(),
					),
					body:
						input instanceof Request
							? await input.text()
							: typeof init?.body === 'string'
								? init.body
								: undefined,
				},
			});
	}
}

function createInternalDurableObjectState(runtimeBridge, storageId) {
	const listToMap = async (options = {}) => {
		const result = await runtimeBridge.storageList({
			storageId,
			...options,
		});
		return new Map((result?.entries ?? []).map((entry) => [entry.key, entry.value]));
	};
	return {
		id: {
			toString() {
				return storageId;
			},
		},
		blockConcurrencyWhile: async (fn) => await fn(),
		waitUntil() {},
		storage: {
			get: async (key) =>
				(await runtimeBridge.storageGet({
					storageId,
					key,
				})).value,
			put: async (key, value) =>
				await runtimeBridge.storageSet({
					storageId,
					key,
					value,
				}),
			delete: async (key) =>
				await runtimeBridge.storageDelete({
					storageId,
					key,
				}),
			deleteAll: async () =>
				await runtimeBridge.storageClear({
					storageId,
				}),
			list: async (options = {}) => await listToMap(options),
			sql: {
				databaseSize: 0,
			},
		},
	};
}

function createDurableObjectNamespace(runtimeBridge, runtimeEnv, packageId, exportName, ExportedClass) {
	return {
		idFromName(name) {
			return \`\${packageId}:\${exportName}:\${String(name)}\`;
		},
		get(id) {
			const storageId = String(id);
			return {
				fetch: async (request) => {
					const state = createInternalDurableObjectState(runtimeBridge, storageId);
					// Package-internal Durable Objects are an implementation detail.
					// Build an instance shape with the fields user code typically reads
					// (\`ctx\` and \`env\`) without requiring a native DurableObjectState.
					const instance = Object.create(ExportedClass.prototype);
					instance.ctx = state;
					instance.env = runtimeEnv;
					if (typeof instance.fetch !== 'function') {
						throw new Error(\`Package Durable Object "\${exportName}" must implement fetch().\`);
					}
					return await instance.fetch(request);
				},
			};
		},
	};
}

function createPackageAppEnv(env, userModule) {
	const runtimeBridge = env.${packageAppRuntimeBindingName};
	const packageContext = env.__kodyPackageContext ?? null;
	const packageId = packageContext?.packageId ?? '';
	const runtimeEnv = Object.create(env);
	for (const [exportName, exported] of Object.entries(userModule)) {
		if (exportName !== 'default' && typeof exported === 'function') {
			const namespace = createDurableObjectNamespace(
				runtimeBridge,
				runtimeEnv,
				packageId,
				exportName,
				exported,
			);
			runtimeEnv[exportName] = namespace;
			runtimeEnv[exportName.toUpperCase()] = namespace;
		}
	}
	return runtimeEnv;
}

${createCredentialClientRuntimeSource()}

// \`call\` is a package's trusted binding call (GHSA-5fv3). Without one the
// public bridge acts as the app package, so no package id is sent.
function createCredentialRuntime(runtimeBridge, call) {
	return __kodyCreateCredentialRuntime((name, args) =>
		typeof call === 'function'
			? call(name, args ?? {})
			: runtimeBridge.credentialClientCall({
				name,
				args: args ?? {},
				visitTicket: __kodyCurrentVisitTicket(),
			}),
	);
}

function createRuntime(runtimeBridge, packageContext, mcpServerNamesOrLoader, identity = null) {
	const packageId = packageContext?.packageId ?? '';
	const packageSecrets =
		packageId.length > 0
			? createPackageSecretsProxy(runtimeBridge, packageId)
			: {
					get: async () => {
						throw new Error(
							'packageSecrets.get requires a package runtime context.',
						)
					},
					has: async () => {
						throw new Error(
							'packageSecrets.has requires a package runtime context.',
						)
					},
				}
	const credentialRuntime = createCredentialRuntime(runtimeBridge);
	return {
		kody: createKodyProxy(runtimeBridge, mcpServerNamesOrLoader, identity),
		hasScope,
		hasVisitorCredential: (request, key) =>
			typeof key === 'string' && hasScope(request, \`need:\${key}\`),
		storage: undefined,
		__kodyPackageSecrets: (secretsPackageId) =>
			createPackageSecretsProxy(runtimeBridge, secretsPackageId),
		__kodyPackageStorage: (storagePackageId) => ({
			id: 'package:' + encodeURIComponent(storagePackageId),
			get: async (key) =>
				(
					await runtimeBridge.packageStorageGet({
						packageId: storagePackageId,
						key,
					})
				).value,
			list: async (options = {}) =>
				await runtimeBridge.packageStorageList({
					...options,
					packageId: storagePackageId,
				}),
			sql: async (query, params = []) =>
				await runtimeBridge.packageStorageSql({
					packageId: storagePackageId,
					query,
					params,
					writable: true,
				}),
			set: async (key, value) =>
				await runtimeBridge.packageStorageSet({
					packageId: storagePackageId,
					key,
					value,
				}),
			delete: async (key) =>
				await runtimeBridge.packageStorageDelete({
					packageId: storagePackageId,
					key,
				}),
			clear: async () =>
				await runtimeBridge.packageStorageClear({
					packageId: storagePackageId,
				}),
		}),
		createAuthenticatedFetch: createAuthenticatedFetchHelper(runtimeBridge),
		realtime: createRealtimeProxy(runtimeBridge),
		packageSecrets,
		credential: credentialRuntime.credential,
		credentials: credentialRuntime.credentials,
		__kodyCredentialRuntimeFor: (_boundPackageId, call) =>
			createCredentialRuntime(runtimeBridge, call),
		workflows: createWorkflowsProxy(runtimeBridge),
		packages: null,
		events: createEventsProxy(runtimeBridge),
		packageContext,
	};
}

function createFacetStorageId(packageContext, facetName) {
	const packageId = packageContext?.packageId ?? 'package';
	return \`\${packageId}:facet:\${buildFacetName(facetName)}\`;
}

function serializeRuntimeError(error) {
	return {
		name: error && typeof error.name === 'string' ? error.name : 'Error',
		message:
			error && typeof error.message === 'string'
				? error.message
				: String(error),
	};
}

${createNullPackagesInvokeRewriteHostSource({
	enabled: input.rewriteNullPackagesInvoke,
})}
${createPackageAppSetCookieScrubHostSource({
	packageAppApexHostnames: input.packageAppApexHostnames,
	cookiePrefix: input.packageAppCookiePrefix,
})}

function createConsoleLogCapture() {
	const logs = [];
	const previousConsole = globalThis.console;
	const push = (level, args) => {
		logs.push({
			level,
			message: args.map((value) => String(value)).join(' '),
		});
	};
	const captureConsole = {
		...previousConsole,
		debug: (...args) => {
			push('debug', args);
			previousConsole.debug(...args);
		},
		info: (...args) => {
			push('info', args);
			previousConsole.info(...args);
		},
		log: (...args) => {
			push('log', args);
			previousConsole.log(...args);
		},
		warn: (...args) => {
			push('warn', args);
			previousConsole.warn(...args);
		},
		error: (...args) => {
			push('error', args);
			previousConsole.error(...args);
		},
	};
	return {
		logs,
		install() {
			globalThis.console = captureConsole;
		},
		restore() {
			globalThis.console = previousConsole;
		},
	};
}

function collectQueryParamNames(url) {
	return [...new Set(url.searchParams.keys())];
}

function isSyntheticPackageAppRequest(request) {
	return request.headers.get(${JSON.stringify(packageAppSyntheticHeaderName)}) === ${JSON.stringify(packageAppSyntheticHeaderValue)};
}

async function startRuntimeRun(runtimeBridge, input) {
	try {
		return await runtimeBridge.packageRuntimeRunStart(input);
	} catch (error) {
		console.warn('package-app-run-record-start-failed', error);
		return null;
	}
}

function finishRuntimeRun(runtimeBridge, executionCtx, input) {
	// Begin is a WorkerEntrypoint RPC even though beginRunRecord itself is
	// synchronous. Await it only inside waitUntil, chained before finish, so
	// the HTTP/realtime response is not blocked on minting the handle.
	executionCtx.waitUntil(
		(async () => {
			const run = await input.run;
			await runtimeBridge.packageRuntimeRunFinish({
				...input,
				run,
			});
		})(),
	);
}

function resolveRealtimeHandler(userModule, facetName) {
	const facetExportName = buildFacetClassExportName(facetName);
	if (typeof userModule[facetExportName] === 'function') {
		return {
			kind: 'class',
			exported: userModule[facetExportName],
		};
	}
	if (typeof userModule.handleRealtimeEvent === 'function') {
		return {
			kind: 'function',
			exported: userModule.handleRealtimeEvent,
		};
	}
	const candidate = userModule.default ?? userModule;
	if (candidate && typeof candidate.onRealtimeEvent === 'function') {
		return {
			kind: 'bound-method',
			exported: candidate,
		};
	}
	if (typeof candidate === 'function' && typeof candidate.prototype?.onRealtimeEvent === 'function') {
		return {
			kind: 'class',
			exported: candidate,
		};
	}
	return null;
}

async function readRuntimeRunId(runtimeRun) {
	try {
		const run = await runtimeRun;
		return run && typeof run.id === 'string' ? run.id : null;
	} catch (error) {
		console.warn('package-app-run-record-read-failed', error);
		return null;
	}
}

function withoutAuthorRuntimeErrorHeader(response) {
	if (!response?.headers?.has(${JSON.stringify(packageAppRuntimeErrorHeader)})) {
		return response;
	}
	try {
		const headers = new Headers(response.headers);
		headers.delete(${JSON.stringify(packageAppRuntimeErrorHeader)});
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch (error) {
		// Body may be locked/disturbed; still drop the internal marker so serve
		// does not treat an authored 5xx as a runtime throw.
		const fallbackHeaders = new Headers(response.headers);
		fallbackHeaders.delete(${JSON.stringify(packageAppRuntimeErrorHeader)});
		return new Response(null, {
			status: response.status,
			statusText: response.statusText,
			headers: fallbackHeaders,
		});
	}
}

function tagPackageAppRuntimeRun(response, runtimeRunId) {
	if (!runtimeRunId || !response || response.status < 500) return response;
	try {
		const headers = new Headers(response.headers);
		headers.delete(${JSON.stringify(packageAppRuntimeErrorHeader)});
		headers.set(${JSON.stringify(packageAppRuntimeRunIdHeader)}, runtimeRunId);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	} catch (error) {
		const fallbackHeaders = new Headers(response.headers);
		fallbackHeaders.delete(${JSON.stringify(packageAppRuntimeErrorHeader)});
		fallbackHeaders.set(${JSON.stringify(packageAppRuntimeRunIdHeader)}, runtimeRunId);
		return new Response(null, {
			status: response.status,
			statusText: response.statusText,
			headers: fallbackHeaders,
		});
	}
}

export class ${packageAppEntrypointName} extends WorkerEntrypoint {
	async fetch(request) {
		const runtimeBridge = this.env.${packageAppRuntimeBindingName};
		const requestUrl = new URL(request.url);
		// Read before any package code runs. Ticket and visitor stay in ALS
		// for this request only; they never enter module scope.
		const visitTicket = __kodyReadVisitTicket(request);
		const identityOnlyVisitor = visitTicket
			? null
			: __kodyReadIdentityOnlyVisitor(request);
		const runtimeRun = startRuntimeRun(runtimeBridge, {
			surface: 'app_fetch',
			name: requestUrl.pathname,
			metadata: {
				method: request.method,
				queryParamNames: collectQueryParamNames(requestUrl),
				...(isSyntheticPackageAppRequest(request) ? { synthetic: true } : {}),
			},
		});
		const consoleCapture = createConsoleLogCapture();
		const runtime = createRuntime(
			runtimeBridge,
			this.env.__kodyPackageContext ?? null,
			${mcpServerNamesExpr},
			identityOnlyVisitor,
		);
		try {
			consoleCapture.install();
			const response = await __kodyVisitStorage.run({ ticket: visitTicket }, async () => await __kodyRuntimeStorage.run(runtime, async () => await __kodyRunUserCode(this.env, async () => {
				const userModule = await import(${JSON.stringify(`./${input.mainModule}`)});
				const runtimeEnv = createPackageAppEnv(this.env, userModule);
				const candidate = userModule.default ?? userModule;
				const fetchHandler =
					typeof candidate === 'function'
						? candidate
						: candidate && typeof candidate.fetch === 'function'
							? candidate.fetch.bind(candidate)
							: null;
				if (!fetchHandler) {
					throw new Error('Package apps must default export a fetch handler or an object with fetch().');
				}
				return await fetchHandler(request, runtimeEnv, this.ctx);
			}, identityOnlyVisitor)));
			// Authors (or proxied upstreams) must not set the internal throw
			// marker; only the catch path below may attach it.
			let outgoing = withoutAuthorRuntimeErrorHeader(response);
			// Strip Set-Cookie Domain that would cover the package-app apex or
			// another tenant. Warn into consoleCapture so Activity shows it.
			const scrubbedCookies = __kodyScrubPackageAppSetCookieDomains(
				outgoing,
				requestUrl.hostname,
			);
			outgoing = scrubbedCookies.response;
			if (scrubbedCookies.stripped.length > 0) {
				// Activity capture stringifies args; keep details as one JSON string.
				console.warn(
					'package-app-set-cookie-domain-stripped ' +
						JSON.stringify({
							hostname: requestUrl.hostname,
							pathname: requestUrl.pathname,
							stripped: scrubbedCookies.stripped,
					}),
				);
			}
			if (scrubbedCookies.dropped.length > 0) {
				console.warn(
					'package-app-set-cookie-name-dropped ' +
						JSON.stringify({
							hostname: requestUrl.hostname,
							pathname: requestUrl.pathname,
							dropped: scrubbedCookies.dropped,
						}),
				);
			}
			if (outgoing && outgoing.status >= 500) {
				const runtimeRunId = await readRuntimeRunId(runtimeRun);
				console.error('package-app-runtime-http-error', {
					runtimeRunId,
					httpStatus: outgoing.status,
				});
				outgoing = tagPackageAppRuntimeRun(outgoing, runtimeRunId);
			}
			finishRuntimeRun(runtimeBridge, this.ctx, {
				run: runtimeRun,
				status: 'success',
				metadata: {
					httpStatus: response.status,
				},
				logs: consoleCapture.logs,
			});
			return outgoing;
		} catch (error) {
			const enrichedError = enrichUnboundPackagesInvokeError(error);
			const runtimeRunId = await readRuntimeRunId(runtimeRun);
			console.error('package-app-runtime-threw', { runtimeRunId });
			finishRuntimeRun(runtimeBridge, this.ctx, {
				run: runtimeRun,
				status: 'error',
				error: serializeRuntimeError(enrichedError),
				logs: consoleCapture.logs,
			});
			// Dynamic Worker fetch does not preserve custom Error properties.
			// Return a tagged 500 so the serve path can log runtimeRunId and
			// render the package-entrypoint error page.
			const headers = new Headers({
				[${JSON.stringify(packageAppRuntimeErrorHeader)}]: '1',
			});
			if (runtimeRunId) {
				headers.set(${JSON.stringify(packageAppRuntimeRunIdHeader)}, runtimeRunId);
			}
			return new Response(null, { status: 500, headers });
		} finally {
			consoleCapture.restore();
		}
	}

	async handleRealtimeEvent(payload) {
		const runtimeBridge = this.env.${packageAppRuntimeBindingName};
		const visitTicket =
			payload && typeof payload.__kodyVisitTicket === 'string'
				? payload.__kodyVisitTicket
				: null;
		const { __kodyVisitTicket: _visitTicket, ...userPayload } = payload ?? {};
		const runtimeRun = startRuntimeRun(runtimeBridge, {
			surface: 'app_realtime',
			name: buildFacetName(payload?.facet),
			sessionId: payload?.sessionId,
			metadata: {
				facet: payload?.facet,
				topic: payload?.topic,
			},
		});
		const consoleCapture = createConsoleLogCapture();
		const runtime = createRuntime(
			runtimeBridge,
			this.env.__kodyPackageContext ?? null,
			${mcpServerNamesExpr},
		);
		try {
			consoleCapture.install();
			const result = await __kodyVisitStorage.run({ ticket: visitTicket }, async () => await __kodyRuntimeStorage.run(runtime, async () => await __kodyRunUserCode(this.env, async () => {
				const userModule = await import(${JSON.stringify(`./${input.mainModule}`)});
				const runtimeEnv = createPackageAppEnv(this.env, userModule);
				const resolved = resolveRealtimeHandler(userModule, userPayload?.facet);
				if (!resolved) {
					return { actions: [] };
				}
				if (resolved.kind === 'function') {
					return await resolved.exported(userPayload, runtimeEnv, this.ctx);
				}
				if (resolved.kind === 'bound-method') {
					return await resolved.exported.onRealtimeEvent(userPayload, runtimeEnv, this.ctx);
				}
				const state = createInternalDurableObjectState(
					runtimeBridge,
					createFacetStorageId(this.env.__kodyPackageContext ?? null, userPayload?.facet),
				);
				const instance = Object.create(resolved.exported.prototype);
				instance.ctx = state;
				instance.env = runtimeEnv;
				if (typeof instance.onRealtimeEvent !== 'function') {
					throw new Error(\`Package app facet "\${buildFacetName(userPayload?.facet)}" must implement onRealtimeEvent().\`);
				}
				return await instance.onRealtimeEvent(userPayload, runtimeEnv, this.ctx);
			})));
			finishRuntimeRun(runtimeBridge, this.ctx, {
				run: runtimeRun,
				status: 'success',
				logs: consoleCapture.logs,
			});
			return result;
		} catch (error) {
			const enrichedError = enrichUnboundPackagesInvokeError(error);
			finishRuntimeRun(runtimeBridge, this.ctx, {
				run: runtimeRun,
				status: 'error',
				error: serializeRuntimeError(enrichedError),
				logs: consoleCapture.logs,
			});
			throw enrichedError;
		} finally {
			consoleCapture.restore();
		}
	}
}
`.trim()
}

type PackageAppRuntimeBridgeProps = {
	baseUrl: string
	/** The org that owns the app. */
	userId: OwnerId
	orgSlug: string | null
	/**
	 * Rematerialized per request, never cached on the template. A call that
	 * passes a visit ticket uses the ticket instead of this field.
	 */
	visitor: RuntimePackageAppVisitor | null
	email: string
	displayName: string
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string | null
	packageStorageGrantIds: Array<string>
	/**
	 * Request-scoped credential-client binding shared with KodyFetchGateway.
	 * Minted per request, never stored on the cached template.
	 */
	credentialClientBinding: string
	/** Per-run HMAC key for package-scoped secret placeholders (GHSA-5fv3). */
	packageSecretRefKey: string
	/**
	 * Per-build capability held only in the app wrapper's module scope
	 * (GHSA-5fv3). `packageBoundCall` / `packageBoundFetch` act as a granted
	 * package only when called with it; package code cannot read it.
	 */
	packageBindingToken: string
	/** Gateway props for per-package bound fetches (`boundPackageId` added per call). */
	gatewayProps: FetchGatewayProps | null
	/**
	 * This request's visit ticket, when rematerialized. The wrapper still
	 * passes the ticket on every bound call so a warm isolate cannot reuse
	 * another visitor's ticket.
	 */
	visitTicket?: string | null
	/** Audience used to verify a visit ticket on this app and commit. */
	visitAudience?: PackageAppVisitAudience | null
	/**
	 * `kody.app.capabilities`: the only Kody capabilities that run as the
	 * app's runs-as person.
	 */
	declaredCapabilities: Array<string>
	/** `kody.app.visitorNeeds`, by key: each is its own consent scope. */
	visitorNeeds: Record<string, PackageAppVisitorNeed>
}

function redactRunRecordLogs(
	logs: Array<RunRecordLogInput> | undefined,
	secretRedactor: ExecutionSecretRedactor,
): Array<RunRecordLogInput> | undefined {
	if (!logs) return logs
	return logs.map((entry) => {
		if (typeof entry === 'string') {
			return secretRedactor.redactErrorMessage(entry)
		}
		return {
			...entry,
			message: secretRedactor.redactErrorMessage(entry.message),
		}
	})
}

function redactRunRecordError(
	error: unknown,
	secretRedactor: ExecutionSecretRedactor,
): unknown {
	if (error === undefined) return undefined
	return secretRedactor.redactUnknown(error)
}

export class PackageAppRuntimeBridge extends WorkerEntrypoint<
	Env,
	PackageAppRuntimeBridgeProps
> {
	private readonly credentialClientTools = new Map<
		string,
		Promise<AdditionalKodyTools>
	>()
	private readonly secretRedactor: ExecutionSecretRedactor =
		createExecutionSecretRedactor()

	private authorityScope(): PackageAppAuthorityScope {
		return { orgId: this.ctx.props.userId, packageId: this.ctx.props.packageId }
	}

	/** The app's runs-as person in the owning org, with their live role. */
	private createRunsAsCallerContext(
		runsAs: Extract<PackageAppRunsAs, { status: 'ready' }>,
		storageId: string | null,
	) {
		return createMcpCallerContext({
			baseUrl: this.ctx.props.baseUrl,
			executionOrigin: 'background',
			user: {
				userId: runsAs.personId,
				email: runsAs.email,
				username: runsAs.username,
				displayName: runsAs.displayName,
			},
			orgBinding: {
				org: { id: this.ctx.props.userId, slug: runsAs.request.org.slug },
				role: runsAs.role,
			},
			storageContext: {
				sessionId: null,
				appId: this.ctx.props.packageId,
				packageId: this.ctx.props.packageId,
				storageId,
			},
			source: { kind: 'package-app' },
		})
	}

	private noteAuthorityFallback(
		callName: string,
		kind: PackageAppAuthorityDifferenceKind,
		visitor: RuntimePackageAppVisitor | null,
	) {
		schedulePackageAppAuthorityFallback({
			env: this.env,
			event: {
				ownerId: this.ctx.props.userId,
				packageId: this.ctx.props.packageId,
				callName,
				kind,
				visitorId: visitor?.userId ?? null,
			},
			waitUntil: (promise) => this.ctx.waitUntil(promise),
		})
	}

	/** A lookup failure runs the call the legacy way, never fails it. */
	private async loadRunsAs(): Promise<PackageAppRunsAs> {
		try {
			return await loadPackageAppRunsAs({
				env: this.env,
				scope: this.authorityScope(),
			})
		} catch (error) {
			console.error(
				JSON.stringify({
					event: 'package_app_runs_as_lookup_failed',
					packageId: this.ctx.props.packageId,
					error: error instanceof Error ? error.name : 'unknown',
				}),
			)
			return {
				status: 'unavailable',
				reason: 'not-set',
				message: packageAppRunsAsUnavailableMessages['not-set'],
			}
		}
	}

	/**
	 * Run one bridge call as the app's runs-as person (ADR 0068 amendment
	 * 2026-10-24). When that fails for an authority reason, the call runs the
	 * legacy way (as the visitor, or anonymously) and, when that works,
	 * leaves a would-break row. A call that fails both ways throws the
	 * runs-as error. Never retries a failure that is not about authority.
	 */
	private async runWithAuthority<T>(input: {
		callName: string
		storageId: string | null
		/** This request's visit ticket, as the wrapper passed it. */
		visitTicket: string | null | undefined
		run: (
			callerContext: McpCallerContext,
			mode: PackageAppAuthorityMode,
		) => Promise<T>
		/** A returned (not thrown) refusal that is about authority. */
		refusedResultKind?: (result: T) => PackageAppAuthorityDifferenceKind | null
	}): Promise<T> {
		const runsAs = await this.loadRunsAs()
		const runLegacy = async () =>
			await input.run(
				await this.createCallerContext(input.storageId, input.visitTicket),
				'legacy',
			)
		const noteFallback = async (kind: PackageAppAuthorityDifferenceKind) =>
			this.noteAuthorityFallback(
				input.callName,
				kind,
				await this.visitorFor(input.visitTicket),
			)
		if (runsAs.status !== 'ready') {
			let result: T
			try {
				result = await runLegacy()
			} catch (error) {
				if (
					runsAs.reason === 'person-unavailable' &&
					packageAppAuthorityFallbackKindOf(error)
				) {
					throw new PackageAppRunsAsUnavailableError(runsAs.reason, {
						cause: error,
					})
				}
				throw error
			}
			if (!input.refusedResultKind?.(result)) {
				await noteFallback('runs_as_unavailable')
			}
			return result
		}
		let refusedKind: PackageAppAuthorityDifferenceKind
		let refused: { result: T } | { error: unknown }
		try {
			const result = await input.run(
				this.createRunsAsCallerContext(runsAs, input.storageId),
				'runs-as',
			)
			const kind = input.refusedResultKind?.(result) ?? null
			if (!kind) return result
			refusedKind = kind
			refused = { result }
		} catch (error) {
			const kind = packageAppAuthorityFallbackKindOf(error)
			if (!kind) throw error
			refusedKind = kind
			refused = { error }
		}
		const giveUp = () => {
			if ('error' in refused) throw refused.error
			return refused.result
		}
		let legacyResult: T
		try {
			legacyResult = await runLegacy()
		} catch {
			return giveUp()
		}
		if (input.refusedResultKind?.(legacyResult)) return giveUp()
		await noteFallback(refusedKind)
		return legacyResult
	}

	private async requireVisit(ticket: string | null | undefined) {
		if (typeof ticket !== 'string' || ticket === '') return null
		const audience = this.ctx.props.visitAudience
		if (!audience) {
			throw new Error('Package app visit ticket is not valid.')
		}
		return await verifyPackageAppVisitTicket({
			env: this.env,
			ticket,
			audience,
		})
	}

	/** Who this call acts for the legacy way: the ticket's visitor, if any. */
	private async visitorFor(
		ticket: string | null | undefined,
	): Promise<RuntimePackageAppVisitor | null> {
		const visit = await this.requireVisit(ticket)
		return visit?.visitor ?? null
	}

	private async createCallerContext(
		storageId: string | null,
		ticket?: string | null,
	) {
		const visit = await this.requireVisit(ticket)
		const visitor = visit?.visitor ?? null
		const email = visit?.owner.email ?? this.ctx.props.email
		const displayName = visit?.owner.displayName ?? this.ctx.props.displayName
		const orgSlug = visit?.owner.orgSlug ?? this.ctx.props.orgSlug
		return createMcpCallerContext({
			baseUrl: this.ctx.props.baseUrl,
			executionOrigin: 'background',
			user: visitor
				? {
						userId: visitor.userId,
						email,
						username: visitor.username,
						displayName,
					}
				: null,
			orgBinding: visitor
				? {
						org: { id: this.ctx.props.userId, slug: orgSlug },
						role: visitor.role,
					}
				: undefined,
			storageContext: {
				sessionId: null,
				appId: this.ctx.props.packageId,
				packageId: this.ctx.props.packageId,
				storageId,
			},
			source: { kind: 'package-app' },
		})
	}

	private credentialBindingFor(visit: PackageAppVisitClaims | null) {
		return visit?.credentialClientBinding ?? ''
	}

	private getStorageRunner(
		storageId: string,
		packageAppVisitorUserId?: string,
	) {
		return storageRunnerRpc({
			env: this.env,
			userId: this.ctx.props.userId,
			storageId,
			...(packageAppVisitorUserId !== undefined
				? { packageAppVisitorUserId }
				: {}),
		})
	}

	private readonly storageBytesEntitlementCache =
		createStorageBytesEntitlementRunCache()

	private async assertStorageWriteAllowed(input: {
		storageId: string
		requested?: number
	}) {
		await assertStorageRunnerWriteWithinEntitlement({
			env: this.env,
			userId: this.ctx.props.userId,
			email: this.ctx.props.email,
			storageId: input.storageId,
			requested: input.requested,
			cache: this.storageBytesEntitlementCache,
		})
	}

	/**
	 * Security model for package-app storage:
	 * - Raw `storage*` methods are namespace-locked to this app's internal
	 *   `${packageId}:…` buckets. The bridge stub is reachable from
	 *   user code via `Object.create(env)`, so these methods must never accept
	 *   arbitrary same-user ids (`package:…`, raw package ids, `job:…`).
	 * - `package:{…}` durable buckets are reached only through the
	 *   grant-validated `packageStorage*` methods (`assertPackageStorageGranted`
	 *   from bundler-controlled provenance).
	 */
	private assertAppOwnedStorageId(storageId: string) {
		const normalizedStorageId = storageId.trim()
		if (!normalizedStorageId) {
			throw new Error('Package app storage requires a non-empty storage id.')
		}
		const packageId = this.ctx.props.packageId
		if (normalizedStorageId.startsWith(`${packageId}:`)) {
			return normalizedStorageId
		}
		throw new Error(
			`Package app storage id "${normalizedStorageId}" is outside this app's namespace. ` +
				`Raw storage methods only accept ids prefixed with "${packageId}:". ` +
				'Saved-package durable buckets use packageStorage() and are gated by bundler provenance grants.',
		)
	}

	private assertPackageStorageGranted(packageId: string) {
		const normalizedPackageId = packageId.trim()
		if (!normalizedPackageId) {
			throw new Error('packageStorage requires a non-empty package id.')
		}
		const grantedPackageIds = new Set(this.ctx.props.packageStorageGrantIds)
		if (!grantedPackageIds.has(normalizedPackageId)) {
			throw new Error(
				createPackageStorageAccessDeniedMessage(normalizedPackageId),
			)
		}
		return normalizedPackageId
	}

	/**
	 * Bucket owner for a `packageStorage*` call (GHSA-5fv3). The grant set
	 * says which buckets this run may touch; only a trusted per-package
	 * binding (`boundPackageId`, set by `packageBoundCall` after the
	 * capability check) says whose code is calling. Unbound calls act as the
	 * run package, so a caller-named granted id cannot reach another
	 * package's bucket.
	 */
	private resolvePackageStorageOwner(
		requestedPackageId: unknown,
		boundPackageId: string | null,
	) {
		const packageId = this.assertPackageStorageGranted(
			typeof requestedPackageId === 'string' ? requestedPackageId : '',
		)
		const ownerPackageId =
			boundPackageId?.trim() || this.ctx.props.packageId.trim() || null
		if (packageId !== ownerPackageId) {
			throw new Error(createPackageStorageOwnerOnlyMessage(packageId))
		}
		return packageId
	}

	/**
	 * Secret authority for a bridge call. Only a trusted per-package binding
	 * (`boundPackageId`, set by `packageBoundCall` after the capability
	 * check) selects a package; otherwise the run package. Caller-supplied
	 * fields (`packageId`, `__kodySecretAuthorityPackageId`) are ignored
	 * (GHSA-5fv3).
	 */
	private resolvePackageSecretAuthorityPackageId(
		boundPackageId: string | null,
	) {
		const authorityPackageId =
			boundPackageId?.trim() || this.ctx.props.packageId.trim() || null
		if (!authorityPackageId) {
			throw new Error(
				'packageSecrets requires a matching server-side package runtime context.',
			)
		}
		return this.assertPackageStorageGranted(authorityPackageId)
	}

	private getRealtimeSessionRpc() {
		return packageRealtimeSessionRpc({
			env: this.env,
			userId: this.ctx.props.userId,
			packageId: this.ctx.props.packageId,
			kodyId: this.ctx.props.kodyId,
			sourceId: this.ctx.props.sourceId,
			baseUrl: this.ctx.props.baseUrl,
		})
	}

	async packageRuntimeRunStart(input: {
		surface: 'app_fetch' | 'app_realtime'
		name?: string | null
		sessionId?: string | null
		metadata?: Record<string, unknown> | null
	}): Promise<RunRecordHandle | null> {
		const callerContext = await this.createCallerContext(null)
		return beginRunRecord({
			env: this.env,
			userId: this.ctx.props.userId,
			request: callerContext.request,
			startedByLabel: callerContext.request?.credential.profileName ?? null,
			context: {
				packageId: this.ctx.props.packageId,
				kodyId: this.ctx.props.kodyId,
				sourceId: this.ctx.props.sourceId,
				publishedCommit: this.ctx.props.publishedCommit,
				surface: input.surface,
				name: input.name,
				sessionId: input.sessionId,
				metadata: input.metadata,
			},
			waitUntil: (promise) => {
				this.ctx.waitUntil(promise)
			},
		})
	}

	async packageRuntimeRunFinish(input: {
		run: RunRecordHandle | null
		status: RunTerminalStatus
		error?: unknown
		logs?: Array<RunRecordLogInput>
		metadata?: Record<string, unknown>
	}) {
		const logs = redactRunRecordLogs(input.logs, this.secretRedactor)
		const error = redactRunRecordError(input.error, this.secretRedactor)
		const handle =
			input.run && input.metadata
				? {
						...input.run,
						context: {
							...input.run.context,
							metadata: {
								...input.run.context.metadata,
								...input.metadata,
							},
						},
					}
				: input.run
		const finishPromise = finishRunRecord({
			env: this.env,
			handle,
			status: input.status,
			error,
			logs,
		}).catch((finishError: unknown) => {
			console.warn('package-app-run-record-finish-failed', finishError)
		})
		this.ctx.waitUntil(finishPromise)
		return { ok: true }
	}

	async listMcpServerNames(): Promise<Array<string>> {
		try {
			const refs = await listVisibleEnabledMcpServerRefsCached({
				env: this.env,
				userId: this.ctx.props.userId,
				packageId: this.ctx.props.packageId,
			})
			return refs.map((ref) => ref.name)
		} catch {
			return []
		}
	}

	async callCapability(input: {
		name: string
		args?: unknown
		visitTicket?: string | null
	}) {
		return await this.callCapabilityAs(null, input, input.visitTicket)
	}

	/**
	 * Trusted per-package binding entry (GHSA-5fv3). The app wrapper calls it
	 * with the per-build capability it alone holds; the package id it names
	 * must be in the run grant set. Package code reaching `env.KODY_RUNTIME`
	 * cannot present the capability, so it can only act as the run package.
	 */
	async packageBoundCall(input: {
		token: string
		packageId: string
		op:
			| 'capability'
			| 'packageSecretGet'
			| 'packageSecretHas'
			| 'packageStorage'
			| 'credentialClient'
		name?: string
		args?: unknown
		alias?: string
		visitTicket?: string | null
	}) {
		const packageId = await this.assertPackageBindingCapability(
			input?.token,
			input?.packageId,
		)
		const visitTicket = input.visitTicket
		switch (input.op) {
			case 'capability':
				return await this.callCapabilityAs(
					packageId,
					{
						name: String(input.name ?? ''),
						args: input.args,
					},
					visitTicket,
				)
			case 'packageSecretGet':
				return await this.packageSecretGetAs(
					packageId,
					String(input.alias ?? ''),
					visitTicket,
				)
			case 'packageSecretHas':
				return await this.packageSecretHasAs(
					packageId,
					String(input.alias ?? ''),
					visitTicket,
				)
			case 'packageStorage':
				return await this.packageStorageCallAs(
					packageId,
					String(input.name ?? ''),
					input.args,
					visitTicket,
				)
			case 'credentialClient':
				return await this.credentialClientCallAs(
					packageId,
					{
						name: String(input.name ?? ''),
						args: input.args,
					},
					visitTicket,
				)
			default:
				throw new Error('Unknown package binding operation.')
		}
	}

	async packageBoundFetch(
		token: string,
		packageId: string,
		request: Request,
		visitTicket?: string | null,
	) {
		const boundPackageId = await this.assertPackageBindingCapability(
			token,
			packageId,
		)
		const gatewayProps = this.ctx.props.gatewayProps
		if (!gatewayProps || !workerExports?.KodyFetchGateway) {
			return await fetch(request)
		}
		const visit = await this.requireVisit(visitTicket)
		const forwarded =
			typeof visitTicket === 'string'
				? withPackageAppVisitTicket(request, visitTicket)
				: request
		return await workerExports
			.KodyFetchGateway({
				props: {
					...gatewayProps,
					boundPackageId,
					request: visit
						? ((await this.createCallerContext(null, visitTicket)).request ??
							null)
						: null,
					credentialClientBinding: this.credentialBindingFor(visit),
				},
			})
			.fetch(forwarded)
	}

	private async assertPackageBindingCapability(
		token: unknown,
		packageId: unknown,
	) {
		const expected = this.ctx.props.packageBindingToken
		if (
			typeof token !== 'string' ||
			!expected ||
			!(await timingSafeEqualString(token, expected))
		) {
			throw new Error('Package binding capability is invalid.')
		}
		const normalized = typeof packageId === 'string' ? packageId.trim() : ''
		if (!normalized) {
			throw new Error('Package binding requires a package id.')
		}
		return this.assertPackageStorageGranted(normalized)
	}

	private async callCapabilityAs(
		boundPackageId: string | null,
		input: { name: string; args?: unknown },
		visitTicket?: string | null,
	) {
		const name = input.name.trim()
		// Discard any caller-supplied authority field (GHSA-5fv3).
		const { args } = takeSecretAuthorityFromCapabilityArgs([input.args ?? {}])
		const capabilityArgs = (args[0] ?? {}) as Record<string, unknown>
		if (name === trackRunSecretToolName) {
			trackSecretValueForms(
				(value) => this.secretRedactor.track(value),
				capabilityArgs.value,
			)
			return { ok: true }
		}
		if (name === packageAppIdentityCapabilityName) {
			return await this.visitorIdentityAnswer(
				boundPackageId,
				capabilityArgs,
				visitTicket,
			)
		}
		if (name === packageAppVisitorNeedCallName) {
			return await this.callVisitorNeed(
				boundPackageId,
				capabilityArgs,
				visitTicket,
			)
		}
		const declared = new Set(this.ctx.props.declaredCapabilities)
		return await this.runWithAuthority({
			callName: name,
			storageId: null,
			visitTicket,
			run: async (callerContext, mode) => {
				if (mode === 'runs-as' && !declared.has(name)) {
					throw new PackageAppCapabilityNotDeclaredError(name)
				}
				return await this.invokeCapability(boundPackageId, callerContext, {
					name,
					args: capabilityArgs,
					unavailable: (missing) =>
						mode === 'runs-as'
							? new PackageAppCapabilityUnavailableError(missing)
							: new Error(
									`Package app capability "${missing}" is not available.`,
								),
				})
			},
		})
	}

	private async invokeCapability(
		boundPackageId: string | null,
		callerContext: McpCallerContext,
		input: {
			name: string
			args: Record<string, unknown>
			unavailable?: (name: string) => Error
		},
	) {
		const { capabilityMap } = await getCapabilityRegistryForContext({
			env: this.env,
			callerContext,
		})
		const capability = capabilityMap[input.name]
		if (!capability) {
			throw (
				input.unavailable?.(input.name) ??
				new Error(`Package app capability "${input.name}" is not available.`)
			)
		}
		const invoke = () =>
			capability.handler(input.args, { env: this.env, callerContext })
		const grantedPackageIds = new Set(this.ctx.props.packageStorageGrantIds)
		return await runWithSecretAuthorityScope(grantedPackageIds, () =>
			runWithCurrentSecretAuthority(boundPackageId, invoke),
		)
	}

	/**
	 * `metaGetCurrentUser` names the visitor, never the runs-as person:
	 * identity is information, not authority. Members of the owning org also
	 * get their role. Email needs the visitor's `email` consent; an answer
	 * that carried it without consent keeps it for now and is logged.
	 */
	private async visitorIdentityAnswer(
		boundPackageId: string | null,
		args: Record<string, unknown>,
		visitTicket: string | null | undefined,
	) {
		const visitor = await this.visitorFor(visitTicket)
		const legacy = (await this.invokeCapability(
			boundPackageId,
			await this.createCallerContext(null, visitTicket),
			{ name: packageAppIdentityCapabilityName, args },
		)) as Record<string, unknown>
		if (!visitor) return legacy
		const answer = { ...legacy, role: visitor.role }
		const email = typeof legacy.email === 'string' ? legacy.email : ''
		if (!email) return answer
		// Only decides whether to log; a failed grant read never changes the answer.
		const grant = await this.findVisitorGrant(visitor).catch(() => null)
		if (grant && scopesIncludeEmail(grant.scopes)) return answer
		this.noteAuthorityFallback(
			packageAppIdentityCapabilityName,
			'identity_email',
			visitor,
		)
		return answer
	}

	private async findVisitorGrant(visitor: RuntimePackageAppVisitor) {
		const { orgSlug, kodyId } = this.ctx.props
		if (!orgSlug) return null
		return await findLivePackageAppOauthGrant({
			db: this.env.APP_DB,
			personId: visitor.userId,
			orgUsername: orgSlug.toLowerCase(),
			kodyId,
		})
	}

	/**
	 * `kody.visitorNeed({ need, args })`: run a declared visitor need as the
	 * signed-in visitor, on their own data. Needs a live Sign in with Kody
	 * grant that covers the need's scope, checked on every call. Any failure
	 * is an error; it never falls back to the runs-as person.
	 */
	private async callVisitorNeed(
		boundPackageId: string | null,
		args: Record<string, unknown>,
		visitTicket: string | null | undefined,
	) {
		const key = typeof args.need === 'string' ? args.need.trim() : ''
		const need = Object.hasOwn(this.ctx.props.visitorNeeds, key)
			? this.ctx.props.visitorNeeds[key]
			: undefined
		if (!need) {
			throw new PackageAppVisitorConsentError(
				`"${key}" is not a visitor need this app declares in kody.app.visitorNeeds.`,
			)
		}
		if (need.credential) {
			await this.assertVisitorCredentialIsExecutorSupplied(
				need.credential,
				visitTicket,
			)
		}
		if (!need.capability) {
			throw new PackageAppVisitorConsentError(
				`Visitor need "${key}" is a credential need. Open it with credential.visitor("${key}").`,
			)
		}
		const visitorContext = await this.visitorConsentCallerContext(
			key,
			visitTicket,
		)
		const needArgs =
			args.args !== null &&
			typeof args.args === 'object' &&
			!Array.isArray(args.args)
				? (args.args as Record<string, unknown>)
				: {}
		return await this.invokeCapability(boundPackageId, visitorContext, {
			name: need.capability,
			args: needArgs,
		})
	}

	/**
	 * The visitor, acting on their own data for one consented need. The grant
	 * is read live on every call so a revoke takes effect on the next one.
	 */
	private async visitorConsentCallerContext(
		needKey: string,
		visitTicket: string | null | undefined,
	) {
		const visitor = await this.visitorFor(visitTicket)
		if (!visitor) {
			throw new PackageAppVisitorConsentError(
				'This needs a visitor signed in with Kody. Anonymous visitors cannot share their own data.',
			)
		}
		const consents = await packageAppVisitorConsents({
			db: this.env.APP_DB,
			visitorPersonId: visitor.userId,
			grantScope: this.grantScope(),
			needKey,
			waitUntil: (promise) => this.ctx.waitUntil(promise),
		})
		if (!consents) {
			throw new PackageAppVisitorConsentError(
				`The visitor has not allowed this app to use "${needKey}". Ask them to sign in with Kody and allow it.`,
			)
		}
		return await this.createCallerContext(null, visitTicket)
	}

	async storageGet(input: { storageId: string; key: string }) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.getStorageRunner(storageId).getValue({
			key: input.key,
		})
	}

	async storageList(input: {
		storageId: string
		prefix?: string | null
		pageSize?: number
		startAfter?: string | null
	}) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.getStorageRunner(storageId).listValues({
			prefix: input.prefix,
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	private async sqlQueryWithEntitlement(input: {
		storageId: string
		query: string
		params?: Array<unknown>
		writable: boolean
		packageAppVisitorUserId?: string
	}) {
		// package app bridges always mark packageStorage SQL writable, so skip
		// the all-bucket fan-out for pure SELECT/EXPLAIN/PRAGMA statements.
		if (input.writable && !isReadOnlyStorageSqlQuery(input.query)) {
			await this.assertStorageWriteAllowed({
				storageId: input.storageId,
				requested: estimateEntitlementStorageSqlWriteBytes({
					query: input.query,
					params: input.params,
				}),
			})
		}
		return await this.getStorageRunner(
			input.storageId,
			input.packageAppVisitorUserId,
		).sqlQuery({
			query: input.query,
			params: input.params,
			writable: input.writable,
		})
	}

	private async setValueWithEntitlement(input: {
		storageId: string
		key: string
		value: unknown
		packageAppVisitorUserId?: string
	}) {
		const existing = await this.getStorageRunner(
			input.storageId,
			input.packageAppVisitorUserId,
		).getValue({ key: input.key })
		await this.assertStorageWriteAllowed({
			storageId: input.storageId,
			requested: estimateEntitlementStorageEntryByteDelta({
				next: {
					key: input.key,
					value: input.value,
				},
				existing:
					existing.value === null
						? null
						: {
								key: input.key,
								value: existing.value,
							},
			}),
		})
		return await this.getStorageRunner(input.storageId).setValue({
			key: input.key,
			value: input.value,
		})
	}

	async storageSql(input: {
		storageId: string
		query: string
		params?: Array<unknown>
		writable?: boolean
	}) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.sqlQueryWithEntitlement({
			storageId,
			query: input.query,
			params: input.params,
			writable: input.writable ?? false,
		})
	}

	async storageSet(input: { storageId: string; key: string; value: unknown }) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.setValueWithEntitlement({
			storageId,
			key: input.key,
			value: input.value,
		})
	}

	async storageDelete(input: { storageId: string; key: string }) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.getStorageRunner(storageId).deleteValue({
			key: input.key,
		})
	}

	async storageClear(input: { storageId: string }) {
		const storageId = this.assertAppOwnedStorageId(input.storageId)
		return await this.getStorageRunner(storageId).clearStorage()
	}

	async appRateLimit(input: {
		key?: unknown
		limit?: unknown
		windowSeconds?: unknown
	}) {
		return await checkPackageAppRateLimit({
			db: this.env.APP_DB,
			packageId: this.ctx.props.packageId,
			key: input?.key,
			limit: input?.limit,
			windowSeconds: input?.windowSeconds,
		})
	}

	async appSpendGet() {
		return await packageAppSpendGet({
			db: this.env.APP_DB,
			orgId: this.ctx.props.userId,
			packageId: this.ctx.props.packageId,
		})
	}

	async packageStorageGet(input: { packageId: string; key: string }) {
		return await this.packageStorageGetAs(null, input)
	}

	async packageStorageList(input: {
		packageId: string
		prefix?: string | null
		pageSize?: number
		startAfter?: string | null
	}) {
		return await this.packageStorageListAs(null, input)
	}

	async packageStorageSql(input: {
		packageId: string
		query: string
		params?: Array<unknown>
		writable?: boolean
	}) {
		return await this.packageStorageSqlAs(null, input)
	}

	async packageStorageSet(input: {
		packageId: string
		key: string
		value: unknown
	}) {
		return await this.packageStorageSetAs(null, input)
	}

	async packageStorageDelete(input: { packageId: string; key: string }) {
		return await this.packageStorageDeleteAs(null, input)
	}

	async packageStorageClear(input: { packageId: string }) {
		return await this.packageStorageClearAs(null, input)
	}

	/**
	 * Bound `packageStorage()` call from the app wrapper's per-package
	 * binding (GHSA-5fv3). The bucket is the bound package's own; any
	 * `packageId` in `args` must match it.
	 */
	private async packageStorageCallAs(
		boundPackageId: string,
		method: string,
		args: unknown,
		visitTicket?: string | null,
	) {
		const packageAppVisitorUserId =
			(await this.visitorFor(visitTicket))?.userId ?? ''
		const payload = (
			args !== null && typeof args === 'object' && !Array.isArray(args)
				? args
				: {}
		) as Record<string, unknown>
		const packageId =
			typeof payload['packageId'] === 'string'
				? payload['packageId']
				: boundPackageId
		const input = { ...payload, packageId } as {
			packageId: string
			key: string
			value: unknown
			query: string
			params?: Array<unknown>
			writable?: boolean
			prefix?: string | null
			pageSize?: number
			startAfter?: string | null
			packageAppVisitorUserId?: string
		}
		input.packageAppVisitorUserId = packageAppVisitorUserId
		switch (method) {
			case 'packageStorageGet':
				return await this.packageStorageGetAs(boundPackageId, input)
			case 'packageStorageList':
				return await this.packageStorageListAs(boundPackageId, input)
			case 'packageStorageSql':
				return await this.packageStorageSqlAs(boundPackageId, input)
			case 'packageStorageSet':
				return await this.packageStorageSetAs(boundPackageId, input)
			case 'packageStorageDelete':
				return await this.packageStorageDeleteAs(boundPackageId, input)
			case 'packageStorageClear':
				return await this.packageStorageClearAs(boundPackageId, input)
			default:
				throw new Error('Unknown package storage operation.')
		}
	}

	private async packageStorageGetAs(
		boundPackageId: string | null,
		input: {
			packageId: string
			key: string
			packageAppVisitorUserId?: string
		},
	) {
		const packageId = this.resolvePackageStorageOwner(
			input.packageId,
			boundPackageId,
		)
		// Provenance-granted package: buckets intentionally bypass the app
		// namespace lock on raw storage* (assertAppOwnedStorageId).
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
			input.packageAppVisitorUserId,
		).getValue({
			key: input.key,
		})
	}

	private async packageStorageListAs(
		boundPackageId: string | null,
		input: {
			packageId: string
			prefix?: string | null
			pageSize?: number
			startAfter?: string | null
			packageAppVisitorUserId?: string
		},
	) {
		const packageId = this.resolvePackageStorageOwner(
			input.packageId,
			boundPackageId,
		)
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
			input.packageAppVisitorUserId,
		).listValues({
			prefix: input.prefix,
			pageSize: input.pageSize,
			startAfter: input.startAfter,
		})
	}

	private async packageStorageSqlAs(
		boundPackageId: string | null,
		input: {
			packageId: string
			query: string
			params?: Array<unknown>
			writable?: boolean
			packageAppVisitorUserId?: string
		},
	) {
		const packageId = this.resolvePackageStorageOwner(
			input.packageId,
			boundPackageId,
		)
		return await this.sqlQueryWithEntitlement({
			storageId: buildPackageStorageId(packageId),
			query: input.query,
			params: input.params,
			writable: input.writable ?? false,
			packageAppVisitorUserId: input.packageAppVisitorUserId,
		})
	}

	private async packageStorageSetAs(
		boundPackageId: string | null,
		input: {
			packageId: string
			key: string
			value: unknown
			packageAppVisitorUserId?: string
		},
	) {
		const packageId = this.resolvePackageStorageOwner(
			input.packageId,
			boundPackageId,
		)
		return await this.setValueWithEntitlement({
			storageId: buildPackageStorageId(packageId),
			key: input.key,
			value: input.value,
			packageAppVisitorUserId: input.packageAppVisitorUserId,
		})
	}

	private async packageStorageDeleteAs(
		boundPackageId: string | null,
		input: { packageId: string; key: string },
	) {
		const packageId = this.resolvePackageStorageOwner(
			input.packageId,
			boundPackageId,
		)
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
		).deleteValue({
			key: input.key,
		})
	}

	private async packageStorageClearAs(
		boundPackageId: string | null,
		input: { packageId: string },
	) {
		const packageId = this.resolvePackageStorageOwner(
			input.packageId,
			boundPackageId,
		)
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
		).clearStorage()
	}

	async authenticatedFetch(input: {
		providerName: string
		visitTicket?: string | null
		request: {
			url: string
			method?: string
			headers?: Record<string, string>
			body?: string
		}
	}) {
		return await this.runWithAuthority({
			callName: 'authenticatedFetch',
			storageId: this.ctx.props.packageId,
			visitTicket: input.visitTicket,
			run: async (callerContext) => {
				const kody = await buildKodyFns(this.env, callerContext)
				const authenticatedFetch = await createAuthenticatedFetch(
					kody,
					input.providerName,
				)
				return await authenticatedFetch(input.request.url, {
					method: input.request.method,
					headers: input.request.headers,
					body: input.request.body,
				})
			},
		})
	}

	private async resolvePackageSecretMount(input: {
		alias: string
		boundPackageId: string | null
		visitTicket: string | null | undefined
		access?: 'presence' | 'value'
	}) {
		const packageId = this.resolvePackageSecretAuthorityPackageId(
			input.boundPackageId,
		)
		return await this.runWithAuthority({
			callName: 'packageSecret',
			storageId: this.ctx.props.packageId,
			visitTicket: input.visitTicket,
			run: async (callerContext) =>
				await resolveCredential({
					env: this.env,
					orgId: ownerIdFromCaller(callerContext),
					actor: callerContext.request,
					packageStamp: attestedPackageStamp(packageId),
					baseUrl: callerContext.baseUrl,
					runContextPackageId: this.ctx.props.packageId,
					credential: {
						use: 'package-secret-mount',
						alias: input.alias,
						callerContext,
						...(input.access ? { access: input.access } : {}),
					},
				}),
		})
	}

	/** Run-package secrets only; caller-supplied ids are ignored (GHSA-5fv3). */
	async packageSecretGet(input: {
		alias: string
		visitTicket?: string | null
	}) {
		return await this.packageSecretGetAs(
			null,
			String(input?.alias ?? ''),
			input?.visitTicket,
		)
	}

	private async packageSecretGetAs(
		boundPackageId: string | null,
		alias: string,
		visitTicket: string | null | undefined,
	) {
		const input = { alias }
		const resolved = await this.resolvePackageSecretMount({
			alias,
			boundPackageId,
			visitTicket,
		})
		// Opaque placeholder string only — never track or return plaintext.
		let value = resolved.ref
		if (
			resolved.scope === 'package' &&
			resolved.packageId &&
			this.ctx.props.packageSecretRefKey
		) {
			const issued = await issuePackageSecretRef({
				refKey: this.ctx.props.packageSecretRefKey,
				packageId: resolved.packageId,
				alias: resolved.alias ?? input.alias,
			})
			value = buildSecretPlaceholder({
				name: resolved.name,
				scope: 'package',
				ref: issued,
			})
		}
		return { value }
	}

	/** Run-package secrets only; caller-supplied ids are ignored (GHSA-5fv3). */
	async packageSecretHas(input: {
		alias: string
		visitTicket?: string | null
	}) {
		return await this.packageSecretHasAs(
			null,
			String(input?.alias ?? ''),
			input?.visitTicket,
		)
	}

	private async packageSecretHasAs(
		boundPackageId: string | null,
		alias: string,
		visitTicket: string | null | undefined,
	) {
		try {
			await this.resolvePackageSecretMount({
				alias,
				boundPackageId,
				visitTicket,
				access: 'presence',
			})
			return {
				has: true,
			}
		} catch (error) {
			if (isPackageSecretAccessUnavailableError(error)) {
				return {
					has: false,
				}
			}
			throw error
		}
	}

	async realtimeEmit(input: { sessionId: string; data: unknown }) {
		return await this.getRealtimeSessionRpc().emit(input.sessionId, input.data)
	}

	async realtimeBroadcast(input: {
		data: unknown
		topic?: string | null
		facet?: string | null
	}) {
		return await this.getRealtimeSessionRpc().broadcast(input)
	}

	async realtimeListSessions(input?: {
		topic?: string | null
		facet?: string | null
	}) {
		return await this.getRealtimeSessionRpc().listSessions(input)
	}

	async realtimeDisconnect(input: {
		sessionId: string
		code?: number | null
		reason?: string | null
	}) {
		return await this.getRealtimeSessionRpc().disconnect(input.sessionId, {
			code: input.code ?? undefined,
			reason: input.reason ?? undefined,
		})
	}

	async workflowCreate(input: unknown, visitTicket?: string | null) {
		return await this.runWithAuthority({
			callName: 'workflowCreate',
			storageId: null,
			visitTicket,
			run: async (callerContext) => {
				const { request } = callerContext
				if (!request) {
					throw new Error('workflows.create requires a package app user.')
				}
				return await createDynamicCallableWorkflow({
					env: this.env,
					userId: this.ctx.props.userId,
					userEmail: callerContext.user?.email ?? this.ctx.props.email,
					packageContext: {
						packageId: this.ctx.props.packageId,
						kodyId: this.ctx.props.kodyId,
						sourceId: this.ctx.props.sourceId,
					},
					body: input as PackageWorkflowCreateInput,
					lineage: requestLineage(request),
				})
			},
		})
	}

	async createPackageEventTools(visitTicket?: string | null) {
		return await this.packageEventToolsFor(
			await this.createCallerContext(this.ctx.props.packageId, visitTicket),
		)
	}

	/** Never public: a sandbox-supplied caller context would pick authority. */
	private async packageEventToolsFor(callerContext: McpCallerContext) {
		// Avoid a top-level package-app -> package-invocations cycle during worker
		// startup; apps only need this helper when package code calls it.
		// Do not cache: a warm isolate would reuse the first visitor's caller.
		const { createPackageEventTools } =
			await import('#worker/package-invocations/service.ts')
		return createPackageEventTools({
			env: this.env,
			baseUrl: this.ctx.props.baseUrl,
			callerContext,
			packageContext: {
				packageId: this.ctx.props.packageId,
				kodyId: this.ctx.props.kodyId,
				sourceId: this.ctx.props.sourceId,
			},
			parentRunRecord: null,
			packageInvokeDepth: 0,
		})
	}

	async packageEventDispatch(
		input: Record<string, unknown>,
		visitTicket?: string | null,
	) {
		return await this.runWithAuthority({
			callName: 'packageEventDispatch',
			storageId: this.ctx.props.packageId,
			visitTicket,
			run: async (callerContext) => {
				const tools = await this.packageEventToolsFor(callerContext)
				return await tools.dispatch(input)
			},
		})
	}

	private grantScope(): PackageAppVisitorGrantScope | null {
		const { orgSlug, kodyId } = this.ctx.props
		return orgSlug ? { orgSlug, kodyId } : null
	}

	/**
	 * Credential client tools acting as one package (GHSA-5fv3): the package
	 * `packageBoundCall` bound after its capability check, or the app package
	 * for the public bridge. A sandbox-named package id never selects another
	 * package's needs or bound Keys. `opener` says who new handles act as;
	 * handles already open carry their own authority.
	 */
	private async getCredentialClientTools(
		boundPackageId: string | null,
		opener:
			| { mode: 'legacy' }
			| { mode: 'runs-as'; callerContext: McpCallerContext }
			| {
					mode: 'visitor-need'
					needKey: string
					executorNeed: boolean
			  },
		visitTicket: string | null | undefined,
	) {
		const visit = await this.requireVisit(visitTicket)
		const owner = boundPackageId ?? this.ctx.props.packageId
		const binding = this.credentialBindingFor(visit)
		const cacheKey = JSON.stringify([
			owner,
			binding,
			opener.mode,
			opener.mode === 'visitor-need'
				? [opener.needKey, opener.executorNeed]
				: opener.mode === 'runs-as'
					? (opener.callerContext.user?.userId ?? null)
					: null,
		])
		const cached = this.credentialClientTools.get(cacheKey)
		if (cached) return await cached
		const tools = (async () => {
			const visitorContext = await this.createCallerContext(null, visitTicket)
			const callerContext =
				opener.mode === 'runs-as' ? opener.callerContext : visitorContext
			const visitorCredentialRequest =
				opener.mode === 'visitor-need' && opener.executorNeed
					? await createPackageAppVisitorCredentialRequest({
							db: this.env.APP_DB,
							orgId: this.ctx.props.userId,
							callerRequest: callerContext.request,
							visitor: visit?.visitor ?? null,
						})
					: visitorContext.request
			let runNeeds: Promise<ReadonlyMap<string, SavedCredentialNeed>> | null =
				null
			return createCredentialClientKodyTools({
				env: this.env,
				callerContext,
				options: {
					binding,
					resolvePackageId: async (requested) =>
						resolveCallerCredentialPackageId({
							requested,
							callerPackageId: owner,
						}),
					// Needs load for anonymous visitors too: an opted-in need is the
					// only way they reach a credential.
					runNeeds: () => {
						runNeeds ??= loadRunCredentialNeeds({
							env: this.env,
							orgId: this.ctx.props.userId,
							packageIds: [this.ctx.props.packageId],
							request: callerContext.request,
						})
						return runNeeds
					},
					// Under the runs-as person every declared need is theirs, so the
					// `ownerCredentialForVisitors` opt-in only applies the legacy way.
					ownerCredentialScope:
						opener.mode === 'legacy'
							? packageAppOwnerCredentialScope(this.ctx.props)
							: null,
					packageAppAuthority: createPackageAppCredentialAuthority({
						env: this.env,
						scope: this.authorityScope(),
						grantScope: this.grantScope(),
						visitorRequest: visitorCredentialRequest ?? null,
						issue:
							opener.mode === 'runs-as'
								? { runsAs: true }
								: opener.mode === 'visitor-need'
									? { visitorNeed: opener.needKey }
									: null,
						waitUntil: (promise) => this.ctx.waitUntil(promise),
					}),
					waitUntil: (promise) => {
						this.ctx.waitUntil(promise)
					},
				},
			})
		})()
		this.credentialClientTools.set(cacheKey, tools)
		return await tools
	}

	async credentialClientCall(input: {
		name: string
		args?: unknown
		visitTicket?: string | null
	}) {
		return await this.credentialClientCallAs(null, input, input.visitTicket)
	}

	private async credentialClientCallAs(
		boundPackageId: string | null,
		input: { name: string; args?: unknown },
		visitTicket?: string | null,
	) {
		const name = String(input.name ?? '').trim()
		const allowed = new Set<string>(Object.values(credentialClientToolNames))
		if (!allowed.has(name)) {
			throw new Error(`Unknown credential client tool "${name}".`)
		}
		const args =
			input.args !== null &&
			typeof input.args === 'object' &&
			!Array.isArray(input.args)
				? (input.args as Record<string, unknown>)
				: {}
		const callTool = async (tools: AdditionalKodyTools, toolArgs: unknown) => {
			const tool = tools[name]
			if (typeof tool !== 'function') {
				throw new Error(`Credential client tool "${name}" is not available.`)
			}
			return await tool(toolArgs)
		}
		if (name === credentialClientToolNames.open && 'visitorNeed' in args) {
			return await this.openVisitorCredential(
				boundPackageId,
				args,
				callTool,
				visitTicket,
			)
		}
		const opens =
			name === credentialClientToolNames.open ||
			name === credentialClientToolNames.openAll ||
			name === credentialClientToolNames.check
		if (!opens) {
			// Sign, call, and refresh use an open handle, which carries who it
			// acts as.
			return await callTool(
				await this.getCredentialClientTools(
					boundPackageId,
					{ mode: 'legacy' },
					visitTicket,
				),
				args,
			)
		}
		return await this.runWithAuthority({
			callName: `credential:${name}`,
			storageId: null,
			visitTicket,
			refusedResultKind: packageAppAuthorityFallbackKindOfResult,
			run: async (callerContext, mode) => {
				if (mode === 'legacy') {
					return await callTool(
						await this.getCredentialClientTools(
							boundPackageId,
							{ mode: 'legacy' },
							visitTicket,
						),
						args,
					)
				}
				if (args.name !== undefined && args.name !== null) {
					// The runs-as person's credentials are capped to declared needs.
					throw new PackageAppCapabilityNotDeclaredError('credential.named')
				}
				return await callTool(
					await this.getCredentialClientTools(
						boundPackageId,
						{ mode: 'runs-as', callerContext },
						visitTicket,
					),
					args,
				)
			},
		})
	}

	/**
	 * `credential.visitor(need)`: the visitor's own credential for a declared
	 * `kody.app.visitorNeeds` credential need, while their consent covers it.
	 * Never falls back to the runs-as person.
	 */
	private async openVisitorCredential(
		boundPackageId: string | null,
		args: Record<string, unknown>,
		callTool: (
			tools: AdditionalKodyTools,
			toolArgs: unknown,
		) => Promise<unknown>,
		visitTicket: string | null | undefined,
	) {
		const key =
			typeof args.visitorNeed === 'string' ? args.visitorNeed.trim() : ''
		const directSupplier = await this.assertVisitorCredentialIsExecutorSupplied(
			key,
			visitTicket,
		)
		if (directSupplier === 'executor') {
			await this.visitorConsentCallerContext(key, visitTicket)
			return await callTool(
				await this.getCredentialClientTools(
					boundPackageId,
					{
						mode: 'visitor-need',
						needKey: key,
						executorNeed: true,
					},
					visitTicket,
				),
				{ key },
			)
		}
		const need = Object.hasOwn(this.ctx.props.visitorNeeds, key)
			? this.ctx.props.visitorNeeds[key]
			: undefined
		if (!need?.credential) {
			throw new PackageAppVisitorConsentError(
				`"${key}" is not a credential need this app declares in kody.app.visitorNeeds.`,
			)
		}
		const supplier = await this.assertVisitorCredentialIsExecutorSupplied(
			need.credential,
			visitTicket,
		)
		const scopeNeed = supplier === 'executor' ? need.credential : key
		await this.visitorConsentCallerContext(scopeNeed, visitTicket)
		return await callTool(
			await this.getCredentialClientTools(
				boundPackageId,
				{
					mode: 'visitor-need',
					needKey: scopeNeed,
					executorNeed: supplier === 'executor',
				},
				visitTicket,
			),
			{ key: need.credential },
		)
	}

	private async assertVisitorCredentialIsExecutorSupplied(
		credentialKey: string,
		visitTicket: string | null | undefined,
	): Promise<'publisher' | 'executor' | null> {
		const callerContext = await this.createCallerContext(null, visitTicket)
		const needs = await loadPublishedCredentialNeeds({
			env: this.env,
			userId: this.ctx.props.userId,
			sourceId: this.ctx.props.sourceId,
			request: callerContext.request,
		})
		const supplier =
			needs.find((need) => need.key === credentialKey)?.supplier ?? null
		if (supplier !== 'publisher') return supplier
		throw new PackageAppVisitorConsentError(
			`Credential need "${credentialKey}" is supplied by the publisher; use credential("${credentialKey}")`,
		)
	}
}

type PackageAppWorkerOptions = Parameters<Env['APP_LOADER']['load']>[0]

/**
 * Request-independent part of a package app worker build: modules, compat
 * settings, plain env values, and the props the request-bound bindings carry.
 * The loopback bindings themselves (`KODY_RUNTIME` and the `KodyFetchGateway`
 * globalOutbound) are request-bound I/O objects, so they are minted per
 * request by `materializePackageAppWorkerOptions` instead of being cached.
 */
type PackageAppWorkerTemplate = {
	options: Omit<PackageAppWorkerOptions, 'env' | 'globalOutbound'> & {
		env: Record<string, unknown>
	}
	bridgeProps: PackageAppRuntimeBridgeProps
	gatewayProps: FetchGatewayProps
}

type PackageAppWorkerBuild = {
	workerId: string | null
	template: PackageAppWorkerTemplate
}

// Caches the request-independent build (bundle lookup + hydration + wrapper +
// binding props). Never cache loader stubs or loopback bindings: both are
// bound to the request that created them. A cached `KODY_RUNTIME` /
// `KodyFetchGateway` fetcher made the loader fail with "Cannot perform I/O on
// behalf of a different request" whenever it (re)loaded the dynamic isolate
// from any request other than the one that built the options.
const packageAppWorkerOptionsCache =
	new PromiseLruCache<PackageAppWorkerBuild>()

/**
 * Mint the request-bound loopback bindings for one loader call. Call it inside
 * the `APP_LOADER.get` callback (or right before `APP_LOADER.load`) so the
 * bindings belong to the request that loads the isolate. Visitor identity,
 * request context, and the credential binding come from `requestVisit`, never
 * from the cached template. A warm isolate may skip this factory; ticketless
 * bridge and gateway paths stay anonymous and do not inherit frozen props.
 */
export function materializePackageAppWorkerOptions(
	template: PackageAppWorkerTemplate,
	requestVisit?: PackageAppRequestVisit | null,
): PackageAppWorkerOptions {
	const credentialClientBinding =
		requestVisit?.credentialClientBinding ?? newRunCredentialClientBinding()
	const visitor = requestVisit?.visitor ?? null
	const request = requestVisit?.request ?? null
	const email = requestVisit?.email ?? template.bridgeProps.email
	const displayName =
		requestVisit?.displayName ?? template.bridgeProps.displayName
	const gatewayProps: FetchGatewayProps = {
		...template.gatewayProps,
		email,
		request,
		credentialClientBinding,
	}
	const bridgeProps: PackageAppRuntimeBridgeProps = {
		...template.bridgeProps,
		visitor,
		email,
		displayName,
		credentialClientBinding,
		gatewayProps,
		visitTicket: requestVisit?.ticket ?? null,
	}
	return {
		...template.options,
		env: {
			...template.options.env,
			[packageAppRuntimeBindingName]: requireLocalPackageAppRuntimeBridge()({
				props: bridgeProps,
			}),
		},
		globalOutbound: workerExports?.KodyFetchGateway
			? workerExports.KodyFetchGateway({ props: gatewayProps })
			: null,
	} as PackageAppWorkerOptions
}

export async function createPackageAppWorkerId(input: {
	cacheKey: string
	workerOptions: Pick<
		PackageAppWorkerOptions,
		'modules' | 'compatibilityDate' | 'compatibilityFlags' | 'mainModule'
	>
}) {
	const moduleEntries = Object.entries(input.workerOptions.modules ?? {})
	if (
		moduleEntries.some(([, moduleValue]) => typeof moduleValue !== 'string')
	) {
		// Non-string modules cannot be hashed deterministically; fall back to
		// one-off loads for those workers.
		return null
	}
	const sortedModuleEntries = [...moduleEntries].sort(([left], [right]) =>
		left.localeCompare(right),
	)
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(
			JSON.stringify([
				'package-app-worker@v1',
				input.cacheKey,
				input.workerOptions.compatibilityDate ?? null,
				input.workerOptions.compatibilityFlags ?? [],
				input.workerOptions.mainModule,
				sortedModuleEntries,
			]),
		),
	)
	const hash = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '')
	return `package-app-${hash.slice(0, 43)}`
}

/**
 * Keys the cached build: owner, package, commit, and mount. Visitor identity
 * is per-request (header + visit ticket), so it is not part of the key.
 * Separate mounts (app origin, subdomain, custom domain) still get separate
 * workers because base URL, app base path, and hosted URL stay in the key.
 */
export function createPackageAppWorkerCacheKey(input: {
	userId: OwnerId
	orgSlug: string | null
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string | null
	baseUrl: string
	appBasePath: string
	hostedUrl: string
}) {
	if (!input.publishedCommit) {
		return null
	}
	return JSON.stringify([
		input.userId,
		input.orgSlug,
		input.packageId,
		input.kodyId,
		input.sourceId,
		input.publishedCommit,
		input.baseUrl,
		input.appBasePath,
		input.hostedUrl,
	])
}

/**
 * The visitor a package app acts as. An anonymous visitor (no request
 * context) is null; `servingUsername` then names the owning org's slug.
 */
function packageAppVisitorOf(
	callerContext: McpCallerContext,
	servingUsername?: string,
): { orgSlug: string | null; visitor: RuntimePackageAppVisitor | null } {
	const request = callerContext.request
	if (!request) {
		return { orgSlug: servingUsername ?? null, visitor: null }
	}
	if (!request.actor) {
		throw new Error('A package app acts only as its visitor.')
	}
	return {
		orgSlug: request.org.slug,
		visitor: {
			userId: request.actor.userId,
			username: request.actor.username ?? '',
			role: request.membership?.role ?? null,
		},
	}
}

/**
 * The owning org's slug on the shared worker, so the wrapper may answer
 * `metaGetCurrentUser` from the platform visitor header when there is no
 * visit ticket (identity-only or anonymous). A ticket skips that shortcut.
 */
function identityOnlyOrgSlugOf(runtime: { servingUsername?: string }): string {
	return runtime.servingUsername ?? ''
}

function getUsernameFromPackageName(packageName: string) {
	const separatorIndex = packageName.indexOf('/')
	if (!packageName.startsWith('@') || separatorIndex <= 1) {
		throw new Error(
			`Saved package name "${packageName}" must include a username scope.`,
		)
	}
	return packageName.slice(1, separatorIndex)
}

function packageAppPublicBasePath(input: {
	mount: PackageAppMount | undefined
	username: string
	kodyId: string
}): string {
	switch (input.mount) {
		case 'user-subdomain':
			return buildPackageAppSubdomainPath({ kodyId: input.kodyId })
		case 'custom-hostname':
			// Customer hosts serve the app at `/`, so assets live at `/_assets`.
			return ''
		case 'username-path':
		case undefined:
			return buildPackageAppPath({
				username: input.username,
				kodyId: input.kodyId,
			})
		default: {
			input.mount satisfies never
			throw new Error(`Unknown package app mount: ${String(input.mount)}`)
		}
	}
}

async function buildPackageAppPublicContext(input: {
	env: Env
	baseUrl: string
	savedPackage: { id: string; kodyId: string; name: string }
	runtime: {
		servingUsername?: string
		hostedOrigin?: string
		mount?: PackageAppMount
	}
}) {
	const username =
		input.runtime.servingUsername ??
		getUsernameFromPackageName(input.savedPackage.name)
	const cookiePrefix = await packageAppCookiePrefix(input.savedPackage.id)
	// Public URLs use the name leaf (Kent: slug = leaf). Keep kodyId on the
	// package context as identity; only the path segment switches to the leaf.
	const urlSlug = getPackageNameLeaf(input.savedPackage.name)
	if (input.runtime.hostedOrigin) {
		// Request-scoped: the mount the request actually arrived on. On a
		// per-user subdomain the username lives in the hostname, so the app is
		// mounted at `/packages/{slug}`; inline serving keeps the
		// `/@{username}` path prefix.
		const appBasePath = packageAppPublicBasePath({
			mount: input.runtime.mount,
			username,
			kodyId: urlSlug,
		})
		return {
			appBasePath,
			hostedUrl: `${input.runtime.hostedOrigin.replace(/\/+$/, '')}${appBasePath}`,
			cookiePrefix,
		}
	}
	// Background/synthetic callers get the canonical hosted URL: a verified
	// app-level custom hostname, otherwise the per-user subdomain, otherwise
	// the inline path-based mount.
	const canonical = await resolvePublicPackageAppLocation({
		env: input.env,
		username,
		kodyId: urlSlug,
	})
	if (canonical) return { ...canonical, cookiePrefix }
	const hostedUrl = resolveHostedPackageAppUrl({
		packageAppBaseUrl: getPackageAppBaseUrl({ env: input.env }),
		appBaseUrl: input.baseUrl,
		username,
		kodyId: urlSlug,
	})
	return {
		appBasePath: new URL(hostedUrl).pathname,
		hostedUrl,
		cookiePrefix,
	}
}

function resolvePackageAppManifest(input: {
	manifest?: AuthoredPackageJson
	source?: EntitySourceRow
	sourceFiles?: Record<string, string>
	savedPackage: {
		manifestPath: string
	}
}) {
	if (input.manifest) {
		return input.manifest
	}
	const packageJsonContent = input.sourceFiles?.['package.json']
	if (!packageJsonContent) {
		throw new Error('Saved package is missing package.json.')
	}
	return parseAuthoredPackageJson({
		content: packageJsonContent,
		manifestPath:
			input.source?.manifest_path ?? input.savedPackage.manifestPath,
		mode: 'published',
	})
}

async function resolvePersistablePackageSource(input: {
	env: Env
	userId: OwnerId
	source?: EntitySourceRow
	sourceId: string
}) {
	if (input.source?.user_id === input.userId && input.source.repo_id) {
		return input.source
	}
	const source = await getEntitySourceById(input.env.APP_DB, input.sourceId)
	if (!source || source.user_id !== input.userId) {
		throw new Error(`Saved package source "${input.sourceId}" was not found.`)
	}
	return source
}

async function resolvePackageAppBundledArtifact(input: {
	env: Env
	userId: OwnerId
	source?: EntitySourceRow
	manifest: AuthoredPackageJson
	savedPackage: {
		id: string
		kodyId: string
		sourceId: string
		publishedCommit: string | null
		manifestPath: string
		sourceRoot: string
	}
	loadSourceFiles?: () => Promise<Record<string, string>>
	sourceFiles?: Record<string, string>
	baseUrl: string
}) {
	const appEntry = getPackageAppEntryPath(input.manifest)
	if (!appEntry) {
		throw new Error(
			`Saved package "${input.savedPackage.kodyId}" does not define kody.app.entry.`,
		)
	}
	const sourceForCache = input.source ?? {
		id: input.savedPackage.sourceId,
		published_commit: input.savedPackage.publishedCommit,
		manifest_path: input.savedPackage.manifestPath,
		source_root: input.savedPackage.sourceRoot,
	}
	const inMemoryCacheKey = createPublishedPackageAppBundleCacheKey({
		userId: input.userId,
		source: sourceForCache,
		entryPoint: appEntry,
	})
	if (!input.savedPackage.publishedCommit) {
		const sourceFiles = await resolvePackageAppSourceFiles(input)
		assertPublishedSourceCanRebuildWithoutInstallingDeps({
			sourceFiles,
			bundleLabel: `Saved package app "${input.savedPackage.kodyId}"`,
		})
		return await buildKodyAppBundle({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles,
			entryPoint: appEntry,
			rootPackageId: input.savedPackage.id,
			cacheKey: inMemoryCacheKey,
		})
	}
	const loadedArtifact = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
		kind: 'app',
		artifactName: null,
		entryPoint: appEntry,
	})
	const currentArtifact =
		loadedArtifact?.artifact &&
		isPublishedBundleArtifactCurrentForCommit({
			artifact: loadedArtifact.artifact,
			rowPublishedCommit: loadedArtifact.row?.publishedCommit,
			currentPublishedCommit: input.savedPackage.publishedCommit,
		})
			? loadedArtifact.artifact
			: null
	const servePublishedArtifact = (artifact: PublishedBundleArtifact) => ({
		mainModule: artifact.mainModule,
		modules: artifact.modules,
		dependencies: artifact.dependencies,
		dynamicDependencies: artifact.dynamicDependencies,
	})
	// A pre-fix bundle that inlines other packages may need one rebuild so
	// each package's fetch acts as that package (GHSA-5fv3-qv7j-rqf5).
	if (currentArtifact && !isUnrepairablePreBindingArtifact(currentArtifact)) {
		return servePublishedArtifact(currentArtifact)
	}
	// Only a caller that passes no source at all keeps serving the published
	// bundle (logged so the unbound bundle is visible). A source load that
	// fails propagates instead of silently serving an unrepaired bundle.
	if (currentArtifact && !input.sourceFiles && !input.loadSourceFiles) {
		console.warn(
			JSON.stringify({
				event: 'pre_binding_bundle_served_without_source',
				sourceId: input.savedPackage.sourceId,
				surface: 'app',
			}),
		)
		return servePublishedArtifact(currentArtifact)
	}
	const sourceFiles = await resolvePackageAppSourceFiles(input)
	if (
		currentArtifact &&
		!publishedArtifactNeedsPackageBindingRebuild({
			artifact: currentArtifact,
			sourceFiles,
		})
	) {
		return servePublishedArtifact(currentArtifact)
	}
	assertPublishedSourceCanRebuildWithoutInstallingDeps({
		sourceFiles,
		bundleLabel: `Saved package app "${input.savedPackage.kodyId}"`,
	})
	// The caller's manifest and source row may come from the freshness-cached
	// invoke contract and trail a republish by up to the freshness TTL, while
	// the source-file load above is always current. Re-derive the app entry
	// from those files and persist against a freshly loaded source row so the
	// bundle identity matches the commit being built.
	const rebuildAppEntry = resolvePackageAppEntryFromSourceFiles({
		sourceFiles,
		savedPackage: input.savedPackage,
	})
	const compiled = await buildKodyAppBundle({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: input.userId,
		sourceFiles,
		entryPoint: rebuildAppEntry,
		rootPackageId: input.savedPackage.id,
		cacheKey: inMemoryCacheKey,
	})
	const persistableSource = await resolvePersistablePackageSource({
		env: input.env,
		userId: input.userId,
		sourceId: input.savedPackage.sourceId,
	})
	await persistPublishedBundleArtifact({
		env: input.env,
		userId: input.userId,
		source: persistableSource,
		kind: 'app',
		artifactName: null,
		entryPoint: rebuildAppEntry,
		mainModule: compiled.mainModule,
		modules: compiled.modules,
		dependencies: compiled.dependencies,
		dynamicDependencies: compiled.dynamicDependencies,
		packageContext: {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
		},
	})
	return compiled
}

function resolvePackageAppEntryFromSourceFiles(input: {
	sourceFiles: Record<string, string>
	savedPackage: { kodyId: string; manifestPath: string }
}) {
	const appEntry = getPackageAppEntryPath(
		resolvePackageAppManifest({
			sourceFiles: input.sourceFiles,
			savedPackage: input.savedPackage,
		}),
	)
	if (!appEntry) {
		throw new Error(
			`Saved package "${input.savedPackage.kodyId}" does not define kody.app.entry.`,
		)
	}
	return appEntry
}

async function resolvePackageAppSourceFiles(input: {
	sourceFiles?: Record<string, string>
	loadSourceFiles?: () => Promise<Record<string, string>>
}) {
	if (input.sourceFiles) {
		return input.sourceFiles
	}
	if (!input.loadSourceFiles) {
		throw new Error(
			'Saved package source files are required to rebuild the app.',
		)
	}
	return await input.loadSourceFiles()
}

async function buildPackageAppWorkerOptionsUncached(
	input: {
		env: Env
		baseUrl: string
		userId: OwnerId
		savedPackage: {
			id: string
			kodyId: string
			name: string
			sourceId: string
			publishedCommit: string | null
			manifestPath: string
			sourceRoot: string
		}
		source?: EntitySourceRow
		manifest?: AuthoredPackageJson
		loadSourceFiles?: () => Promise<Record<string, string>>
		sourceFiles?: Record<string, string>
		runtime: {
			callerContext: ReturnType<typeof createMcpCallerContext>
			servingUsername?: string
			hostedOrigin?: string
			mount?: PackageAppMount
		}
	},
	/**
	 * The build cache key when this build is cached under a stable worker id;
	 * null for a one-off load.
	 */
	bindingCacheKey: string | null,
): Promise<PackageAppWorkerTemplate> {
	const publicContext = await buildPackageAppPublicContext(input)
	const manifest = resolvePackageAppManifest({
		manifest: input.manifest,
		source: input.source,
		sourceFiles: input.sourceFiles,
		savedPackage: input.savedPackage,
	})
	const [bundled, clientArtifact] = await Promise.all([
		resolvePackageAppBundledArtifact({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			source: input.source,
			manifest,
			savedPackage: input.savedPackage,
			loadSourceFiles: input.loadSourceFiles,
			sourceFiles: input.sourceFiles,
		}),
		resolvePackageAppClientArtifact({
			env: input.env,
			userId: input.userId,
			manifest,
			savedPackage: input.savedPackage,
			loadSourceFiles: input.loadSourceFiles,
			sourceFiles: input.sourceFiles,
		}),
	])
	// Platform-served static surface. The client module URL carries the
	// content hash, so pages read it from packageContext instead of
	// hardcoding a file name that changes on every publish.
	const assetContext = {
		assetBasePath: buildPackageAppAssetBasePath(publicContext.appBasePath),
		clientModuleUrl: clientArtifact
			? buildPackageAppClientModuleUrl({
					hostedUrl: publicContext.hostedUrl,
					mainModule: clientArtifact.mainModule,
				})
			: null,
	}
	const mainModule = 'package-app-entry.js'
	const { modules: hydratedModules, dynamicDependencyPackageIds } =
		await hydrateKodyRuntimeModules({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			modules: bundled.modules,
		})
	const packageStorageGrantIds = [
		...collectPackageStorageGrantIds({
			packageContext: {
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				sourceId: input.savedPackage.sourceId,
			},
			dependencies: bundled.dependencies,
			dynamicDependencyPackageIds,
		}),
	]
	// Per-build capability for the trusted per-package bindings (GHSA-5fv3).
	// Embedded only in the wrapper's module scope and the bridge props. A
	// cached build derives it from its cache key so a rebuild after cache
	// expiry produces the same module text and worker id; a one-off build
	// gets a random one.
	const packageBindingToken = bindingCacheKey
		? await packageAppBindingTokenFor({
				secretStoreKey: input.env.SECRET_STORE_KEY,
				cacheKey: bindingCacheKey,
			})
		: createRandomPackageBindingToken()
	const modules = {
		...hydratedModules,
		[mainModule]: createPackageAppWorkerSource({
			mainModule: bundled.mainModule,
			packageBindingIds: packageStorageGrantIds,
			packageBindingToken,
			rewriteNullPackagesInvoke:
				modulesContainUnboundPackagesInvokeAccess(hydratedModules),
			preloadMcpServerNames: modulesReferenceKodyMcp(bundled.modules),
			identityOnlyOrgSlug: identityOnlyOrgSlugOf(input.runtime),
			packageAppApexHostnames: listPackageAppOrigins({
				env: input.env,
			}).map((origin) => origin.hostname),
			packageAppCookiePrefix: publicContext.cookiePrefix,
		}),
	}
	// The cached template is identity-free: no visitor, request context, or
	// credential binding. Those are minted per request and ride the visit
	// ticket so a shared isolate cannot reuse the first request's authority.
	const packageSecretRefKey = createPackageSecretRefKey()
	const visitAudience: PackageAppVisitAudience = {
		host: visitHostOf(publicContext.hostedUrl, input.baseUrl),
		packageId: input.savedPackage.id,
		kodyId: input.savedPackage.kodyId,
		sourceId: input.savedPackage.sourceId,
		publishedCommit: input.savedPackage.publishedCommit,
	}
	const { orgSlug: visitorGrantOrgSlug } = packageAppVisitorOf(
		input.runtime.callerContext,
		input.runtime.servingUsername,
	)
	const visitorGrantScope = visitorGrantOrgSlug
		? { orgSlug: visitorGrantOrgSlug, kodyId: input.savedPackage.kodyId }
		: null
	const gatewayProps: FetchGatewayProps = {
		baseUrl: input.baseUrl,
		userId: input.userId,
		email: null,
		request: null,
		storageContext: {
			sessionId: null,
			appId: input.savedPackage.id,
			packageId: input.savedPackage.id,
			storageId: null,
		},
		grantedSecretAuthorityPackageIds: packageStorageGrantIds,
		packageSecretRefKey,
		ownerCredentialScope: packageAppOwnerCredentialScope({
			userId: input.userId,
			packageId: input.savedPackage.id,
			publishedCommit: input.savedPackage.publishedCommit,
		}),
		visitAudience,
		packageAppAuthority: {
			scope: { orgId: input.userId, packageId: input.savedPackage.id },
			grantScope: visitorGrantScope,
		},
	}
	// Fail the build (host-setup) when this script cannot mint the bridge,
	// instead of failing later inside the loader callback.
	requireLocalPackageAppRuntimeBridge()
	return {
		options: {
			...createDynamicWorkerCompatibilityOptions(),
			mainModule,
			modules,
			env: {
				__kodyPackageContext: {
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
					sourceId: input.savedPackage.sourceId,
					publishedCommit: input.savedPackage.publishedCommit,
					...publicContext,
					...assetContext,
				},
			},
		},
		bridgeProps: {
			baseUrl: input.baseUrl,
			userId: input.userId,
			orgSlug: packageAppVisitorOf(
				input.runtime.callerContext,
				input.runtime.servingUsername,
			).orgSlug,
			visitor: null,
			email: '',
			displayName: `package:${input.savedPackage.id}`,
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
			publishedCommit: input.savedPackage.publishedCommit,
			packageStorageGrantIds,
			credentialClientBinding: '',
			packageSecretRefKey,
			packageBindingToken,
			gatewayProps,
			visitTicket: null,
			visitAudience,
			declaredCapabilities: [...(manifest.kody.app?.capabilities ?? [])],
			visitorNeeds: { ...manifest.kody.app?.visitorNeeds },
		},
		gatewayProps,
	}
}

function visitHostOf(hostedUrl: string, baseUrl: string) {
	try {
		return new URL(hostedUrl).origin
	} catch {
		try {
			return new URL(baseUrl).origin
		} catch {
			return baseUrl
		}
	}
}

/**
 * Where an `ownerCredentialForVisitors` need may resolve owner credentials:
 * this app at the commit it serves. Whether the app is internet-visible and
 * that commit approved is read when a need asks, not baked into the worker.
 */
function packageAppOwnerCredentialScope(input: {
	userId: OwnerId
	packageId: string
	publishedCommit: string | null
}): OwnerCredentialScope {
	return {
		orgId: input.userId,
		packageId: input.packageId,
		publishedCommit: input.publishedCommit,
	}
}

export async function buildPackageAppWorker(input: {
	env: Env
	baseUrl: string
	userId: OwnerId
	savedPackage: {
		id: string
		kodyId: string
		name: string
		sourceId: string
		publishedCommit: string | null
		manifestPath: string
		sourceRoot: string
	}
	source?: EntitySourceRow
	manifest?: AuthoredPackageJson
	loadSourceFiles?: () => Promise<Record<string, string>>
	sourceFiles?: Record<string, string>
	runtime: {
		callerContext: ReturnType<typeof createMcpCallerContext>
		servingUsername?: string
		hostedOrigin?: string
		mount?: PackageAppMount
	}
	/** LOADER mint surface. HTTP serve is `app_fetch`; realtime passes `app_realtime`. */
	surface?: 'app_fetch' | 'app_realtime'
	/**
	 * Offload the unique-worker-day claim from the HTTP/realtime critical
	 * path. Defaults to the invocation `waitUntil` from `cloudflare:workers`.
	 */
	waitUntil?: (promise: Promise<unknown>) => void
	/**
	 * Optional Server-Timing bag from `servePackageAppRequest`. Records
	 * `usageGate` and `appLoader` (options cache + `APP_LOADER.get` / `load`).
	 */
	serverTiming?: Array<ServerTimingEntry>
}) {
	// Apps run package code and read package storage without a daily counter,
	// so they take the include → credits → stop gate. The breaker runs it after
	// the response and refuses only once a denial has opened it.
	const request = input.runtime.callerContext.request
	await pushServerTiming(input.serverTiming, 'usageGate', async () => {
		await gatePackageAppUsage({
			env: input.env,
			ownerId: input.userId,
			actorId: request?.actor?.userId ?? null,
			waitUntil: input.waitUntil ?? scheduleWorkerWaitUntil,
			check: () =>
				assertWithinComputeInclude({
					db: input.env.APP_DB,
					env: input.env,
					userId: input.userId,
					orgBudget: request
						? {
								orgId: request.org.id,
								orgSlug: request.org.slug,
								actorUserId: request.actor?.userId ?? null,
								actorUsername: request.actor?.username ?? null,
							}
						: undefined,
				}),
		})
	})
	return await pushServerTiming(input.serverTiming, 'appLoader', async () => {
		const publicContext = await buildPackageAppPublicContext(input)
		const { orgSlug, visitor } = packageAppVisitorOf(
			input.runtime.callerContext,
			input.runtime.servingUsername,
		)
		const visitorGrant =
			visitor && orgSlug
				? await findLivePackageAppOauthGrant({
						db: input.env.APP_DB,
						personId: visitor.userId,
						orgUsername: orgSlug.toLowerCase(),
						kodyId: input.savedPackage.kodyId,
					}).catch((error: unknown) => {
						console.warn('package-app-visitor-grant-lookup-failed', error)
						return null
					})
				: null
		const requestVisit = await createPackageAppRequestVisit({
			env: input.env,
			visitor,
			owner: {
				userId: input.userId,
				orgSlug,
				email: input.runtime.callerContext.user?.email ?? '',
				displayName:
					input.runtime.callerContext.user?.displayName ??
					`package:${input.savedPackage.id}`,
			},
			audience: {
				host: visitHostOf(publicContext.hostedUrl, input.baseUrl),
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				sourceId: input.savedPackage.sourceId,
				publishedCommit: input.savedPackage.publishedCommit,
			},
			request: input.runtime.callerContext.request ?? null,
			grantId: visitorGrant?.id ?? null,
			scopes: visitorGrant?.scopes ?? ['profile'],
		})
		const cacheKey = createPackageAppWorkerCacheKey({
			userId: input.userId,
			orgSlug: input.runtime.servingUsername ?? null,
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
			publishedCommit: input.savedPackage.publishedCommit,
			baseUrl: input.baseUrl,
			...publicContext,
		})
		const surface = input.surface ?? 'app_fetch'
		if (!cacheKey) {
			return {
				stub: input.env.APP_LOADER.load(
					materializePackageAppWorkerOptions(
						await buildPackageAppWorkerOptionsUncached(input, null),
						requestVisit,
					),
				),
				entrypointName: packageAppEntrypointName,
				visit: requestVisit,
			}
		}
		const build = await packageAppWorkerOptionsCache.getOrCreate({
			cacheKey,
			create: async () => {
				const template = await buildPackageAppWorkerOptionsUncached(
					input,
					cacheKey,
				)
				return {
					workerId: await createPackageAppWorkerId({
						cacheKey,
						workerOptions: template.options,
					}),
					template,
				}
			},
		})
		// Acquire the request-bound stub before claiming the day. A failed
		// `APP_LOADER.get()` must not persist a (day, workerId) that a retry
		// would then skip without a `dynamic_worker_day` event. The loopback
		// bindings are minted in this request: the loader may (re)load the
		// isolate from any request that reuses the cached build.
		const stub = build.workerId
			? input.env.APP_LOADER.get(build.workerId, () =>
					materializePackageAppWorkerOptions(build.template, requestVisit),
				)
			: input.env.APP_LOADER.load(
					materializePackageAppWorkerOptions(build.template, requestVisit),
				)
		if (build.workerId) {
			schedulePackageAppUniqueWorkerDay({
				env: input.env,
				userId: input.userId,
				workerId: build.workerId,
				surface,
				packageId: input.savedPackage.id,
				packageAppVisitorUserId:
					visitor?.userId ?? input.runtime.callerContext.user?.userId ?? '',
				connectionKey: usageConnectionKey(input.runtime.callerContext.request),
				waitUntil: input.waitUntil,
			})
		}
		return {
			// Stubs are request-bound, so acquire a fresh one per request. The
			// stable worker id (owner + package + commit + mount) lets the
			// loader reuse a warm isolate. Visitor authority rides the ticket.
			stub,
			entrypointName: packageAppEntrypointName,
			visit: requestVisit,
		}
	})
}

function schedulePackageAppUniqueWorkerDay(input: {
	env: Env
	userId: OwnerId
	workerId: string
	surface: 'app_fetch' | 'app_realtime'
	packageId: string
	packageAppVisitorUserId: string
	connectionKey: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const tracked = recordUniqueDynamicWorkerDay({
		env: input.env,
		userId: input.userId,
		workerId: input.workerId,
		surface: input.surface,
		packageId: input.packageId,
		packageAppVisitorUserId: input.packageAppVisitorUserId,
		connectionKey: input.connectionKey,
	}).catch((error: unknown) => {
		console.warn('package-app-dynamic-worker-day-record-failed', error)
	})
	const sink = input.waitUntil ?? scheduleWorkerWaitUntil
	sink(tracked)
}

/**
 * A package app acts as its visitor, bound to the org that owns the app, with
 * the visitor's live role there. An anonymous visitor (internet-visible app)
 * has no user, so the context carries no request and every bridge call that
 * needs an actor fails closed.
 */
export async function createPackageAppCallerContext(input: {
	baseUrl: string
	owner: {
		userId: OwnerId
		/** The owning org's package scope, which is its slug. */
		username: string
		email: string
		displayName?: string
	}
	visitor: RuntimePackageAppVisitor | null
	packageId: string
}) {
	const { visitor } = input
	return createMcpCallerContext({
		baseUrl: input.baseUrl,
		executionOrigin: 'background',
		user: visitor
			? {
					userId: visitor.userId,
					email: input.owner.email,
					username: visitor.username,
					displayName: input.owner.displayName ?? `package:${input.packageId}`,
				}
			: null,
		orgBinding: visitor
			? {
					org: { id: input.owner.userId, slug: input.owner.username },
					role: visitor.role,
				}
			: undefined,
		storageContext: {
			sessionId: null,
			appId: input.packageId,
			packageId: input.packageId,
			storageId: null,
		},
		source: { kind: 'package-app' },
	})
}
