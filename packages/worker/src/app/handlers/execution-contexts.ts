import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { listTeams } from '#worker/orgs/org-teams-list.ts'
import {
	listOrgsForPerson,
	loadOrgBindingForSlug,
	type OrgBinding,
} from '#worker/orgs/repo.ts'
import { executionContextsFlagKey } from '#universal/feature-flags/registry.ts'
import {
	type ExecutionChain,
	type ExecutionChainEntry,
	type ExecutionChainEntryInput,
	type ExecutionContextAuditPage,
	type ExecutionContextListItem,
	type ExecutionContextRunPage,
	type ExecutionContextShareGrant,
	type ExecutionContextSharing,
	type ExecutionContextsPageData,
	type ExecutionContextUnutilized,
	chainEntryInputs,
	isUnusableReason,
	normalizeChain,
	visibleContexts,
} from '#universal/execution-contexts.ts'

type AppUser = NonNullable<Awaited<ReturnType<typeof readAuthenticatedAppUser>>>

/**
 * The capabilities the website calls. They ship in the execution contexts API
 * PR; until a deployment carries them, the page renders its feature-off view.
 */
export const executionContextCapabilityNames = {
	list: 'executionContextList',
	get: 'executionContextGet',
	optIn: 'executionContextOptIn',
	optOut: 'executionContextOptOut',
	chainGet: 'executionChainGet',
	chainSet: 'executionChainSet',
	runList: 'executionContextRunList',
	auditList: 'executionContextAuditList',
	shareList: 'executionContextShareList',
	shareSet: 'executionContextShareSet',
	shareRemove: 'executionContextShareRemove',
} as const

type CapabilityName =
	(typeof executionContextCapabilityNames)[keyof typeof executionContextCapabilityNames]

export type ExecutionContextsScope = {
	ctx: CapabilityContext
	org: OrgBinding['org']
	personal: boolean
	binding: OrgBinding
}

/** A structured failure from a capability or route: `{ error, ...fields }`. */
export type ExecutionContextFailure = {
	ok: false
	error: string
	message: string
	status?: number
	current?: ExecutionChain
	contextId?: string
	reason?: string
	max?: number
}

export class ExecutionContextsUnavailableError extends Error {
	constructor() {
		super('Execution contexts are not available.')
		this.name = 'ExecutionContextsUnavailableError'
	}
}

export async function loadExecutionContextsScope(input: {
	env: Env
	request: Request
	user: AppUser
	orgSlug: string
}): Promise<ExecutionContextsScope | null> {
	const binding = await loadOrgBindingForSlug(
		input.env.APP_DB,
		input.user.mcpUser.userId,
		input.orgSlug,
	)
	if (!binding) return null
	const callerContext = createMcpCallerContext({
		baseUrl: getAppBaseUrl({ env: input.env, requestUrl: input.request.url }),
		source: { kind: 'session' },
		executionOrigin: 'interactive',
		user: input.user.mcpUser,
		orgBinding: binding,
	})
	return {
		ctx: { env: input.env, callerContext },
		org: binding.org,
		personal: await isPersonalOrg(input.env.APP_DB, binding.org.id),
		binding,
	}
}

export async function executionContextsCapabilitiesAvailable() {
	const registry = await getStaticRegistry()
	return Object.values(executionContextCapabilityNames).every(
		(name) => name in registry.capabilityMap,
	)
}

async function callCapability(
	scope: ExecutionContextsScope,
	name: CapabilityName,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const registry = await getStaticRegistry()
	const capability = registry.capabilityMap[name]
	if (!capability) throw new ExecutionContextsUnavailableError()
	const result = await capability.handler(args, scope.ctx)
	return result && typeof result === 'object'
		? (result as Record<string, unknown>)
		: {}
}

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

/**
 * Normalize a thrown capability error into `{ error, ...fields }`. The API
 * contract carries codes as `error` (`chain_changed`) with extra fields
 * (`current`, `contextId`, `reason`, `max`); authorization denials carry
 * `code` (`credential_scope`, `not_granted`).
 */
export function readExecutionContextFailure(
	error: unknown,
): ExecutionContextFailure | null {
	if (error instanceof ExecutionContextsUnavailableError) {
		return { ok: false, error: 'feature_disabled', message: error.message }
	}
	const value = record(error)
	if (!value) return null
	const details = record(value.details) ?? record(value.body) ?? {}
	const nested = record(details.error)
	const code =
		(typeof value.error === 'string' && value.error) ||
		(typeof details.error === 'string' && details.error) ||
		(nested && typeof nested.code === 'string' && nested.code) ||
		(typeof value.code === 'string' && value.code) ||
		(typeof details.code === 'string' && details.code) ||
		null
	if (!code) return null
	const message =
		error instanceof Error
			? error.message
			: typeof value.message === 'string'
				? value.message
				: code
	const fields = { ...details, ...nested, ...value }
	const string = (key: string) =>
		typeof fields[key] === 'string' ? (fields[key] as string) : undefined
	const contextId = string('contextId')
	const reason = string('reason')
	return {
		ok: false,
		error: code,
		message,
		...(typeof value.status === 'number' ? { status: value.status } : {}),
		...(fields.current ? { current: parseChain(fields.current) } : {}),
		...(contextId ? { contextId } : {}),
		...(reason ? { reason } : {}),
		...(typeof fields.max === 'number' ? { max: fields.max } : {}),
	}
}

export function parseChain(value: unknown): ExecutionChain {
	const chain = record(value) ?? {}
	const entries = Array.isArray(chain.entries)
		? chain.entries
		: [{ kind: 'cloud' }]
	const updatedBy = record(chain.updatedBy)
	return {
		entries: normalizeChain(
			entries.flatMap((entry): Array<ExecutionChainEntry> => {
				const item = record(entry)
				if (!item) return []
				if (item.kind === 'cloud') return [{ kind: 'cloud' }]
				if (item.kind !== 'context' || typeof item.id !== 'string') return []
				return [
					{
						kind: 'context',
						id: item.id,
						usable: item.usable !== false,
						...(isUnusableReason(item.unusableReason)
							? { unusableReason: item.unusableReason }
							: {}),
					},
				]
			}),
		),
		strict:
			typeof chain.strict === 'boolean'
				? chain.strict
				: !entries.some((entry) => record(entry)?.kind === 'cloud'),
		updatedAt: typeof chain.updatedAt === 'string' ? chain.updatedAt : null,
		updatedBy:
			updatedBy && typeof updatedBy.label === 'string'
				? {
						kind: updatedBy.kind === 'agent' ? 'agent' : 'user',
						label: updatedBy.label,
					}
				: null,
	}
}

function parseUnutilized(value: unknown): ExecutionContextUnutilized | null {
	const unutilized = record(value)
	if (
		!unutilized ||
		typeof unutilized.count !== 'number' ||
		unutilized.count <= 0
	)
		return null
	return unutilized as ExecutionContextUnutilized
}

function readContexts(result: Record<string, unknown>) {
	const list = result.contexts ?? result.items ?? result.executionContexts
	return Array.isArray(list) ? (list as Array<ExecutionContextListItem>) : []
}

function readContext(result: Record<string, unknown>) {
	return (record(result.context) ??
		(typeof result.id === 'string'
			? result
			: null)) as ExecutionContextListItem | null
}

export async function loadExecutionContextsPageData(input: {
	env: Env
	request: Request
	user: AppUser
	orgSlug: string
	contextId: string | null
}): Promise<ExecutionContextsPageData | { notFound: true }> {
	const { env, user } = input
	const enabled =
		(await isFeatureEnabled(
			env.APP_DB,
			executionContextsFlagKey,
			user.userId,
		)) && (await executionContextsCapabilitiesAvailable())
	if (!enabled) return { enabled: false, orgSlug: input.orgSlug }
	const scope = await loadExecutionContextsScope(input)
	if (!scope) return { notFound: true }
	try {
		const [listResult, chainResult, selectedResult, teams, orgs] =
			await Promise.all([
				callCapability(scope, executionContextCapabilityNames.list, {}),
				callCapability(scope, executionContextCapabilityNames.chainGet, {}),
				input.contextId
					? callCapability(scope, executionContextCapabilityNames.get, {
							id: input.contextId,
						}).catch((error: unknown) => {
							const failure = readExecutionContextFailure(error)
							if (failure?.error === 'not_found' || failure?.status === 404)
								return null
							throw error
						})
					: Promise.resolve(null),
				scope.personal
					? Promise.resolve([])
					: listTeams(env.APP_DB, scope.org.id),
				listOrgsForPerson(env.APP_DB, user.mcpUser.userId),
			])
		const orgSlug = scope.org.slug ?? input.orgSlug
		const contexts = visibleContexts(readContexts(listResult), Date.now())
		const selected = selectedResult ? readContext(selectedResult) : null
		return {
			enabled: true,
			orgSlug,
			personalOrg: scope.personal,
			teams: teams.map((team) => ({
				slug: team.slug,
				name: team.name,
				orgSlug,
			})),
			attachableOrgs: orgs
				.filter((org) => org.id !== scope.org.id && org.role === 'owner')
				.map((org) => ({ slug: org.slug })),
			contexts: selected
				? contexts.map((context) =>
						context.id === selected.id ? { ...context, ...selected } : context,
					)
				: contexts,
			chain: parseChain(record(chainResult.chain) ?? chainResult),
			unutilized:
				parseUnutilized(listResult.unutilized) ??
				parseUnutilized(chainResult.unutilized),
			selected,
			selectedMissing:
				input.contextId !== null &&
				!selected &&
				!contexts.some((context) => context.id === input.contextId),
		}
	} catch (error) {
		if (readExecutionContextFailure(error)?.error === 'feature_disabled') {
			return { enabled: false, orgSlug: input.orgSlug }
		}
		throw error
	}
}

type ScopedInput = {
	env: Env
	request: Request
	user: AppUser
	orgSlug: string
}

async function runScoped<T>(
	input: ScopedInput,
	run: (scope: ExecutionContextsScope) => Promise<T>,
): Promise<T | ExecutionContextFailure> {
	const scope = await loadExecutionContextsScope(input)
	if (!scope)
		return { ok: false, error: 'not_found', message: 'Organization not found.' }
	try {
		return await run(scope)
	} catch (error) {
		const failure = readExecutionContextFailure(error)
		if (failure) return failure
		throw error
	}
}

export async function optIntoExecutionContextForUser(
	input: ScopedInput & { contextId: string },
) {
	return runScoped(input, async (scope) => {
		const result = await callCapability(
			scope,
			executionContextCapabilityNames.optIn,
			{ id: input.contextId },
		)
		return {
			ok: true as const,
			optedIn: result.optedIn !== false,
			usable: result.usable !== false,
		}
	})
}

export async function optOutOfExecutionContextForUser(
	input: ScopedInput & { contextId: string },
) {
	return runScoped(input, async (scope) => {
		const result = await callCapability(
			scope,
			executionContextCapabilityNames.optOut,
			{ id: input.contextId },
		)
		return {
			ok: true as const,
			optedIn: false as const,
			chainChanged: result.chainChanged === true,
			chain: result.chain ? parseChain(result.chain) : null,
		}
	})
}

export async function setExecutionChainForUser(
	input: ScopedInput & {
		entries: Array<ExecutionChainEntryInput>
		strict: boolean
		ifMatch: string | null
	},
) {
	return runScoped(input, async (scope) => {
		const result = await callCapability(
			scope,
			executionContextCapabilityNames.chainSet,
			{
				entries: chainEntryInputs(normalizeChain(input.entries)),
				strict: input.strict,
				ifMatch: input.ifMatch,
			},
		)
		return {
			ok: true as const,
			chain: parseChain(record(result.chain) ?? result),
			unutilized: parseUnutilized(result.unutilized),
		}
	})
}

export async function listExecutionContextRunsForUser(
	input: ScopedInput & {
		contextId: string
		cursor?: string
		requester?: string
		outcome?: string
	},
) {
	return runScoped(input, async (scope) => {
		const result = await callCapability(
			scope,
			executionContextCapabilityNames.runList,
			{
				id: input.contextId,
				limit: 20,
				...(input.cursor ? { cursor: input.cursor } : {}),
				...(input.requester ? { requester: input.requester } : {}),
				...(input.outcome ? { outcome: input.outcome } : {}),
			},
		)
		const page: ExecutionContextRunPage = {
			runs: Array.isArray(result.runs)
				? (result.runs as ExecutionContextRunPage['runs'])
				: [],
			nextCursor:
				typeof result.nextCursor === 'string' ? result.nextCursor : null,
			scope: result.scope === 'all' ? 'all' : 'own',
		}
		return { ok: true as const, page }
	})
}

export async function listExecutionContextAuditForUser(
	input: ScopedInput & { contextId: string; cursor?: string },
) {
	return runScoped(input, async (scope) => {
		const result = await callCapability(
			scope,
			executionContextCapabilityNames.auditList,
			{
				id: input.contextId,
				limit: 20,
				...(input.cursor ? { cursor: input.cursor } : {}),
			},
		)
		const page: ExecutionContextAuditPage = {
			events: Array.isArray(result.events)
				? (result.events as ExecutionContextAuditPage['events'])
				: [],
			nextCursor:
				typeof result.nextCursor === 'string' ? result.nextCursor : null,
		}
		return { ok: true as const, page }
	})
}

function readSharing(result: Record<string, unknown>): ExecutionContextSharing {
	const sharing = record(result.sharing) ?? result
	return {
		level:
			sharing.level === 'people' ||
			sharing.level === 'team' ||
			sharing.level === 'org'
				? sharing.level
				: 'only_me',
		grants: Array.isArray(sharing.grants)
			? (sharing.grants as Array<ExecutionContextShareGrant>)
			: [],
		attachedOrgs: Array.isArray(sharing.attachedOrgs)
			? (sharing.attachedOrgs as ExecutionContextSharing['attachedOrgs'])
			: [],
		allMembers: sharing.allMembers === true,
	}
}

export async function setExecutionContextShareForUser(
	input: ScopedInput & {
		contextId: string
		subject:
			| { kind: 'user'; usernameOrEmail: string }
			| { kind: 'team'; slug: string }
			| { kind: 'org' }
		preset: 'use' | 'contribute' | 'manage'
	},
) {
	return runScoped(input, async (scope) => {
		const result = await callCapability(
			scope,
			executionContextCapabilityNames.shareSet,
			{
				id: input.contextId,
				...(input.subject.kind === 'user'
					? { user: input.subject.usernameOrEmail }
					: input.subject.kind === 'team'
						? { team: input.subject.slug }
						: { orgWide: true }),
				preset: input.preset,
			},
		)
		return {
			ok: true as const,
			sharing: readSharing(result),
			notice: typeof result.notice === 'string' ? result.notice : null,
		}
	})
}

export async function removeExecutionContextShareForUser(
	input: ScopedInput & { contextId: string; grantId: string },
) {
	return runScoped(input, async (scope) => {
		const result = await callCapability(
			scope,
			executionContextCapabilityNames.shareRemove,
			{ id: input.contextId, grantId: input.grantId },
		)
		return { ok: true as const, sharing: readSharing(result) }
	})
}
