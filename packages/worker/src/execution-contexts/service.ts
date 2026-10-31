import { experimentOffMessage } from '#universal/feature-flags/experiments.ts'
import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'
import {
	ecpMaxChainContexts,
	type EcpCancelReason,
	type EcpGrant,
} from '@kody-internal/shared/execution-context-protocol/index.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { upsertGrant, softDeleteGrant } from '#worker/orgs/access-writes.ts'
import { chainCloudOrderError, selfShareError } from './chain-rules.ts'
import { ExecutionContextError } from './errors.ts'
import { isExecutionContextsEnabledFor } from './flag.ts'
import {
	ChainConflictError,
	canManageContext,
	canWriteContext,
	chainCounts,
	chainIsTooLong,
	getChain,
	getExecutionContext,
	listOrgExecutionContexts,
	loadContextAccess,
	parseCapabilities,
	parseGrant,
	parsePublicKey,
	removeOptIn,
	resolveExecutionContextRef,
	sessionStub,
	setOptIn,
	unutilizedNamedMax,
	writeChain,
	type ChainEntry,
	type ContextAccess,
	type ExecutionContextRow,
	type UnusableReason,
	executionContextCommandPermission,
} from './store.ts'
import { optInTrustNotice, sharingTrustNotice } from './trust-copy.ts'
import { type RunHistoryRow } from './session-do.ts'
import { kodyCloudTarget } from './routing.ts'
import { latestCliVersion } from './latest-cli-version.ts'
import { isOlderCliVersion } from '#universal/execution-contexts.ts'
import { type RunRecord } from '#worker/run-records/types.ts'

/** Shared logic behind the execution-context MCP capabilities and routes. */

export type ExecutionContextCaller = {
	env: Env
	callerContext: McpCallerContext
	request: RequestContext
	userId: string
	orgId: string
}

export async function requireExecutionContextsCaller(input: {
	env: Env
	callerContext: McpCallerContext
}): Promise<ExecutionContextCaller> {
	const request = input.callerContext.request
	if (!request?.actor) {
		throw new ExecutionContextError({
			status: 401,
			code: 'insufficient_scope',
			message: 'Execution contexts need a signed-in person.',
		})
	}
	if (
		!(await isExecutionContextsEnabledFor(
			input.env.APP_DB,
			request.actor.userId,
			request.org.id,
		))
	) {
		throw new ExecutionContextError({
			status: 403,
			code: 'feature_disabled',
			message: experimentOffMessage('execution-contexts'),
		})
	}
	return {
		env: input.env,
		callerContext: input.callerContext,
		request,
		userId: request.actor.userId,
		orgId: request.org.id,
	}
}

function notFound(): never {
	throw new ExecutionContextError({
		status: 404,
		code: 'not_found',
		message:
			'That execution context was not found in this org. It may have been revoked and removed, or it belongs to another org.',
	})
}

export async function loadVisibleContext(
	caller: ExecutionContextCaller,
	ref: string,
) {
	const row = await resolveExecutionContextRef(
		caller.env.APP_DB,
		caller.orgId,
		ref,
	)
	if (!row) notFound()
	const access = await loadContextAccess(caller.env.APP_DB, row, caller)
	return { row, access }
}

async function handlesFor(db: D1Database, ids: ReadonlyArray<string>) {
	const map = new Map<string, string | null>()
	const unique = [...new Set(ids)]
	if (unique.length === 0) return map
	const rows = await db
		.prepare(
			`SELECT stable_user_id, username FROM users WHERE stable_user_id IN (${unique.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
		)
		.bind(...unique)
		.all<{ stable_user_id: string; username: string | null }>()
	for (const row of rows.results) map.set(row.stable_user_id, row.username)
	return map
}

async function orgSlugsFor(db: D1Database, ids: ReadonlyArray<string>) {
	const map = new Map<string, string | null>()
	const unique = [...new Set(ids)]
	if (unique.length === 0) return map
	const rows = await db
		.prepare(
			`SELECT id, slug FROM orgs WHERE id IN (${unique.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
		)
		.bind(...unique)
		.all<{ id: string; slug: string | null }>()
	for (const row of rows.results) map.set(row.id, row.slug)
	return map
}

export function grantSummary(grant: EcpGrant) {
	return {
		fs: grant.fs.length,
		egress: { mode: grant.egress.mode },
		runtime:
			grant.runtime.mode === 'all'
				? ('all' as const)
				: grant.runtime.paths.length === 0
					? ('none' as const)
					: { mode: 'allowlist' as const, count: grant.runtime.paths.length },
		timeoutMs: grant.limits.timeoutMs,
		commands: grant.commands?.enabled === true,
	}
}

function myPermissions(access: ContextAccess) {
	const permissions: Array<string> = []
	if (access.granted || access.isOperator) permissions.push('read', 'execute')
	if (access.canRunCommands) permissions.push('command')
	if (canWriteContext(access)) permissions.push('write')
	if (canManageContext(access)) permissions.push('delete', 'manage_access')
	return permissions
}

async function liveStatus(env: Env, row: ExecutionContextRow) {
	if (row.revoked_at)
		return {
			status: 'revoked' as const,
			acceptingRuns: false,
			lastSeenAt: null,
		}
	try {
		const status = await sessionStub(env, row.id).getStatus()
		return {
			status: status.revoked
				? ('revoked' as const)
				: status.online
					? ('online' as const)
					: ('offline' as const),
			acceptingRuns: status.acceptingRuns,
			lastSeenAt: status.lastSeenAt ?? null,
		}
	} catch {
		return {
			status: 'offline' as const,
			acceptingRuns: false,
			lastSeenAt: null,
		}
	}
}

export async function formatContexts(
	caller: ExecutionContextCaller,
	rows: ReadonlyArray<ExecutionContextRow>,
	options: { includeSharing?: boolean } = {},
) {
	const db = caller.env.APP_DB
	const [handles, slugs, counts, chain, latestCli] = await Promise.all([
		handlesFor(
			db,
			rows.map((row) => row.operator_user_id),
		),
		orgSlugsFor(
			db,
			rows.map((row) => row.org_id),
		),
		chainCounts(
			db,
			rows.map((row) => row.id),
		),
		getChain(db, caller),
		rows.some((row) => row.client_version)
			? latestCliVersion()
			: Promise.resolve(null),
	])
	const inChain = new Set(
		chain.entries.flatMap((entry) =>
			entry.kind === 'context' ? [entry.id] : [],
		),
	)
	return await Promise.all(
		rows.map(async (row) => {
			const access = await loadContextAccess(db, row, caller)
			const grant = parseGrant(row)
			const live = await liveStatus(caller.env, row)
			const capabilities = parseCapabilities(row)
			const manage = canManageContext(access)
			return {
				id: row.id,
				name: row.name,
				ownerOrg: { id: row.org_id, slug: slugs.get(row.org_id) ?? null },
				operator: { handle: handles.get(row.operator_user_id) ?? null },
				registeredBy: { handle: handles.get(row.operator_user_id) ?? null },
				isOperator: access.isOperator,
				myPermissions: myPermissions(access),
				status: live.status,
				acceptingRuns: live.acceptingRuns,
				lastSeenAt: live.lastSeenAt ?? row.last_seen_at,
				revokedAt: row.revoked_at,
				client: {
					name: row.client_name,
					version: row.client_version,
					latestVersion: latestCli,
					outdated: Boolean(
						(row.client_name === 'kody-cli' ||
							row.client_name === '@kodycodes/cli') &&
						latestCli &&
						row.client_version &&
						isOlderCliVersion(row.client_version, latestCli),
					),
				},
				capabilities: {
					os: capabilities.os ?? null,
					service: capabilities.service ?? null,
					maxConcurrent:
						capabilities.maxConcurrent ?? grant.limits.maxConcurrent,
					features: capabilities.features ?? [],
				},
				grantSummary: grantSummary(grant),
				optedIn: access.optedIn,
				canOptIn:
					!row.revoked_at &&
					access.attached &&
					access.granted &&
					!access.optedIn,
				canAddShares: manage,
				usable: access.usable,
				...(access.unusableReason
					? { unusableReason: access.unusableReason }
					: {}),
				chainUsage: {
					inMyChain: inChain.has(row.id),
					chainCount: counts.get(row.id) ?? 0,
				},
				...(options.includeSharing && (manage || isOrgOwner(caller))
					? { sharing: await loadSharing(caller, row) }
					: {}),
			}
		}),
	)
}

export type ContextView = Awaited<ReturnType<typeof formatContexts>>[number]

function isOrgOwner(caller: ExecutionContextCaller) {
	return caller.request.membership?.role === 'owner'
}

/** Protocol 7.1: usable contexts that are in none of the caller's chain. */
export function unutilizedSummary(views: ReadonlyArray<ContextView>):
	| {
			count: number
			contexts?: Array<{
				id: string
				name: string
				operator: string | null
				needsOptIn: boolean
			}>
			note: string
	  }
	| undefined {
	const unused = views.filter(
		(view) =>
			view.status !== 'revoked' &&
			!view.chainUsage.inMyChain &&
			(view.usable || view.canOptIn),
	)
	if (unused.length === 0) return undefined
	if (unused.length > unutilizedNamedMax) {
		return {
			count: unused.length,
			note: `There are ${unused.length} unutilized execution context registrations.`,
		}
	}
	return {
		count: unused.length,
		contexts: unused.map((view) => ({
			id: view.id,
			name: view.name,
			operator: view.operator.handle,
			needsOptIn: !view.optedIn,
		})),
		note: `Not in your chain: ${unused
			.map((view) => (view.optedIn ? view.name : `${view.name} (opt in first)`))
			.join(
				', ',
			)}. Add one with executionChainSet or \`kody chain add <name>\`.`,
	}
}

export async function listContexts(caller: ExecutionContextCaller) {
	const rows = await listOrgExecutionContexts(caller.env.APP_DB, caller.orgId)
	const views = await formatContexts(caller, rows)
	const visible = views.filter(
		(view) =>
			view.isOperator ||
			view.myPermissions.length > 0 ||
			view.canOptIn ||
			isOrgOwner(caller),
	)
	return { contexts: visible, unutilized: unutilizedSummary(visible) }
}

export async function getContextDetail(
	caller: ExecutionContextCaller,
	ref: string,
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	if (!access.isOperator && !access.granted && !isOrgOwner(caller)) notFound()
	const [view] = await formatContexts(caller, [row], { includeSharing: true })
	const all = await listContexts(caller)
	return { context: view!, unutilized: all.unutilized }
}

export async function recordContextAudit(
	caller: ExecutionContextCaller,
	ecid: string,
	event: string,
	detail?: Record<string, unknown>,
) {
	try {
		await sessionStub(caller.env, ecid).recordAudit({
			event,
			actor: {
				userId: caller.userId,
				handle: caller.request.actor?.username ?? null,
			},
			orgId: caller.orgId,
			...(detail ? { detail } : {}),
		})
	} catch {
		// Best effort: audit rows are informational and never block a change.
	}
}

// ---------- chain ----------

function chainUpdatedBy(caller: ExecutionContextCaller) {
	const kind = caller.request.credential.kind
	if (kind === 'session') {
		return {
			kind: 'user' as const,
			label: caller.request.actor?.username ?? null,
		}
	}
	return {
		kind: 'agent' as const,
		label: kind,
	}
}

export async function chainView(caller: ExecutionContextCaller) {
	const db = caller.env.APP_DB
	const chain = await getChain(db, caller)
	const entries = await Promise.all(
		chain.entries.map(async (entry) => {
			if (entry.kind === 'cloud') return entry
			const row = await getExecutionContext(db, entry.id)
			if (!row) {
				return {
					kind: 'context' as const,
					id: entry.id,
					name: null,
					usable: false,
					unusableReason: 'revoked' as UnusableReason,
				}
			}
			const access = await loadContextAccess(db, row, caller)
			return {
				kind: 'context' as const,
				id: entry.id,
				// Lost access hides a rename made after it.
				name: access.unusableReason === 'not_granted' ? null : row.name,
				usable: access.usable,
				...(access.unusableReason
					? { unusableReason: access.unusableReason }
					: {}),
			}
		}),
	)
	return {
		entries,
		strict: !chain.entries.some((entry) => entry.kind === 'cloud'),
		updatedAt: chain.updatedAt,
		updatedBy: chain.updatedBy,
		version: chain.version,
	}
}

export async function chainResponse(caller: ExecutionContextCaller) {
	const [chain, all] = await Promise.all([
		chainView(caller),
		listContexts(caller),
	])
	const { version: _version, ...rest } = chain
	return { chain: rest, unutilized: all.unutilized }
}

export async function setChain(
	caller: ExecutionContextCaller,
	input: {
		entries: ReadonlyArray<ChainEntry>
		ifMatch: string | null | undefined
	},
) {
	const db = caller.env.APP_DB
	const current = await chainView(caller)
	const { version, ...currentBody } = current
	if ((input.ifMatch ?? null) !== (current.updatedAt ?? null)) {
		throw new ExecutionContextError({
			status: 409,
			code: 'chain_changed',
			message:
				'Your chain changed since you read it. Re-read it and apply the change again.',
			details: { current: currentBody },
		})
	}
	const orderError = chainCloudOrderError(input.entries)
	if (orderError) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message: orderError.message,
			details: { cloudIndex: orderError.cloudIndex },
		})
	}
	if (chainIsTooLong(input.entries)) {
		throw new ExecutionContextError({
			status: 422,
			code: 'chain_too_long',
			message: `A chain holds at most ${ecpMaxChainContexts} contexts plus Kody cloud.`,
			details: { max: ecpMaxChainContexts },
		})
	}
	const seen = new Set<string>()
	const normalized: Array<ChainEntry> = []
	const stored = new Set(
		current.entries.flatMap((entry) =>
			entry.kind === 'context' ? [entry.id] : [],
		),
	)
	for (const entry of input.entries) {
		const key = entry.kind === 'cloud' ? 'cloud' : entry.id
		if (seen.has(key)) {
			throw new ExecutionContextError({
				status: 422,
				code: 'context_not_usable',
				message: `${key} appears twice in the chain.`,
				details: { contextId: key, reason: 'duplicate' },
			})
		}
		seen.add(key)
		if (entry.kind === 'context') {
			const row = await resolveExecutionContextRef(db, caller.orgId, entry.id)
			const access = row ? await loadContextAccess(db, row, caller) : null
			// Already-stored entries may stay even if they became unusable (r4).
			if (!row || (!access?.usable && !stored.has(row.id))) {
				throw new ExecutionContextError({
					status: 422,
					code: 'context_not_usable',
					message: `${entry.id} is not usable by you in this org (${access?.unusableReason ?? 'not_attached'}).`,
					details: {
						contextId: entry.id,
						reason: access?.unusableReason ?? 'not_attached',
					},
				})
			}
			normalized.push({ kind: 'context', id: row.id })
		} else {
			normalized.push(entry)
		}
	}
	try {
		await writeChain(db, {
			orgId: caller.orgId,
			userId: caller.userId,
			entries: normalized,
			expectedVersion: version,
			updatedBy: chainUpdatedBy(caller),
			now: new Date().toISOString(),
		})
	} catch (error) {
		if (error instanceof ChainConflictError) {
			const latest = await chainView(caller)
			const { version: _v, ...latestBody } = latest
			throw new ExecutionContextError({
				status: 409,
				code: 'chain_changed',
				message:
					'Your chain changed while you were editing. Re-read it and apply the change again.',
				details: { current: latestBody },
			})
		}
		throw error
	}
	return await chainResponse(caller)
}

async function removeFromChain(caller: ExecutionContextCaller, ecid: string) {
	const chain = await chainView(caller)
	if (
		!chain.entries.some(
			(entry) => entry.kind === 'context' && entry.id === ecid,
		)
	) {
		return false
	}
	await writeChain(caller.env.APP_DB, {
		orgId: caller.orgId,
		userId: caller.userId,
		entries: chain.entries
			.filter((entry) => !(entry.kind === 'context' && entry.id === ecid))
			.map((entry) =>
				entry.kind === 'cloud' ? entry : { kind: 'context', id: entry.id },
			),
		expectedVersion: chain.version,
		updatedBy: chainUpdatedBy(caller),
		now: new Date().toISOString(),
	})
	return true
}

// ---------- opt-in ----------

export async function optIn(caller: ExecutionContextCaller, ref: string) {
	const { row, access } = await loadVisibleContext(caller, ref)
	if (row.revoked_at) {
		throw new ExecutionContextError({
			status: 409,
			code: 'context_revoked',
			message: `${row.name} was revoked.`,
		})
	}
	if (!access.attached || !access.granted) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message:
				'This context is not shared with you, so you cannot opt into it.',
		})
	}
	if (!access.isOperator) {
		await setOptIn(caller.env.APP_DB, {
			contextId: row.id,
			userId: caller.userId,
			orgId: caller.orgId,
			now: new Date().toISOString(),
		})
		await recordContextAudit(caller, row.id, 'opt_in')
	}
	const handles = await handlesFor(caller.env.APP_DB, [row.operator_user_id])
	const all = await listContexts(caller)
	return {
		optedIn: true,
		usable: true,
		notice: optInTrustNotice({
			name: row.name,
			operatorHandle: handles.get(row.operator_user_id) ?? null,
			localNetwork: parseGrant(row).egress.mode === 'public-and-lan',
		}),
		unutilized: all.unutilized,
	}
}

export async function optOut(caller: ExecutionContextCaller, ref: string) {
	const { row } = await loadVisibleContext(caller, ref)
	await removeOptIn(caller.env.APP_DB, {
		contextId: row.id,
		userId: caller.userId,
		orgId: caller.orgId,
	})
	const chainChanged = await removeFromChain(caller, row.id)
	await endLeasesFor(caller.env, [row.id], {
		userIds: [caller.userId],
		orgId: caller.orgId,
		reason: 'access_lost',
	})
	await recordContextAudit(caller, row.id, 'opt_out')
	const response = await chainResponse(caller)
	return { optedIn: false, chainChanged, ...response }
}

// ---------- management ----------

export async function updateContext(
	caller: ExecutionContextCaller,
	ref: string,
	input: { name?: string; grant?: Partial<EcpGrant> },
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	if (!canWriteContext(access)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: 'Changing this context needs Contribute or Manage on it.',
		})
	}
	if (row.revoked_at) {
		throw new ExecutionContextError({
			status: 409,
			code: 'context_revoked',
			message: `${row.name} was revoked.`,
		})
	}
	if (input.grant?.commands?.enabled === true) {
		throw new ExecutionContextError({
			status: 403,
			code: 'commands_opt_in_local',
			message: `Host commands can only be turned on from the machine itself: run \`kody context commands on --context ${row.name}\` there, or use the Kody desktop app. Turning them off works from anywhere.`,
		})
	}
	const db = caller.env.APP_DB
	const commandsWereOn = parseGrant(row).commands?.enabled === true
	const grant = input.grant
		? mergeGrant(parseGrant(row), input.grant)
		: parseGrant(row)
	const name = input.name?.trim() ?? row.name
	const grantVersion = input.grant ? row.grant_version + 1 : row.grant_version
	try {
		await db
			.prepare(
				`UPDATE execution_contexts SET name = ?, grant_json = ?, grant_version = ? WHERE id = ?`,
			)
			.bind(name, JSON.stringify(grant), grantVersion, row.id)
			.run()
	} catch (error) {
		if (!String(error).includes('UNIQUE')) throw error
		throw new ExecutionContextError({
			status: 409,
			code: 'invalid_request',
			message: `Another context in this org is already named ${name}. Pick another name.`,
		})
	}
	if (input.grant) {
		await sessionStub(caller.env, row.id).updateGrant({
			snapshot: {
				ecid: row.id,
				name,
				orgId: row.org_id,
				operatorUserId: row.operator_user_id,
				publicKeyJwk: parsePublicKey(row),
				grant,
				grantVersion,
			},
		})
	}
	await recordContextAudit(
		caller,
		row.id,
		input.grant?.commands && commandsWereOn
			? 'commands_disabled'
			: input.grant
				? 'grant_changed'
				: 'renamed',
		{
			...(input.name ? { name } : {}),
			...(input.grant ? { grantVersion } : {}),
		},
	)
	return await getContextDetail(caller, row.id)
}

/** Grant edits only narrow or reshape; the daemon intersects with local policy. */
export function mergeGrant(
	current: EcpGrant,
	patch: Partial<EcpGrant>,
): EcpGrant {
	return {
		...current,
		...patch,
		limits: { ...current.limits, ...patch.limits },
		payload: { ...current.payload, ...patch.payload },
		commands: patch.commands
			? {
					enabled: patch.commands.enabled,
					enabledAt: patch.commands.enabled
						? (patch.commands.enabledAt ?? current.commands?.enabledAt ?? null)
						: null,
				}
			: (current.commands ?? { enabled: false }),
	}
}

export async function revokeContext(
	caller: ExecutionContextCaller,
	ref: string,
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	if (!canManageContext(access)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: 'Revoking this context needs Manage on it.',
		})
	}
	if (row.org_id !== caller.orgId && !access.isOperator) {
		// An attached org's manager detaches instead of revoking the machine.
		return await detachContext(caller, row.id, caller.orgId)
	}
	const now = new Date().toISOString()
	await caller.env.APP_DB.prepare(
		`UPDATE execution_contexts SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`,
	)
		.bind(now, 'revoked_by_user', row.id)
		.run()
	await recordContextAudit(caller, row.id, 'revoked')
	await sessionStub(caller.env, row.id).revoke({ reason: 'revoked_by_user' })
	return { revoked: true, id: row.id, revokedAt: now }
}

/**
 * A revoked context by id, or by name when exactly one revoked context in the
 * org has it (revoking releases the name, so name lookups skip revoked rows).
 */
async function resolveDeletableContext(
	caller: ExecutionContextCaller,
	ref: string,
) {
	const live = await resolveExecutionContextRef(
		caller.env.APP_DB,
		caller.orgId,
		ref,
	)
	if (live) return live
	const trimmed = ref.trim()
	const revoked = (
		await listOrgExecutionContexts(caller.env.APP_DB, caller.orgId)
	).filter((row) => row.name === trimmed && row.revoked_at)
	if (revoked.length > 1) {
		throw new ExecutionContextError({
			status: 409,
			code: 'invalid_request',
			message: `More than one revoked context is named ${trimmed}. Delete it by id (ec_...) instead.`,
		})
	}
	return revoked[0] ?? notFound()
}

/** Drops a deleted context from every chain that still lists it. */
async function removeFromChains(
	caller: ExecutionContextCaller,
	contextId: string,
) {
	const db = caller.env.APP_DB
	const holders = await db
		.prepare(
			`SELECT DISTINCT org_id, user_id FROM execution_context_chain_entries WHERE context_id = ?`,
		)
		.bind(contextId)
		.all<{ org_id: string; user_id: string }>()
	for (const holder of holders.results) {
		const chainKey = { orgId: holder.org_id, userId: holder.user_id }
		for (let attempt = 0; ; attempt += 1) {
			const chain = await getChain(db, chainKey)
			const kept = chain.entries.filter(
				(entry) => entry.kind !== 'context' || entry.id !== contextId,
			)
			try {
				await writeChain(db, {
					...chainKey,
					entries: kept.length > 0 ? kept : [{ kind: 'cloud' }],
					expectedVersion: chain.version,
					updatedBy: chainUpdatedBy(caller),
					now: new Date().toISOString(),
				})
				break
			} catch (error) {
				if (!(error instanceof ChainConflictError) || attempt >= 2) throw error
			}
		}
	}
}

/**
 * Permanently deletes a revoked context: its row, shares, opt-ins, org
 * attachments and chain entries. Run records keep their own copy of the
 * context id and name, so run history still reads after the delete.
 */
export async function deleteContext(
	caller: ExecutionContextCaller,
	ref: string,
) {
	const row = await resolveDeletableContext(caller, ref)
	const db = caller.env.APP_DB
	const access = await loadContextAccess(db, row, caller)
	if (!canManageContext(access)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: 'Deleting this context needs Manage on it.',
		})
	}
	if (row.org_id !== caller.orgId) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: `${row.name} belongs to another org. Delete it from the org that owns it, or detach it from this one.`,
		})
	}
	if (!row.revoked_at) {
		throw new ExecutionContextError({
			status: 409,
			code: 'context_not_revoked',
			message: `${row.name} is not revoked. Revoke it first (executionContextRevoke or \`kody context revoke <name>\`), then delete it.`,
		})
	}
	const attachedOrgs = await db
		.prepare(
			`SELECT org_id FROM execution_context_org_attachments WHERE context_id = ?`,
		)
		.bind(row.id)
		.all<{ org_id: string }>()
	const grantOrgs = await db
		.prepare(
			`SELECT DISTINCT org_id FROM grants WHERE resource_type = 'execution_context' AND resource_id = ? AND deleted_at IS NULL`,
		)
		.bind(row.id)
		.all<{ org_id: string }>()
	await removeFromChains(caller, row.id)
	const now = new Date().toISOString()
	const epochOrgs = new Set([
		...attachedOrgs.results.map((entry) => entry.org_id),
		...grantOrgs.results.map((entry) => entry.org_id),
	])
	await db.batch([
		db
			.prepare(
				`UPDATE grants SET deleted_at = ?, updated_at = ? WHERE resource_type = 'execution_context' AND resource_id = ? AND deleted_at IS NULL`,
			)
			.bind(now, now, row.id),
		...[...epochOrgs].map((orgId) => bumpAccessEpochStatement(db, orgId)),
		db
			.prepare(`DELETE FROM execution_context_opt_ins WHERE context_id = ?`)
			.bind(row.id),
		db
			.prepare(
				`DELETE FROM execution_context_org_attachments WHERE context_id = ?`,
			)
			.bind(row.id),
		db
			.prepare(
				`DELETE FROM execution_context_chain_entries WHERE context_id = ?`,
			)
			.bind(row.id),
		db
			.prepare(
				`DELETE FROM execution_contexts WHERE id = ? AND revoked_at IS NOT NULL`,
			)
			.bind(row.id),
	])
	await recordContextAudit(caller, row.id, 'deleted')
	return { deleted: true, id: row.id, name: row.name }
}

// ---------- sharing ----------

type ShareRow = {
	id: string
	subject_type: 'user' | 'team'
	subject_id: string
	preset: 'use' | 'contribute' | 'manage' | null
	username: string | null
	team_slug: string | null
	team_name: string | null
	is_member: number
	command: number
}

export async function loadSharing(
	caller: ExecutionContextCaller,
	row: ExecutionContextRow,
) {
	const db = caller.env.APP_DB
	const now = new Date().toISOString()
	const grants = await db
		.prepare(
			`SELECT g.id, g.subject_type, g.subject_id, g.preset, u.username,
				EXISTS (
				  SELECT 1 FROM grant_permissions gp
				  WHERE gp.grant_id = g.id AND gp.permission = '${executionContextCommandPermission}'
				) AS command,
				t.slug AS team_slug, t.name AS team_name,
				CASE WHEN m.user_id IS NULL THEN 0 ELSE 1 END AS is_member
			 FROM grants g
			 LEFT JOIN users u ON g.subject_type = 'user' AND u.stable_user_id = g.subject_id
			 LEFT JOIN teams t ON g.subject_type = 'team' AND t.id = g.subject_id
			 LEFT JOIN org_memberships m ON g.subject_type = 'user' AND m.user_id = g.subject_id
				AND m.org_id = g.org_id AND m.deleted_at IS NULL
			 WHERE g.resource_type = 'execution_context' AND g.resource_id = ?
			   AND g.org_id = ? AND g.deleted_at IS NULL
			   AND (g.expires_at IS NULL OR g.expires_at > ?)
			   AND g.subject_type IN ('user', 'team')
			 ORDER BY g.created_at`,
		)
		.bind(row.id, caller.orgId, now)
		.all<ShareRow>()
	const attachments = await db
		.prepare(
			`SELECT a.org_id, a.all_members, o.slug FROM execution_context_org_attachments a
			 LEFT JOIN orgs o ON o.id = a.org_id AND o.deleted_at IS NULL WHERE a.context_id = ?`,
		)
		.bind(row.id)
		.all<{ org_id: string; all_members: number; slug: string | null }>()
	const allMembers =
		row.org_id === caller.orgId
			? row.all_members === 1
			: attachments.results.some(
					(a) => a.org_id === caller.orgId && a.all_members === 1,
				)
	const grantViews = grants.results.map((grant) => ({
		grantId: grant.id,
		subject:
			grant.subject_type === 'team'
				? {
						kind: 'team' as const,
						slug: grant.team_slug,
						name: grant.team_name,
					}
				: {
						kind: 'user' as const,
						handle: grant.username,
						outside: grant.is_member === 0,
					},
		preset: grant.preset,
		commands: Number(grant.command) === 1,
	}))
	const level = allMembers
		? 'org'
		: grantViews.some((g) => g.subject.kind === 'team')
			? 'team'
			: grantViews.length > 0
				? 'people'
				: 'only_me'
	const handles = await handlesFor(db, [row.operator_user_id])
	return {
		level,
		allMembers,
		grants: grantViews,
		attachedOrgs: attachments.results.map((a) => ({
			id: a.org_id,
			slug: a.slug,
			allMembers: a.all_members === 1,
		})),
		notice: sharingTrustNotice({
			operatorHandle: handles.get(row.operator_user_id) ?? null,
			localNetwork: parseGrant(row).egress.mode === 'public-and-lan',
		}),
	}
}

async function requireSharingReader(
	caller: ExecutionContextCaller,
	ref: string,
) {
	const loaded = await loadVisibleContext(caller, ref)
	if (!canManageContext(loaded.access) && !isOrgOwner(caller)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message:
				'Only the operator, people with Manage, and org owners see sharing.',
		})
	}
	return loaded
}

export async function getSharing(caller: ExecutionContextCaller, ref: string) {
	const { row, access } = await requireSharingReader(caller, ref)
	return {
		id: row.id,
		canAddShares: canManageContext(access),
		sharing: await loadSharing(caller, row),
	}
}

export async function setSharing(
	caller: ExecutionContextCaller,
	ref: string,
	input: {
		add?: Array<{
			subject: { type: 'user' | 'team'; id: string }
			preset: 'use' | 'contribute' | 'manage'
			/** Also grant `execution_context:command` (run host commands). */
			commands?: boolean
		}>
		allMembers?: boolean
	},
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	// Decision 13b: only the operator or a Manage holder adds; owners revoke only.
	if (!canManageContext(access)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message:
				'Only the operator or someone with Manage on this context can share it.',
		})
	}
	const selfShare = selfShareError(
		row.operator_user_id,
		(input.add ?? []).map((share) => share.subject),
	)
	if (selfShare) {
		throw new ExecutionContextError({
			status: 400,
			code: 'invalid_request',
			message: selfShare,
		})
	}
	const db = caller.env.APP_DB
	const audit = orgAuditWriterFromCaller(caller.env, caller.callerContext)
	for (const share of input.add ?? []) {
		await upsertGrant({
			db,
			orgId: caller.orgId,
			resourceType: 'execution_context',
			resourceId: row.id,
			subject: share.subject,
			preset: share.preset,
			permissions: null,
			...(share.commands
				? { extraPermissions: [executionContextCommandPermission] }
				: {}),
			createdByUserId: caller.userId,
			audit,
		})
		await recordContextAudit(caller, row.id, 'share_added', {
			subject: share.subject,
			preset: share.preset,
			...(share.commands ? { commands: true } : {}),
		})
	}
	if (input.allMembers !== undefined) {
		const value = input.allMembers ? 1 : 0
		if (row.org_id === caller.orgId) {
			await db
				.prepare(`UPDATE execution_contexts SET all_members = ? WHERE id = ?`)
				.bind(value, row.id)
				.run()
		} else {
			await db
				.prepare(
					`UPDATE execution_context_org_attachments SET all_members = ? WHERE context_id = ? AND org_id = ?`,
				)
				.bind(value, row.id, caller.orgId)
				.run()
		}
		await recordContextAudit(
			caller,
			row.id,
			input.allMembers ? 'all_members_on' : 'all_members_off',
		)
		if (!input.allMembers)
			await endLeasesWithoutAccess(caller.env, row, caller.orgId)
	}
	const fresh = (await getExecutionContext(db, row.id)) ?? row
	return {
		id: row.id,
		canAddShares: true,
		sharing: await loadSharing(caller, fresh),
	}
}

export async function removeShare(
	caller: ExecutionContextCaller,
	ref: string,
	grantId: string,
) {
	const { row } = await requireSharingReader(caller, ref)
	const db = caller.env.APP_DB
	const grant = await db
		.prepare(
			`SELECT id FROM grants WHERE id = ? AND org_id = ? AND resource_type = 'execution_context' AND resource_id = ? AND deleted_at IS NULL`,
		)
		.bind(grantId, caller.orgId, row.id)
		.first()
	if (!grant) notFound()
	await softDeleteGrant({
		db,
		orgId: caller.orgId,
		grantId,
		audit: orgAuditWriterFromCaller(caller.env, caller.callerContext),
	})
	await recordContextAudit(caller, row.id, 'share_removed', { grantId })
	await endLeasesWithoutAccess(caller.env, row, caller.orgId)
	return { id: row.id, sharing: await loadSharing(caller, row) }
}

export async function attachContext(
	caller: ExecutionContextCaller,
	ref: string,
	targetOrgId: string,
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	if (!access.isOperator) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: 'Only the operator can attach a context to another org.',
		})
	}
	const membership = await caller.env.APP_DB.prepare(
		`SELECT role FROM org_memberships WHERE org_id = ? AND user_id = ? AND deleted_at IS NULL`,
	)
		.bind(targetOrgId, caller.userId)
		.first()
	if (!membership) notFound()
	await caller.env.APP_DB.prepare(
		`INSERT INTO execution_context_org_attachments (context_id, org_id, attached_by_user_id, all_members, created_at)
			 VALUES (?, ?, ?, 0, ?) ON CONFLICT DO NOTHING`,
	)
		.bind(row.id, targetOrgId, caller.userId, new Date().toISOString())
		.run()
	await recordContextAudit(caller, row.id, 'attached', { orgId: targetOrgId })
	return { id: row.id, sharing: await loadSharing(caller, row) }
}

export async function detachContext(
	caller: ExecutionContextCaller,
	ref: string,
	targetOrgId: string,
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	const managerInTarget =
		targetOrgId === caller.orgId && canManageContext(access)
	if (!access.isOperator && !managerInTarget) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: 'Only the operator or a manager in that org can detach it.',
		})
	}
	const db = caller.env.APP_DB
	await db.batch([
		db
			.prepare(
				`DELETE FROM execution_context_org_attachments WHERE context_id = ? AND org_id = ?`,
			)
			.bind(row.id, targetOrgId),
		db
			.prepare(
				`UPDATE grants SET deleted_at = ?, updated_at = ? WHERE resource_type = 'execution_context' AND resource_id = ? AND org_id = ? AND deleted_at IS NULL`,
			)
			.bind(
				new Date().toISOString(),
				new Date().toISOString(),
				row.id,
				targetOrgId,
			),
		bumpAccessEpochStatement(db, targetOrgId, { onlyIfPreviousChanged: true }),
		db
			.prepare(
				`DELETE FROM execution_context_opt_ins WHERE context_id = ? AND org_id = ?`,
			)
			.bind(row.id, targetOrgId),
	])
	await endLeasesFor(caller.env, [row.id], {
		orgId: targetOrgId,
		reason: 'access_lost',
	})
	await recordContextAudit(caller, row.id, 'detached', { orgId: targetOrgId })
	return { id: row.id, detached: true, orgId: targetOrgId }
}

// ---------- history ----------

export async function listRuns(
	caller: ExecutionContextCaller,
	ref: string,
	input: {
		cursor?: number
		limit?: number
		requester?: string
		outcome?: string
		since?: number
	},
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	if (!access.granted && !access.isOperator && !isOrgOwner(caller)) notFound()
	const manager = canManageContext(access) || isOrgOwner(caller)
	const page = await sessionStub(caller.env, row.id).listHistory({
		orgId: caller.orgId,
		...(manager ? {} : { viewerUserId: caller.userId }),
		...(manager && input.requester ? { requester: input.requester } : {}),
		...(input.outcome ? { outcome: input.outcome } : {}),
		...(input.since ? { since: input.since } : {}),
		...(input.cursor ? { cursor: input.cursor } : {}),
		...(input.limit ? { limit: input.limit } : {}),
	})
	return {
		id: row.id,
		scope: manager ? ('all' as const) : ('own' as const),
		runs: page.rows.map((run) => ({
			...run,
			ranOn:
				run.fallback.ranOn === row.id
					? {
							kind: 'context' as const,
							id: row.id,
							name: row.name,
							yours: row.operator_user_id === caller.userId,
						}
					: run.fallback.ranOn === 'cloud'
						? kodyCloudTarget
						: null,
		})),
		nextCursor: page.nextCursor,
	}
}

const historyErrorNames: Partial<Record<string, string>> = {
	failed: 'ExecutionContextRunFailed',
	lost: 'ExecutionContextLost',
	cancelled: 'ExecutionContextRunCancelled',
}

/**
 * A run record built from an execution context's own history row, for
 * `runGet` after the general run record was pruned (it is capped per
 * account; context history keeps 30 days). Metadata only: no logs or result.
 */
export function contextRunRecordFromHistory(input: {
	ecid: string | null
	name: string | null
	row: RunHistoryRow
}): RunRecord {
	const { row } = input
	const status =
		row.outcome === 'succeeded'
			? 'success'
			: row.outcome === null
				? 'running'
				: 'error'
	return {
		id: row.runId,
		surface: 'execute',
		status,
		name: null,
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: null,
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: row.startedAt ?? row.dispatchedAt,
		finishedAt: row.endedAt,
		durationMs: row.durationMs,
		errorName:
			status === 'error'
				? (historyErrorNames[row.outcome ?? ''] ?? 'ExecutionContextRunFailed')
				: null,
		errorMessage: status === 'error' ? row.errorSummary : null,
		errorTriage: null,
		triageNote: null,
		triagedAt: null,
		triagedBy: null,
		startedBy: null,
		metadata: {
			executionContext: {
				id: input.ecid,
				name: input.name,
				outcome: row.outcome,
				failureReason: row.failureReason,
				cancelReason: row.cancelReason,
				position: row.fallback.position,
			},
			recordSource: 'execution_context_history',
		},
		logCount: 0,
	}
}

/**
 * Finds a person's run that started on one of the org's execution contexts.
 * Never throws: runGet only reaches this after a miss.
 */
export async function findStartedContextRun(
	env: Env,
	input: { orgId: string; userId: string; runId: string },
): Promise<RunRecord | null> {
	try {
		const rows = await listOrgExecutionContexts(env.APP_DB, input.orgId)
		if (rows.length === 0) return null
		const found = await Promise.all(
			rows.map((row) =>
				sessionStub(env, row.id)
					.getStartedRun({
						runId: input.runId,
						requesterUserId: input.userId,
						orgId: input.orgId,
					})
					.catch(() => null),
			),
		)
		const hit = found.find((entry) => entry !== null)
		return hit ? contextRunRecordFromHistory(hit) : null
	} catch (error) {
		console.warn('execution-context-run-lookup-failed', error)
		return null
	}
}

export async function listAudit(
	caller: ExecutionContextCaller,
	ref: string,
	input: { cursor?: number; limit?: number },
) {
	const { row, access } = await loadVisibleContext(caller, ref)
	if (!canManageContext(access) && !isOrgOwner(caller)) {
		throw new ExecutionContextError({
			status: 403,
			code: 'not_granted',
			message: 'The audit log is for the operator, managers, and org owners.',
		})
	}
	const page = await sessionStub(caller.env, row.id).listAudit({
		orgId: caller.orgId,
		...(input.cursor ? { cursor: input.cursor } : {}),
		...(input.limit ? { limit: input.limit } : {}),
	})
	return {
		id: row.id,
		events: page.rows.map(({ detailJson, ...event }) => ({
			...event,
			detail: detailJson
				? (JSON.parse(detailJson) as Record<string, unknown>)
				: null,
		})),
		nextCursor: page.nextCursor,
	}
}

// ---------- access loss ----------

/** Ends leases on the given contexts, in batches (protocol 6.7). */
export async function endLeasesFor(
	env: Env,
	contextIds: ReadonlyArray<string>,
	input: { userIds?: Array<string>; orgId?: string; reason: EcpCancelReason },
) {
	const batchSize = 25
	for (let index = 0; index < contextIds.length; index += batchSize) {
		await Promise.all(
			contextIds.slice(index, index + batchSize).map(async (ecid) => {
				for (let attempt = 0; attempt < 2; attempt += 1) {
					try {
						await sessionStub(env, ecid).endLeases({
							...(input.userIds ? { userIds: input.userIds } : {}),
							...(input.orgId ? { orgId: input.orgId } : {}),
							reason: input.reason,
						})
						return
					} catch {
						// Retry once; the per-hop check is the backstop.
					}
				}
			}),
		)
	}
}

/** After a share narrows, end in-flight leases of requesters who lost access. */
export async function endLeasesWithoutAccess(
	env: Env,
	row: ExecutionContextRow,
	orgId: string,
) {
	let leases: Awaited<
		ReturnType<ReturnType<typeof sessionStub>['activeLeases']>
	>
	try {
		leases = await sessionStub(env, row.id).activeLeases()
	} catch {
		return
	}
	const lost: Array<string> = []
	for (const lease of leases) {
		if (lease.orgId !== orgId) continue
		const access = await loadContextAccess(env.APP_DB, row, {
			userId: lease.requester.userId,
			orgId,
		})
		if (!access.usable) lost.push(lease.requester.userId)
	}
	if (lost.length > 0)
		await endLeasesFor(env, [row.id], {
			userIds: lost,
			orgId,
			reason: 'access_lost',
		})
}

/** Contexts a person may hold leases on in an org (for membership hooks). */
export async function contextIdsVisibleInOrg(db: D1Database, orgId: string) {
	const rows = await listOrgExecutionContexts(db, orgId)
	return rows.filter((row) => !row.revoked_at).map((row) => row.id)
}

/**
 * Membership hook: someone left an org or a team, so end their in-flight
 * leases on that org's contexts. Best effort; the per-hop access check is
 * the backstop.
 */
export async function endMemberExecutionContextLeases(
	env: Env,
	input: { orgId: string; userId: string },
) {
	try {
		const ids = await contextIdsVisibleInOrg(env.APP_DB, input.orgId)
		if (ids.length === 0) return
		await endLeasesFor(env, ids, {
			userIds: [input.userId],
			orgId: input.orgId,
			reason: 'access_lost',
		})
	} catch (error) {
		console.error('execution-context-member-lease-end-failed', error)
	}
}
