import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import type {
	SessionStuckKind,
	SessionSurface,
} from '#universal/session-analytics.ts'
import { loadOrgSessionAnalyticsState } from './consent.ts'
import {
	labelSessionCategory,
	recordLabelStats,
	workersAiRunner,
	type SessionAiRunner,
} from './labeler.ts'
import { sessionNudgeLine } from './nudges.ts'
import {
	applySessionCall,
	closeSession,
	findOpenSession,
	isSessionExpired,
	newOpenSession,
	saveOpenSession,
	type OpenSession,
	type SessionLink,
} from './store.ts'

type MemoryContext = {
	task?: string
	query?: string
	entities?: ReadonlyArray<string>
	constraints?: ReadonlyArray<string>
}

type ToolResultLike = {
	content?: Array<{ type: string; text?: string }> | unknown
	structuredContent?: unknown
	isError?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

/**
 * Map a failed tool result to the closed error-kind enum. The message is
 * read here to pick a kind and is not kept.
 */
export function classifyStuckKind(result: ToolResultLike): SessionStuckKind {
	const structured = isRecord(result.structuredContent)
		? result.structuredContent
		: {}
	if (structured.entitlement != null) return 'entitlement'
	const name =
		typeof structured.errorName === 'string' ? structured.errorName : ''
	const message = typeof structured.error === 'string' ? structured.error : ''
	const text = `${name} ${message}`.toLowerCase()
	if (/upgraderequired|plan limit|usage limit|quota|allowance/.test(text)) {
		return 'entitlement'
	}
	if (/timeout|timed out|deadline/.test(text)) return 'timeout'
	if (
		/(credential|secret|connection|token).{0,60}(not allowed|denied|not approved|needs approval|refused|forbidden)|host.{0,40}not allowed/.test(
			text,
		)
	) {
		return 'credential_denied'
	}
	if (
		/(credential|secret|connection|api key|token).{0,60}(missing|not found|not saved|not connected|no saved|required|does not exist)|(missing|no|unknown) (credential|secret|connection)/.test(
			text,
		)
	) {
		return 'credential_missing'
	}
	if (
		/not found|does not exist|no such|unknown (package|capability|export)/.test(
			text,
		)
	) {
		return 'not_found'
	}
	if (
		/validation|invalid (input|argument|params)|schema|expected .{0,40}received|must be|is required/.test(
			text,
		)
	) {
		return 'validation'
	}
	if (
		structured.errorDetails != null ||
		/sandbox|syntaxerror|typeerror|referenceerror/.test(text)
	) {
		return 'user_code'
	}
	if (/internal|unavailable|overloaded|storage/.test(text)) return 'platform'
	return 'other'
}

function taskDescription(memoryContext: MemoryContext | undefined) {
	if (!memoryContext) return null
	const parts = [
		memoryContext.task ? `Task: ${memoryContext.task}` : '',
		memoryContext.query ? `Query: ${memoryContext.query}` : '',
		memoryContext.entities?.length
			? `Entities: ${memoryContext.entities.join(', ')}`
			: '',
		memoryContext.constraints?.length
			? `Constraints: ${memoryContext.constraints.join(', ')}`
			: '',
	].filter(Boolean)
	return parts.length > 0 ? parts.join('\n') : null
}

function surfaceOf(callerContext: McpCallerContext): SessionSurface {
	const kind = callerContext.request?.credential.kind
	if (kind === 'cli') return 'cli'
	if (kind === 'api-token') return 'api'
	return 'mcp'
}

type OAuthClientLookup = {
	lookupClient(clientId: string): Promise<{ clientName?: string } | null>
}

/** The connected client's registered name, lowercased and bounded. */
async function resolveClientName(env: Env, callerContext: McpCallerContext) {
	const surface = surfaceOf(callerContext)
	if (surface === 'cli') return 'kody cli'
	if (surface === 'api') return 'api token'
	const clientId = callerContext.oauthClientId
	const helpers = (env as Env & { OAUTH_PROVIDER?: OAuthClientLookup })
		.OAUTH_PROVIDER
	if (!clientId || !helpers) return 'unknown'
	try {
		const client = await helpers.lookupClient(clientId)
		const name = client?.clientName?.trim().toLowerCase().slice(0, 60)
		return name || 'unknown'
	} catch {
		return 'unknown'
	}
}

const packageImportPattern = /kody:(@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*)/g

/** Package names imported by execute code, for the public package lookup. */
export function importedPackageNames(code: string): Array<string> {
	const names = new Set<string>()
	for (const match of code.matchAll(packageImportPattern)) {
		if (match[1]) names.add(match[1])
		if (names.size >= 5) break
	}
	return [...names]
}

/** Ids of the public packages among these names that another org owns. */
async function publicPackageIdsOf(
	db: D1Database,
	orgId: string,
	names: ReadonlyArray<string>,
) {
	if (names.length === 0) return []
	const rows = await db
		.prepare(
			`SELECT id FROM saved_packages
			 WHERE name IN (${names.map(() => '?').join(', ')})
			 AND is_private = 0 AND deleted_at IS NULL AND user_id != ?`,
		)
		.bind(...names, orgId)
		.all<{ id: string }>()
	return rows.results.map((row) => row.id)
}

export type SessionCallInput = {
	env: Env
	callerContext: McpCallerContext
	tool: string
	/** Ids the caller passed or the response returned. Evidence only, never time. */
	links: ReadonlyArray<SessionLink>
	memoryContext?: MemoryContext
	/** Closed search intent task name, when the call was a search. */
	searchTask?: string | null
	/** Package names the call imported. Only public ones are kept, by id. */
	packageNames?: ReadonlyArray<string>
	ai?: SessionAiRunner
	now?: Date
}

type SessionScope = { orgId: string; userId: string }

function scopeOf(callerContext: McpCallerContext): SessionScope | null {
	const request = callerContext.request
	if (!request?.actor) return null
	return { orgId: request.org.id, userId: request.actor.userId }
}

/**
 * The line to add to a failed call's error, or null. Reads the org's choice
 * first: an org that has not opted in gets no read of session state and no
 * nudge. One database read for the org, one for the session, no model.
 */
export async function sessionNudgeForFailure(
	input: Pick<SessionCallInput, 'env' | 'callerContext' | 'tool' | 'links'> & {
		stuckKind: SessionStuckKind
	},
): Promise<string | null> {
	const scope = scopeOf(input.callerContext)
	if (!scope || input.links.length === 0) return null
	const db = input.env.APP_DB
	if ((await loadOrgSessionAnalyticsState(db, scope.orgId)) !== 'enabled') {
		return null
	}
	const session = await findOpenSession(db, { ...scope, links: input.links })
	if (!session || isSessionExpired(session, new Date())) return null
	if (
		session.streakKind !== input.stuckKind ||
		session.streakTool !== input.tool
	) {
		return null
	}
	return sessionNudgeLine({
		stuckKind: input.stuckKind,
		priorStreak: session.streakLength,
	})
}

/**
 * The only writer of session analytics. Returns at once unless the org's
 * choice is `enabled`: no model call, no row, no counter.
 */
export async function recordSessionCall(
	input: SessionCallInput & {
		stuckKind: SessionStuckKind | null
		nudged?: boolean
	},
): Promise<void> {
	const scope = scopeOf(input.callerContext)
	if (!scope) return
	const db = input.env.APP_DB
	if ((await loadOrgSessionAnalyticsState(db, scope.orgId)) !== 'enabled') {
		return
	}
	const now = input.now ?? new Date()
	let session: OpenSession | null = await findOpenSession(db, {
		...scope,
		links: input.links,
	})
	if (session && isSessionExpired(session, now)) {
		await closeSession(db, session)
		session = null
	}
	session ??= newOpenSession({
		...scope,
		clientName: await resolveClientName(input.env, input.callerContext),
		surface: surfaceOf(input.callerContext),
		now,
	})
	session = applySessionCall(
		session,
		{
			tool: input.tool,
			stuckKind: input.stuckKind,
			searchTask: input.searchTask,
			publicPackageIds: await publicPackageIdsOf(
				db,
				scope.orgId,
				input.packageNames ?? [],
			),
			nudged: input.nudged,
		},
		now,
	)
	const declared = taskDescription(input.memoryContext)
	const labelInput =
		session.categorySource === 'memory_context'
			? null
			: declared
				? { task: declared, source: 'memory_context' as const }
				: session.categorySource === 'none' && session.searchTask
					? {
							task: `Task: ${session.searchTask.replaceAll('_', ' ')}`,
							source: 'search_task' as const,
						}
					: null
	if (labelInput) {
		const ai = input.ai ?? workersAiRunner(input.env.AI)
		const labeled = await labelSessionCategory({
			db,
			ai,
			task: labelInput.task,
			now,
		})
		session = {
			...session,
			categoryId: labeled.categoryId ?? session.categoryId,
			categorySource: labelInput.source,
		}
		await recordLabelStats(db, labeled.stats, now)
	}
	await saveOpenSession(db, session, input.links)
}

function conversationLinks(
	...ids: Array<string | null | undefined>
): Array<SessionLink> {
	const keys = new Set(
		ids.map((id) => id?.trim() ?? '').filter((id) => id.length > 0),
	)
	return [...keys].map((key) => ({
		kind: 'conversation',
		key: key.slice(0, 120),
	}))
}

function objectLinks(structured: Record<string, unknown>): Array<SessionLink> {
	const runId = structured.runId
	return typeof runId === 'string' && runId
		? [{ kind: 'object', key: `run:${runId.slice(0, 100)}` }]
		: []
}

/**
 * Run a search or execute call and observe it for session analytics. The
 * write happens after the response. A repeated failure in an opted-in org
 * may get one extra line. Analytics can never fail or change the call
 * otherwise.
 */
export async function observeSessionToolCall<T extends ToolResultLike>(input: {
	env: Env
	callerContext: McpCallerContext
	tool: string
	conversationId?: string | null
	memoryContext?: MemoryContext
	waitUntil?: (promise: Promise<unknown>) => void
	searchTask?: () => string | null
	packageNames?: ReadonlyArray<string>
	run: () => Promise<T>
}): Promise<T> {
	let result = await input.run()
	if (!scopeOf(input.callerContext)) return result
	const structured = isRecord(result.structuredContent)
		? result.structuredContent
		: {}
	const links = [
		...conversationLinks(
			input.conversationId,
			typeof structured.conversationId === 'string'
				? structured.conversationId
				: null,
		),
		...objectLinks(structured),
	]
	const stuckKind = result.isError === true ? classifyStuckKind(result) : null
	let nudged = false
	if (stuckKind && Array.isArray(result.content)) {
		try {
			const line = await sessionNudgeForFailure({
				env: input.env,
				callerContext: input.callerContext,
				tool: input.tool,
				links,
				stuckKind,
			})
			if (line) {
				nudged = true
				result = {
					...result,
					content: [...result.content, { type: 'text', text: line }],
				}
			}
		} catch {
			// A nudge is optional. The error goes out as it was.
		}
	}
	const recorded = recordSessionCall({
		env: input.env,
		callerContext: input.callerContext,
		tool: input.tool,
		links,
		memoryContext: input.memoryContext,
		searchTask: input.searchTask?.() ?? null,
		packageNames: input.packageNames,
		stuckKind,
		nudged,
	}).catch((error: unknown) => {
		console.warn('session-analytics-record-failed', String(error))
	})
	if (input.waitUntil) input.waitUntil(recorded)
	else await recorded
	return result
}
