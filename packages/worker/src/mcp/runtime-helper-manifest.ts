import {
	resolveProvider,
	type ResolvedProvider,
	type ToolProvider,
} from '@cloudflare/codemode'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	entitlementEmailForOwner,
	ownerIdFromCaller,
} from '#worker/request-context/owner-id.ts'
import {
	createExecuteHelperPrelude,
	getExecuteHelperCapabilityNames,
} from '#mcp/execute-modules/kody-runtime-utils.ts'
import {
	createPackageStorageHelperPrelude,
	createPackageStorageKodyTools,
} from '#worker/storage-runner.ts'
import { type PackageWorkflowCreateInput } from '#worker/package-runtime/package-workflows.ts'
import { type ComputedPackageImportTools } from '#worker/package-runtime/computed-package-import.ts'
import {
	type PackageStaticCallMeterInput,
	type PackageStaticCallMeterTools,
} from '#worker/usage/package-static-call-usage.ts'
import { staticCallMeterRuntimeBridgeProviderName } from '#mcp/evaluation-side-effects.ts'
import { takeSecretAuthorityFromCapabilityArgs } from '#mcp/secrets/secret-authority.ts'
import { kodyCallDispatcherName } from '#worker/kody-evaluate-bindings.ts'
import { type CredentialCallMap } from '#worker/credentials/credential-call-map.ts'
import { type SavedCredentialNeed } from '#worker/credentials/credential-needs.ts'
import {
	type PackageAppCredentialAuthority,
	type RunCredentialEntries,
} from '#worker/credentials/credential-client.ts'
import { type OwnerCredentialScope } from '#worker/credentials/owner-credential-for-visitors.ts'
import { createCredentialClientKodyTools } from './credential-client-tools.ts'
import { createCredentialClientRuntimeSource } from './execute-modules/credential-client-source.ts'

export type AdditionalKodyTools = Record<
	string,
	(args: unknown) => Promise<unknown>
>

export type PackageStorageToolOptions = {
	/**
	 * Saved-package UUIDs whose buckets `packageStorage()` may reach in this
	 * run. Must come from bundler-controlled provenance only (own package
	 * context plus recorded bundle dependency metadata); see
	 * `collectPackageStorageGrantIds`.
	 */
	grantedPackageIds: ReadonlySet<string>
	/**
	 * The run's own package id (null for ad hoc execute). Unbound calls may
	 * reach only this package's bucket (GHSA-5fv3).
	 */
	runPackageId?: string | null
}

export type PackageSecretToolOptions = {
	/**
	 * Opaque `{{secret:…}}` placeholder after mount + grant checks. Never
	 * decrypted plaintext — only platform use sites resolve it.
	 */
	get: (alias: string, packageId?: string | null) => Promise<string>
	has: (alias: string, packageId?: string | null) => Promise<boolean>
	/**
	 * Run package id for the unstamped `packageSecrets` binding. Null on
	 * ad hoc execute so unstamped entry code stays unbound while stamped
	 * imports still reach the factory.
	 */
	runPackageId?: string | null
}

export type CredentialClientToolOptions = {
	/** The run (or CapabilityProxy credential) client handles are bound to. */
	binding: string
	/**
	 * The package whose needs and sharing apply to a client open: the run's
	 * package when hosted; for CapabilityProxy, a package id the call claims,
	 * verified per call. Null for ad hoc code.
	 */
	resolvePackageId: (requested: unknown) => Promise<string | null>
	/** The caller's credential picks for this run, by need key. */
	callMap?: CredentialCallMap | null
	/** The run's pinned needs by key (hosted runs only). */
	runNeeds?: () => Promise<ReadonlyMap<string, SavedCredentialNeed>>
	/**
	 * The run's entry packages for mapping selection, from the host: the run
	 * package context when hosted; for CapabilityProxy, the entries signed
	 * into the verified package binding the call claims.
	 */
	runEntries?: (requested: unknown) => Promise<RunCredentialEntries | null>
	/** Package-app runs only; see `CredentialClientContext.ownerCredentialScope`. */
	ownerCredentialScope?: OwnerCredentialScope | null
	/** Package-app runs only; see `CredentialClientContext.packageAppAuthority`. */
	packageAppAuthority?: PackageAppCredentialAuthority | null
	waitUntil?: (promise: Promise<unknown>) => void
}

export type EmailToolOptions = {
	getMessage: (messageId: string) => Promise<unknown>
	getAttachment: (attachmentId: string) => Promise<unknown>
}

export type PackageInvokeOptions = {
	exportName?: string
	params?: Record<string, unknown>
	idempotencyKey?: string
	topic?: string
}

export type KodyPrefixedPackageInvokeSpecifier = `kody:@${string}/${string}`
/**
 * @deprecated Add the `kody:` prefix. Use
 * `kody:@owner/package[/export]` for new and migrated calls.
 */
export type PrefixlessPackageInvokeSpecifier = `@${string}/${string}`

export type PackageInvokeInput = {
	specifier:
		| KodyPrefixedPackageInvokeSpecifier
		| PrefixlessPackageInvokeSpecifier
	options?: PackageInvokeOptions
}

export type { ComputedPackageImportTools }

export type PackageInvokeNormalizedInput = {
	specifier: string
	exportName: string
	params?: Record<string, unknown>
	idempotencyKey?: string
	topic?: string
}

export type PackageInvokeContract = {
	packageId: string
	kodyId: string
	name: string
	sourceId: string
	publishedCommit: string | null
	exportName: string
	runtimeTarget: string | null
	description?: string | null
	typeDefinition?: string | null
	warnings: Array<string>
}

export type PackageInvokeCheckResult =
	| {
			ok: true
			invoke: PackageInvokeNormalizedInput
			contract: PackageInvokeContract
	  }
	| {
			ok: false
			message: string
			problems: Array<string>
			contract?: Partial<PackageInvokeContract>
	  }

export type PackageEventDispatchInput = {
	topic?: unknown
	idempotencyKey?: unknown
	payload?: unknown
}

export type PackageEventTools = {
	dispatch: (input: PackageEventDispatchInput) => Promise<unknown>
}

export type PackageWorkflowTools = {
	create: (input: PackageWorkflowCreateInput) => Promise<unknown>
}

type RuntimeHelperAbsentValue = 'undefined' | 'null'

type RuntimeHelperRuntimeBinding = {
	runtimeName: string
	variableName?: string
	absentValue: RuntimeHelperAbsentValue
}

export type RuntimeHelperManifestContext = {
	env: Env
	callerContext: McpCallerContext
	capabilityMap: Record<string, unknown>
	provider?: ResolvedProvider | undefined
	packageStorageTools?: PackageStorageToolOptions | undefined
	packageSecretTools?: PackageSecretToolOptions | undefined
	credentialClientTools?: CredentialClientToolOptions | undefined
	emailTools?: EmailToolOptions | undefined
	workflowTools?: PackageWorkflowTools | undefined
	packageEventTools?: PackageEventTools | undefined
	computedPackageImportTools?: ComputedPackageImportTools | undefined
	staticCallMeterTools?: PackageStaticCallMeterTools | undefined
}

type RuntimeHelperManifestEntry = {
	runtimeName: string
	runtimeBindings: Array<RuntimeHelperRuntimeBinding>
	unboundNames: Array<string>
	isBound: (context: RuntimeHelperManifestContext) => boolean
	/**
	 * When set, overrides `!isBound` for the host-side unbound-helper rewrite.
	 * Use when a prelude is always emitted (stable WorkerCode) but the helper
	 * is still unbound for this run — for example `packageSecrets` on ad hoc
	 * execute, where the package id arrives on evaluate RPC.
	 */
	unboundWhen?: (context: RuntimeHelperManifestContext) => boolean
	createPrelude?: (context: RuntimeHelperManifestContext) => string
	createKodyTools?: (
		context: RuntimeHelperManifestContext,
	) => AdditionalKodyTools | Promise<AdditionalKodyTools>
	extraProviders?: (
		context: RuntimeHelperManifestContext,
	) => Array<ResolvedProvider>
}

export type RuntimeHelperKodyToolSet = {
	runtimeName: string
	tools: AdditionalKodyTools
}

function createPackageSecretsFactoryPrelude() {
	return `
const __kodyPsTrim = String.prototype.trim;
const __kodyPsApply = Reflect.apply;
const __kodyPackageSecrets = (packageId) => ({
  get: async (alias) => {
    const normalizedAlias = typeof alias === 'string' ? __kodyPsApply(__kodyPsTrim, alias, []) : '';
    if (!normalizedAlias) {
      throw new Error('packageSecrets.get requires a non-empty alias.')
    }
    const result = await ${kodyCallDispatcherName}('packageSecretGet', {
      alias: normalizedAlias,
    });
    return typeof result?.value === 'string' ? result.value : '';
  },
  has: async (alias) => {
    const normalizedAlias = typeof alias === 'string' ? __kodyPsApply(__kodyPsTrim, alias, []) : '';
    if (!normalizedAlias) {
      throw new Error('packageSecrets.has requires a non-empty alias.')
    }
    const result = await ${kodyCallDispatcherName}('packageSecretHas', {
      alias: normalizedAlias,
    });
    return result?.has === true;
  },
});
	`.trim()
}

function createPackageSecretsBindingPrelude() {
	return `
const packageSecrets = __kodyTrustedPackageId
  ? __kodyPackageSecrets(__kodyTrustedPackageId)
  : null;
	`.trim()
}

function createCredentialClientPrelude() {
	return `
${createCredentialClientRuntimeSource()}
const { credential, credentials } = __kodyCreateCredentialRuntime(
  (name, args) => ${kodyCallDispatcherName}(name, args),
);
// \`call\` is the package's trusted binding call (GHSA-5fv3). Without one
// the run dispatcher answers as the run package, so no package id is sent.
const __kodyCredentialRuntimeFor = (_packageId, call) =>
  __kodyCreateCredentialRuntime((name, args) =>
    typeof call === 'function'
      ? call(name, args ?? {})
      : ${kodyCallDispatcherName}(name, args ?? {}),
  );
	`.trim()
}

function createEmailHelperPrelude() {
	return `
const email = {
  getMessage: async (messageId) => {
    const normalizedMessageId =
      typeof messageId === 'string' ? messageId.trim() : '';
    if (!normalizedMessageId) {
      throw new Error('email.getMessage requires a non-empty message id.')
    }
    return await ${kodyCallDispatcherName}('emailMessageGet', { message_id: normalizedMessageId });
  },
  getAttachment: async (attachmentId) => {
    const normalizedAttachmentId =
      typeof attachmentId === 'string' ? attachmentId.trim() : '';
    if (!normalizedAttachmentId) {
      throw new Error('email.getAttachment requires a non-empty attachment id.')
    }
    const result = await ${kodyCallDispatcherName}('emailAttachmentGet', {
      attachment_id: normalizedAttachmentId,
    });
    if (!result || typeof result !== 'object') {
      return result;
    }
    if ('content_base64' in result) {
      return result;
    }
    return {
      ...result,
      content_base64:
        typeof result.data_base64 === 'string' ? result.data_base64 : null,
    };
  },
  reply: async (input) => await ${kodyCallDispatcherName}('emailReply', input ?? {}),
};
	`.trim()
}

function createWorkflowsHelperPrelude() {
	return `
const workflows = {
  create: async (input) => await ${kodyCallDispatcherName}('packageWorkflowCreate', input ?? {}),
};
	`.trim()
}

const packageEventRuntimeBridgeProviderName = '__kodyPackageEventRuntimeBridge'
const computedPackageImportRuntimeBridgeProviderName =
	'__kodyComputedPackageImportRuntimeBridge'

// Internal bridge for computed `import(specifier)` of caller-owned `kody:@`
// names. Not an author-facing helper (no unbound-access rewrite name). The
// rewrite guard reads `__kodyComputedPackageImport` from ALS and returns a
// sandbox-local `{ default }` wrapper; the host resolves the importable
// artifact and evaluates the default export with library-load semantics.
function createComputedPackageImportHelperPrelude() {
	return `
const __kodyComputedPackageImport = {
  callDefault: async (input) =>
    await ${computedPackageImportRuntimeBridgeProviderName}.callDefault(input ?? {}),
};
	`.trim()
}

function createEventsHelperPrelude() {
	return `
const events = {
  dispatch: async (input) => await ${packageEventRuntimeBridgeProviderName}.dispatch(input ?? {}),
};
	`.trim()
}

// Internal bridge for the static package export call meter in the runtime
// module (`__kodyMeterStaticPackageExport`): not an author-facing helper,
// so it has no unbound-access rewrite name. Per-call reporting is a
// synchronous buffer push (the call path never awaits and never throws);
// the run wrapper awaits one `flush` bridge call at the end of the run,
// while the sandbox RPC dispatchers are still live — a fire-and-forget RPC
// per call would race dispatcher teardown and drop events. The cumulative
// cap bounds memory, the flush payload, and — most importantly — the
// Analytics Engine budget: Workers Analytics Engine allows 250
// `writeDataPoint` calls per invocation and each event is one data point,
// so 200 leaves headroom for the run's other usage events. Calls past the
// cap in one run are dropped (mirror the cap host-side in
// `createPackageStaticCallMeterTools`).
function createStaticCallMeterHelperPrelude() {
	return `
let __kodyStaticCallMeterReportedCount = 0;
const __kodyStaticCallMeterEvents = [];
const __kodyStaticCallMeter = {
  report: (event) => {
    if (__kodyStaticCallMeterReportedCount >= 200) return;
    __kodyStaticCallMeterReportedCount += 1;
    __kodyStaticCallMeterEvents.push(event);
  },
  // Flush in rounds: async calls that settle while a flush RPC is in
  // flight land in the buffer afterwards, so loop (bounded) until the
  // buffer stays empty. Calls still pending when the run's entrypoint has
  // finished are not metered — metering never extends a run's lifetime,
  // and a dangling promise may never settle inside the sandbox at all.
  flush: async () => {
    for (let round = 0; round < 3; round += 1) {
      if (__kodyStaticCallMeterEvents.length === 0) return;
      const events = __kodyStaticCallMeterEvents.splice(0, __kodyStaticCallMeterEvents.length);
      await ${staticCallMeterRuntimeBridgeProviderName}.record({ events });
    }
  },
};
	`.trim()
}

function readPackageSecretToolInput(args: unknown) {
	const { args: peeled, requestedPackageId } =
		takeSecretAuthorityFromCapabilityArgs([args])
	const first = peeled[0]
	const alias =
		typeof first === 'object' && first !== null && 'alias' in first
			? String((first as { alias: unknown }).alias ?? '')
			: ''
	return { alias, requestedPackageId }
}

function createPackageSecretKodyTools(
	packageSecretTools: PackageSecretToolOptions,
): AdditionalKodyTools {
	return {
		packageSecretGet: async (args: unknown) => {
			const { alias, requestedPackageId } = readPackageSecretToolInput(args)
			return {
				value: await packageSecretTools.get(alias, requestedPackageId),
			}
		},
		packageSecretHas: async (args: unknown) => {
			const { alias, requestedPackageId } = readPackageSecretToolInput(args)
			return {
				has: await packageSecretTools.has(alias, requestedPackageId),
			}
		},
	}
}

function createEmailKodyTools(
	context: RuntimeHelperManifestContext,
	emailTools: EmailToolOptions,
): AdditionalKodyTools {
	return {
		...(context.capabilityMap.emailMessageGet
			? {}
			: {
					emailMessageGet: async (args: unknown) => {
						const messageId =
							typeof args === 'object' && args !== null && 'message_id' in args
								? String((args as { message_id: unknown }).message_id ?? '')
								: ''
						return await emailTools.getMessage(messageId)
					},
				}),
		...(context.capabilityMap.emailAttachmentGet
			? {}
			: {
					emailAttachmentGet: async (args: unknown) => {
						const attachmentId =
							typeof args === 'object' &&
							args !== null &&
							'attachment_id' in args
								? String(
										(args as { attachment_id: unknown }).attachment_id ?? '',
									)
								: ''
						return await emailTools.getAttachment(attachmentId)
					},
				}),
	}
}

function createWorkflowKodyTools(
	workflowTools: PackageWorkflowTools,
): AdditionalKodyTools {
	return {
		packageWorkflowCreate: async (args: unknown) =>
			await workflowTools.create(args as PackageWorkflowCreateInput),
	}
}

function createPackageEventRuntimeBridgeProvider(
	packageEventTools: PackageEventTools,
): ResolvedProvider {
	const provider: ToolProvider = {
		name: packageEventRuntimeBridgeProviderName,
		tools: {
			dispatch: {
				execute: async (args: unknown) =>
					await packageEventTools.dispatch(
						(args ?? {}) as PackageEventDispatchInput,
					),
			},
		},
	}
	return resolveProvider(provider)
}

function createStaticCallMeterRuntimeBridgeProvider(
	staticCallMeterTools: PackageStaticCallMeterTools,
): ResolvedProvider {
	const provider: ToolProvider = {
		name: staticCallMeterRuntimeBridgeProviderName,
		tools: {
			record: {
				execute: async (args: unknown) =>
					await staticCallMeterTools.record(
						(args ?? {}) as PackageStaticCallMeterInput,
					),
			},
		},
	}
	return resolveProvider(provider)
}

function createComputedPackageImportRuntimeBridgeProvider(
	computedPackageImportTools: ComputedPackageImportTools,
): ResolvedProvider {
	const provider: ToolProvider = {
		name: computedPackageImportRuntimeBridgeProviderName,
		tools: {
			callDefault: {
				execute: async (args: unknown) =>
					await computedPackageImportTools.callDefault(
						(args ?? {}) as {
							specifier: string
							params?: Record<string, unknown>
						},
					),
			},
		},
	}
	return resolveProvider(provider)
}

function providerExposesExecuteHelperCapabilities(provider: ResolvedProvider) {
	return getExecuteHelperCapabilityNames().every((name) => name in provider.fns)
}

const runtimeHelperManifest: Array<RuntimeHelperManifestEntry> = [
	{
		runtimeName: 'execute',
		runtimeBindings: [
			{ runtimeName: 'createAuthenticatedFetch', absentValue: 'undefined' },
			{ runtimeName: 'secretHeaders', absentValue: 'undefined' },
			{ runtimeName: 'oauthClientCredentials', absentValue: 'undefined' },
		],
		unboundNames: [
			'createAuthenticatedFetch',
			'secretHeaders',
			'oauthClientCredentials',
		],
		isBound: (context) =>
			context.provider
				? providerExposesExecuteHelperCapabilities(context.provider)
				: false,
		createPrelude: () => createExecuteHelperPrelude(),
	},
	{
		runtimeName: 'packageStorage',
		runtimeBindings: [
			{
				runtimeName: '__kodyPackageStorage',
				absentValue: 'undefined',
			},
		],
		unboundNames: [],
		isBound: (context) => Boolean(context.packageStorageTools),
		createPrelude: () => createPackageStorageHelperPrelude(),
		createKodyTools: (context) => {
			const packageStorageTools = context.packageStorageTools
			const ownerId = ownerIdFromCaller(context.callerContext)
			if (!packageStorageTools || !ownerId) return {}
			return createPackageStorageKodyTools({
				env: context.env,
				userId: ownerId,
				email: entitlementEmailForOwner(context.callerContext, ownerId),
				grantedPackageIds: packageStorageTools.grantedPackageIds,
				runPackageId: packageStorageTools.runPackageId ?? null,
			})
		},
	},
	{
		runtimeName: 'packageSecretsFactory',
		runtimeBindings: [
			{ runtimeName: '__kodyPackageSecrets', absentValue: 'undefined' },
		],
		unboundNames: [],
		isBound: (context) => Boolean(context.packageSecretTools),
		createPrelude: () => createPackageSecretsFactoryPrelude(),
		createKodyTools: (context) =>
			context.packageSecretTools
				? createPackageSecretKodyTools(context.packageSecretTools)
				: {},
	},
	{
		runtimeName: 'packageSecrets',
		runtimeBindings: [{ runtimeName: 'packageSecrets', absentValue: 'null' }],
		unboundNames: ['packageSecrets'],
		isBound: (context) => Boolean(context.packageSecretTools),
		unboundWhen: (context) => !context.packageSecretTools?.runPackageId,
		createPrelude: () => createPackageSecretsBindingPrelude(),
	},
	{
		runtimeName: 'credential',
		runtimeBindings: [
			{ runtimeName: 'credential', absentValue: 'undefined' },
			{ runtimeName: 'credentials', absentValue: 'undefined' },
			{ runtimeName: '__kodyCredentialRuntimeFor', absentValue: 'undefined' },
		],
		unboundNames: ['credential', 'credentials'],
		isBound: (context) => Boolean(context.credentialClientTools),
		createPrelude: () => createCredentialClientPrelude(),
		createKodyTools: (context) =>
			context.credentialClientTools
				? createCredentialClientKodyTools({
						env: context.env,
						callerContext: context.callerContext,
						options: context.credentialClientTools,
					})
				: {},
	},
	{
		runtimeName: 'email',
		runtimeBindings: [{ runtimeName: 'email', absentValue: 'null' }],
		unboundNames: ['email'],
		isBound: (context) => Boolean(context.emailTools),
		createPrelude: () => createEmailHelperPrelude(),
		createKodyTools: (context) =>
			context.emailTools
				? createEmailKodyTools(context, context.emailTools)
				: {},
	},
	{
		runtimeName: 'workflows',
		runtimeBindings: [{ runtimeName: 'workflows', absentValue: 'null' }],
		unboundNames: ['workflows'],
		isBound: (context) => Boolean(context.workflowTools),
		createPrelude: () => createWorkflowsHelperPrelude(),
		createKodyTools: (context) =>
			context.workflowTools
				? createWorkflowKodyTools(context.workflowTools)
				: {},
	},
	{
		runtimeName: 'packages',
		runtimeBindings: [{ runtimeName: 'packages', absentValue: 'null' }],
		unboundNames: ['packages'],
		isBound: () => false,
	},
	{
		runtimeName: 'computedPackageImport',
		runtimeBindings: [
			{
				runtimeName: '__kodyComputedPackageImport',
				absentValue: 'undefined',
			},
		],
		unboundNames: [],
		isBound: (context) => Boolean(context.computedPackageImportTools),
		createPrelude: () => createComputedPackageImportHelperPrelude(),
		extraProviders: (context) =>
			context.computedPackageImportTools
				? [
						createComputedPackageImportRuntimeBridgeProvider(
							context.computedPackageImportTools,
						),
					]
				: [],
	},
	{
		runtimeName: 'events',
		runtimeBindings: [{ runtimeName: 'events', absentValue: 'null' }],
		unboundNames: ['events'],
		isBound: (context) => Boolean(context.packageEventTools),
		createPrelude: () => createEventsHelperPrelude(),
		extraProviders: (context) =>
			context.packageEventTools
				? [createPackageEventRuntimeBridgeProvider(context.packageEventTools)]
				: [],
	},
	{
		runtimeName: 'staticCallMeter',
		runtimeBindings: [
			{ runtimeName: '__kodyStaticCallMeter', absentValue: 'undefined' },
		],
		unboundNames: [],
		isBound: (context) => Boolean(context.staticCallMeterTools),
		createPrelude: () => createStaticCallMeterHelperPrelude(),
		extraProviders: (context) =>
			context.staticCallMeterTools
				? [
						createStaticCallMeterRuntimeBridgeProvider(
							context.staticCallMeterTools,
						),
					]
				: [],
	},
]

const runtimeHelperRuntimeBindingOrder: Array<string> = [
	'storage',
	'packageStorage',
	'execute',
	'packageSecretsFactory',
	'packageSecrets',
	'credential',
	'email',
	'workflows',
	'packages',
	'computedPackageImport',
	'events',
	'staticCallMeter',
]

function runtimeHelperRuntimeBindings() {
	const entriesByName = new Map(
		runtimeHelperManifest.map((entry) => [entry.runtimeName, entry]),
	)
	return runtimeHelperRuntimeBindingOrder.flatMap((runtimeName) => {
		const entry = entriesByName.get(runtimeName)
		return entry?.runtimeBindings ?? []
	})
}

export async function createRuntimeHelperKodyToolSets(
	context: RuntimeHelperManifestContext,
): Promise<Array<RuntimeHelperKodyToolSet>> {
	const toolSets: Array<RuntimeHelperKodyToolSet> = []
	for (const entry of runtimeHelperManifest) {
		if (!entry.createKodyTools) continue
		const tools = entry.isBound(context)
			? await entry.createKodyTools(context)
			: {}
		toolSets.push({
			runtimeName: entry.runtimeName,
			tools,
		})
	}
	return toolSets
}

export function createRuntimeHelperPreludes(
	context: RuntimeHelperManifestContext,
): Array<string> {
	return runtimeHelperManifest.flatMap((entry) => {
		if (!entry.createPrelude || !entry.isBound(context)) return []
		return [entry.createPrelude(context)]
	})
}

export function createRuntimeHelperRuntimePropertySource() {
	return runtimeHelperRuntimeBindings()
		.map((binding) => {
			const variableName = binding.variableName ?? binding.runtimeName
			return `    ${binding.runtimeName}: typeof ${variableName} === 'undefined' ? ${binding.absentValue} : ${variableName},`
		})
		.join('\n')
}

export function createUnboundOptionalRuntimeHelperNames(
	context: RuntimeHelperManifestContext,
) {
	return new Set(
		runtimeHelperManifest.flatMap((entry) => {
			const unbound = entry.unboundWhen
				? entry.unboundWhen(context)
				: !entry.isBound(context)
			return unbound ? entry.unboundNames : []
		}),
	)
}

export function createRuntimeHelperExtraProviders(
	context: RuntimeHelperManifestContext,
) {
	return runtimeHelperManifest.flatMap((entry) =>
		entry.extraProviders && entry.isBound(context)
			? entry.extraProviders(context)
			: [],
	)
}
