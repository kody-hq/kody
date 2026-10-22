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
import { type AuthoredPackageJson } from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	buildKodyFns,
	collectPackageStorageGrantIds,
	type PackageEventTools,
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
import { type OwnerCredentialScope } from '#worker/credentials/owner-credential-for-visitors.ts'
import { type CredentialNeed } from '#worker/credentials/credential-needs.ts'
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
import { getPackageAppBaseUrl } from '#worker/app-base-url.ts'
import { resolvePublicPackageAppLocation } from '#worker/package-app-public-url.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import {
	packageAppSyntheticHeaderName,
	packageAppSyntheticHeaderValue,
} from './package-app-synthetic.ts'
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

const packageAppEntrypointName = 'PackageAppWorker'
const packageAppRuntimeBindingName = 'KODY_RUNTIME'

function createPackageBindingToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	)
}

function createPackageAppWorkerSource(input: {
	mainModule: string
	rewriteNullPackagesInvoke: boolean
	preloadMcpServerNames: boolean
	/** Package ids that get a trusted per-package binding (the run grant set). */
	packageBindingIds: Array<string>
	/** Per-build bridge capability; lives only in this module's private scope. */
	packageBindingToken: string
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
let __kodyCapturedRuntimeBridge = null;
function __kodyCaptureRuntimeBridge(env) {
	// First capture happens on the first request, before the user module is
	// imported, so later package code cannot swap the binding it calls.
	if (__kodyCapturedRuntimeBridge == null) {
		__kodyCapturedRuntimeBridge = env.${packageAppRuntimeBindingName};
	}
	return __kodyCapturedRuntimeBridge;
}
function __kodyCreateAppPackageBindings(bridge) {
	const map = new __kodyMapCaptured();
	for (let index = 0; index < __kodyPackageBindingIds.length; index += 1) {
		const packageId = __kodyPackageBindingIds[index];
		const token = __kodyPackageBindingToken;
		const boundCapability = async (callInput) =>
			await bridge.packageBoundCall({
				token,
				packageId,
				op: 'capability',
				name: callInput?.name,
				args: callInput?.args ?? {},
			});
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
				}),
			// packageStorage() for this package only (GHSA-5fv3).
			packageStorageCall: async (method, args) =>
				await bridge.packageBoundCall({
					token,
					packageId,
					op: 'packageStorage',
					name: method,
					args: args ?? {},
				}),
			packageSecretGet: async (alias) => {
				const result = await bridge.packageBoundCall({
					token,
					packageId,
					op: 'packageSecretGet',
					alias,
				});
				return typeof result?.value === 'string' ? result.value : '';
			},
			packageSecretHas: async (alias) => {
				const result = await bridge.packageBoundCall({
					token,
					packageId,
					op: 'packageSecretHas',
					alias,
				});
				return result?.has === true;
			},
		});
		__kodyReflectApplyCaptured(__kodyMapSetCaptured, map, [packageId, binding]);
	}
	return map;
}
async function __kodyRunUserCode(env, callback) {
	await __kodyEnsureRuntimeLoaded();
	const bindings = __kodyCreateAppPackageBindings(__kodyCaptureRuntimeBridge(env));
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

function createKodyProxy(runtimeBridge, mcpServerNamesOrLoader) {
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
			return async (args = {}) =>
				await runtimeBridge.callCapability({
					name: property,
					args,
				});
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
	const secretArgs = (alias) => ({ alias });
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
			return await runtimeBridge.workflowCreate(payload);
		},
	};
}

function createEventsProxy(runtimeBridge) {
	return {
		dispatch: async (input) =>
			await runtimeBridge.packageEventDispatch(input ?? {}),
	};
}

function createAuthenticatedFetchHelper(runtimeBridge) {
	return async function createAuthenticatedFetch(providerName) {
		return async (input, init) =>
			await runtimeBridge.authenticatedFetch({
				providerName,
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
			: runtimeBridge.credentialClientCall({ name, args: args ?? {} }),
	);
}

function createRuntime(runtimeBridge, packageContext, mcpServerNamesOrLoader) {
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
		kody: createKodyProxy(runtimeBridge, mcpServerNamesOrLoader),
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
		);
		try {
			consoleCapture.install();
			const response = await __kodyRuntimeStorage.run(runtime, async () => await __kodyRunUserCode(this.env, async () => {
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
			}));
			// Authors (or proxied upstreams) must not set the internal throw
			// marker; only the catch path below may attach it.
			let outgoing = withoutAuthorRuntimeErrorHeader(response);
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
			const result = await __kodyRuntimeStorage.run(runtime, async () => await __kodyRunUserCode(this.env, async () => {
				const userModule = await import(${JSON.stringify(`./${input.mainModule}`)});
				const runtimeEnv = createPackageAppEnv(this.env, userModule);
				const resolved = resolveRealtimeHandler(userModule, payload?.facet);
				if (!resolved) {
					return { actions: [] };
				}
				if (resolved.kind === 'function') {
					return await resolved.exported(payload, runtimeEnv, this.ctx);
				}
				if (resolved.kind === 'bound-method') {
					return await resolved.exported.onRealtimeEvent(payload, runtimeEnv, this.ctx);
				}
				const state = createInternalDurableObjectState(
					runtimeBridge,
					createFacetStorageId(this.env.__kodyPackageContext ?? null, payload?.facet),
				);
				const instance = Object.create(resolved.exported.prototype);
				instance.ctx = state;
				instance.env = runtimeEnv;
				if (typeof instance.onRealtimeEvent !== 'function') {
					throw new Error(\`Package app facet "\${buildFacetName(payload?.facet)}" must implement onRealtimeEvent().\`);
				}
				return await instance.onRealtimeEvent(payload, runtimeEnv, this.ctx);
			}));
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
	/** Who every bridge call acts as; null for an anonymous visitor. */
	visitor: RuntimePackageAppVisitor | null
	email: string
	displayName: string
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string | null
	packageStorageGrantIds: Array<string>
	/**
	 * Run-scoped credential-client binding shared with KodyFetchGateway.
	 * Lives on props (not the entrypoint instance) so open → sign survives
	 * across WorkerEntrypoint RPC invocations.
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
	private packageEventTools: Promise<PackageEventTools> | null = null
	private readonly credentialClientTools = new Map<
		string,
		Promise<AdditionalKodyTools>
	>()
	private readonly secretRedactor: ExecutionSecretRedactor =
		createExecutionSecretRedactor()

	private async createCallerContext(storageId: string | null) {
		const { visitor } = this.ctx.props
		return createMcpCallerContext({
			baseUrl: this.ctx.props.baseUrl,
			executionOrigin: 'background',
			user: visitor
				? {
						userId: visitor.userId,
						email: this.ctx.props.email,
						username: visitor.username,
						displayName: this.ctx.props.displayName,
					}
				: null,
			orgBinding: visitor
				? {
						org: { id: this.ctx.props.userId, slug: this.ctx.props.orgSlug },
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

	private getStorageRunner(storageId: string) {
		return storageRunnerRpc({
			env: this.env,
			userId: this.ctx.props.userId,
			storageId,
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
		return beginRunRecord({
			env: this.env,
			userId: this.ctx.props.userId,
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

	async callCapability(input: { name: string; args?: unknown }) {
		return await this.callCapabilityAs(null, input)
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
	}) {
		const packageId = await this.assertPackageBindingCapability(
			input?.token,
			input?.packageId,
		)
		switch (input.op) {
			case 'capability':
				return await this.callCapabilityAs(packageId, {
					name: String(input.name ?? ''),
					args: input.args,
				})
			case 'packageSecretGet':
				return await this.packageSecretGetAs(
					packageId,
					String(input.alias ?? ''),
				)
			case 'packageSecretHas':
				return await this.packageSecretHasAs(
					packageId,
					String(input.alias ?? ''),
				)
			case 'packageStorage':
				return await this.packageStorageCallAs(
					packageId,
					String(input.name ?? ''),
					input.args,
				)
			case 'credentialClient':
				return await this.credentialClientCallAs(packageId, {
					name: String(input.name ?? ''),
					args: input.args,
				})
			default:
				throw new Error('Unknown package binding operation.')
		}
	}

	async packageBoundFetch(token: string, packageId: string, request: Request) {
		const boundPackageId = await this.assertPackageBindingCapability(
			token,
			packageId,
		)
		const gatewayProps = this.ctx.props.gatewayProps
		if (!gatewayProps || !workerExports?.KodyFetchGateway) {
			return await fetch(request)
		}
		return await workerExports
			.KodyFetchGateway({ props: { ...gatewayProps, boundPackageId } })
			.fetch(request)
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
	) {
		const name = input.name.trim()
		// Discard any caller-supplied authority field (GHSA-5fv3).
		const { args } = takeSecretAuthorityFromCapabilityArgs([input.args ?? {}])
		const requestedPackageId = boundPackageId
		const callerContext = await this.createCallerContext(null)
		const { capabilityMap } = await getCapabilityRegistryForContext({
			env: this.env,
			callerContext,
		})
		const capability = capabilityMap[name]
		if (!capability) {
			throw new Error(`Package app capability "${name}" is not available.`)
		}
		const invoke = () =>
			capability.handler((args[0] ?? {}) as Record<string, unknown>, {
				env: this.env,
				callerContext,
			})
		const grantedPackageIds = new Set(this.ctx.props.packageStorageGrantIds)
		return await runWithSecretAuthorityScope(grantedPackageIds, () =>
			runWithCurrentSecretAuthority(requestedPackageId, invoke),
		)
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
		return await this.getStorageRunner(input.storageId).sqlQuery({
			query: input.query,
			params: input.params,
			writable: input.writable,
		})
	}

	private async setValueWithEntitlement(input: {
		storageId: string
		key: string
		value: unknown
	}) {
		const existing = await this.getStorageRunner(input.storageId).getValue({
			key: input.key,
		})
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
	) {
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
		}
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
		input: { packageId: string; key: string },
	) {
		const packageId = this.resolvePackageStorageOwner(
			input.packageId,
			boundPackageId,
		)
		// Provenance-granted package: buckets intentionally bypass the app
		// namespace lock on raw storage* (assertAppOwnedStorageId).
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
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
		},
	) {
		const packageId = this.resolvePackageStorageOwner(
			input.packageId,
			boundPackageId,
		)
		return await this.getStorageRunner(
			buildPackageStorageId(packageId),
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
		})
	}

	private async packageStorageSetAs(
		boundPackageId: string | null,
		input: {
			packageId: string
			key: string
			value: unknown
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
		request: {
			url: string
			method?: string
			headers?: Record<string, string>
			body?: string
		}
	}) {
		const kody = await buildKodyFns(
			this.env,
			await this.createCallerContext(this.ctx.props.packageId),
		)
		const authenticatedFetch = await createAuthenticatedFetch(
			kody,
			input.providerName,
		)
		return await authenticatedFetch(input.request.url, {
			method: input.request.method,
			headers: input.request.headers,
			body: input.request.body,
		})
	}

	private async resolvePackageSecretMount(input: {
		alias: string
		boundPackageId: string | null
		access?: 'presence' | 'value'
	}) {
		const packageId = this.resolvePackageSecretAuthorityPackageId(
			input.boundPackageId,
		)
		const callerContext = await this.createCallerContext(
			this.ctx.props.packageId,
		)
		return await resolveCredential({
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
		})
	}

	/** Run-package secrets only; caller-supplied ids are ignored (GHSA-5fv3). */
	async packageSecretGet(input: { alias: string }) {
		return await this.packageSecretGetAs(null, String(input?.alias ?? ''))
	}

	private async packageSecretGetAs(
		boundPackageId: string | null,
		alias: string,
	) {
		const input = { alias }
		const resolved = await this.resolvePackageSecretMount({
			alias,
			boundPackageId,
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
	async packageSecretHas(input: { alias: string }) {
		return await this.packageSecretHasAs(null, String(input?.alias ?? ''))
	}

	private async packageSecretHasAs(
		boundPackageId: string | null,
		alias: string,
	) {
		try {
			await this.resolvePackageSecretMount({
				alias,
				boundPackageId,
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

	async workflowCreate(input: unknown) {
		const { request } = await this.createCallerContext(null)
		if (!request)
			throw new Error('workflows.create requires a package app user.')
		return await createDynamicCallableWorkflow({
			env: this.env,
			userId: this.ctx.props.userId,
			userEmail: this.ctx.props.email,
			packageContext: {
				packageId: this.ctx.props.packageId,
				kodyId: this.ctx.props.kodyId,
				sourceId: this.ctx.props.sourceId,
			},
			body: input as PackageWorkflowCreateInput,
			lineage: requestLineage(request),
		})
	}

	async createPackageEventTools() {
		if (this.packageEventTools) return await this.packageEventTools

		// Avoid a top-level package-app -> package-invocations cycle during worker
		// startup; apps only need this helper when package code calls it.
		this.packageEventTools =
			import('#worker/package-invocations/service.ts').then(
				async ({ createPackageEventTools }) => {
					const packageContext = {
						packageId: this.ctx.props.packageId,
						kodyId: this.ctx.props.kodyId,
						sourceId: this.ctx.props.sourceId,
					}
					return createPackageEventTools({
						env: this.env,
						baseUrl: this.ctx.props.baseUrl,
						callerContext: await this.createCallerContext(
							this.ctx.props.packageId,
						),
						packageContext,
						parentRunRecord: null,
						packageInvokeDepth: 0,
					})
				},
			)
		return await this.packageEventTools
	}

	async packageEventDispatch(input: Record<string, unknown>) {
		const tools = await this.createPackageEventTools()
		return await tools.dispatch(input)
	}

	/**
	 * Credential client tools acting as one package (GHSA-5fv3): the package
	 * `packageBoundCall` bound after its capability check, or the app package
	 * for the public bridge. A sandbox-named package id never selects another
	 * package's needs or bound Keys.
	 */
	private async getCredentialClientTools(boundPackageId: string | null = null) {
		const owner = boundPackageId ?? this.ctx.props.packageId
		const cached = this.credentialClientTools.get(owner)
		if (cached) return await cached
		const binding = this.ctx.props.credentialClientBinding
		const tools = (async () => {
			const callerContext = await this.createCallerContext(null)
			let runNeeds: Promise<ReadonlyMap<string, CredentialNeed>> | null = null
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
						})
						return runNeeds
					},
					ownerCredentialScope: packageAppOwnerCredentialScope(this.ctx.props),
					waitUntil: (promise) => {
						this.ctx.waitUntil(promise)
					},
				},
			})
		})()
		this.credentialClientTools.set(owner, tools)
		return await tools
	}

	async credentialClientCall(input: { name: string; args?: unknown }) {
		return await this.credentialClientCallAs(null, input)
	}

	private async credentialClientCallAs(
		boundPackageId: string | null,
		input: { name: string; args?: unknown },
	) {
		const name = String(input.name ?? '').trim()
		const allowed = new Set<string>(Object.values(credentialClientToolNames))
		if (!allowed.has(name)) {
			throw new Error(`Unknown credential client tool "${name}".`)
		}
		const tools = await this.getCredentialClientTools(boundPackageId)
		const tool = tools[name]
		if (typeof tool !== 'function') {
			throw new Error(`Credential client tool "${name}" is not available.`)
		}
		return await tool(input.args ?? {})
	}
}

type PackageAppWorkerOptions = Parameters<Env['APP_LOADER']['load']>[0]

type PackageAppWorkerBuild = {
	workerId: string | null
	workerOptions: PackageAppWorkerOptions
}

// Caches the built worker options (bundle lookup + hydration + wrapper), not
// loader stubs: worker-loader stubs are bound to the request that created them
// and must be re-acquired per request via APP_LOADER.get/load.
const packageAppWorkerOptionsCache =
	new PromiseLruCache<PackageAppWorkerBuild>()

export async function createPackageAppWorkerId(input: {
	cacheKey: string
	workerOptions: PackageAppWorkerOptions
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

function createPackageAppWorkerCacheKey(input: {
	userId: OwnerId
	visitor: RuntimePackageAppVisitor | null
	packageId: string
	kodyId: string
	sourceId: string
	publishedCommit: string | null
	baseUrl: string
	appBasePath: string
	hostedUrl: string
	callerEmail: string
	callerDisplayName: string
}) {
	if (!input.publishedCommit) {
		return null
	}
	return JSON.stringify([
		input.userId,
		input.visitor?.userId ?? null,
		input.visitor?.username ?? null,
		input.visitor?.role ?? null,
		input.packageId,
		input.kodyId,
		input.sourceId,
		input.publishedCommit,
		input.baseUrl,
		input.appBasePath,
		input.hostedUrl,
		input.callerEmail,
		input.callerDisplayName,
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
	savedPackage: { kodyId: string; name: string }
	runtime: {
		servingUsername?: string
		hostedOrigin?: string
		mount?: PackageAppMount
	}
}) {
	const username =
		input.runtime.servingUsername ??
		getUsernameFromPackageName(input.savedPackage.name)
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
	if (canonical) return canonical
	const hostedUrl = resolveHostedPackageAppUrl({
		packageAppBaseUrl: getPackageAppBaseUrl({ env: input.env }),
		appBaseUrl: input.baseUrl,
		username,
		kodyId: urlSlug,
	})
	return {
		appBasePath: new URL(hostedUrl).pathname,
		hostedUrl,
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

async function buildPackageAppWorkerOptionsUncached(input: {
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
}): Promise<PackageAppWorkerOptions> {
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
	// Embedded only in the wrapper's module scope and the bridge props.
	const packageBindingToken = createPackageBindingToken()
	const modules = {
		...hydratedModules,
		[mainModule]: createPackageAppWorkerSource({
			mainModule: bundled.mainModule,
			packageBindingIds: packageStorageGrantIds,
			packageBindingToken,
			rewriteNullPackagesInvoke:
				modulesContainUnboundPackagesInvokeAccess(hydratedModules),
			preloadMcpServerNames: modulesReferenceKodyMcp(bundled.modules),
		}),
	}
	// One binding for this worker-options build (visitor-scoped via the cache
	// key). Props — not WorkerEntrypoint instance fields — carry it so open
	// and sign share the same run binding across RPC invocations, and the
	// fetch gateway can place credential().fetch handles.
	const credentialClientBinding = newRunCredentialClientBinding()
	const packageSecretRefKey = createPackageSecretRefKey()
	const gatewayProps: FetchGatewayProps = {
		baseUrl: input.baseUrl,
		userId: input.userId,
		email: input.runtime.callerContext.user?.email ?? null,
		request: input.runtime.callerContext.request,
		storageContext: {
			sessionId: null,
			appId: input.savedPackage.id,
			packageId: input.savedPackage.id,
			storageId: null,
		},
		grantedSecretAuthorityPackageIds: packageStorageGrantIds,
		credentialClientBinding,
		packageSecretRefKey,
		ownerCredentialScope: packageAppOwnerCredentialScope({
			userId: input.userId,
			packageId: input.savedPackage.id,
			publishedCommit: input.savedPackage.publishedCommit,
		}),
	}
	return {
		...createDynamicWorkerCompatibilityOptions(),
		mainModule,
		modules,
		env: {
			[packageAppRuntimeBindingName]: requireLocalPackageAppRuntimeBridge()({
				props: {
					baseUrl: input.baseUrl,
					userId: input.userId,
					...packageAppVisitorOf(
						input.runtime.callerContext,
						input.runtime.servingUsername,
					),
					email: input.runtime.callerContext.user?.email ?? '',
					displayName:
						input.runtime.callerContext.user?.displayName ??
						`package:${input.savedPackage.id}`,
					packageId: input.savedPackage.id,
					kodyId: input.savedPackage.kodyId,
					sourceId: input.savedPackage.sourceId,
					publishedCommit: input.savedPackage.publishedCommit,
					packageStorageGrantIds,
					credentialClientBinding,
					packageSecretRefKey,
					packageBindingToken,
					gatewayProps,
				},
			}),
			__kodyPackageContext: {
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				sourceId: input.savedPackage.sourceId,
				publishedCommit: input.savedPackage.publishedCommit,
				...publicContext,
				...assetContext,
			},
		},
		globalOutbound: workerExports?.KodyFetchGateway
			? workerExports.KodyFetchGateway({ props: gatewayProps })
			: null,
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
		const cacheKey = createPackageAppWorkerCacheKey({
			userId: input.userId,
			visitor: packageAppVisitorOf(
				input.runtime.callerContext,
				input.runtime.servingUsername,
			).visitor,
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
			publishedCommit: input.savedPackage.publishedCommit,
			baseUrl: input.baseUrl,
			...publicContext,
			callerEmail: input.runtime.callerContext.user?.email ?? '',
			callerDisplayName:
				input.runtime.callerContext.user?.displayName ??
				`package:${input.savedPackage.id}`,
		})
		const surface = input.surface ?? 'app_fetch'
		if (!cacheKey) {
			return {
				stub: input.env.APP_LOADER.load(
					await buildPackageAppWorkerOptionsUncached(input),
				),
				entrypointName: packageAppEntrypointName,
			}
		}
		const build = await packageAppWorkerOptionsCache.getOrCreate({
			cacheKey,
			create: async () => {
				const workerOptions = await buildPackageAppWorkerOptionsUncached(input)
				return {
					workerId: await createPackageAppWorkerId({ cacheKey, workerOptions }),
					workerOptions,
				}
			},
		})
		// Acquire the request-bound stub before claiming the day. A failed
		// `APP_LOADER.get()` must not persist a (day, workerId) that a retry
		// would then skip without a `dynamic_worker_day` event.
		const stub = build.workerId
			? input.env.APP_LOADER.get(build.workerId, () => build.workerOptions)
			: input.env.APP_LOADER.load(build.workerOptions)
		if (build.workerId) {
			schedulePackageAppUniqueWorkerDay({
				env: input.env,
				userId: input.userId,
				workerId: build.workerId,
				surface,
				packageId: input.savedPackage.id,
				connectionKey: usageConnectionKey(input.runtime.callerContext.request),
				waitUntil: input.waitUntil,
			})
		}
		return {
			// Stubs are request-bound, so acquire a fresh one per request. The stable
			// worker id (derived from user + package + commit + caller identity) lets
			// the loader reuse a warm isolate instead of compiling a new worker.
			stub,
			entrypointName: packageAppEntrypointName,
		}
	})
}

function schedulePackageAppUniqueWorkerDay(input: {
	env: Env
	userId: OwnerId
	workerId: string
	surface: 'app_fetch' | 'app_realtime'
	packageId: string
	connectionKey: string
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const tracked = recordUniqueDynamicWorkerDay({
		env: input.env,
		userId: input.userId,
		workerId: input.workerId,
		surface: input.surface,
		packageId: input.packageId,
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
