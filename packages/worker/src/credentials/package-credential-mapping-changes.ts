/**
 * The one validator and writer for credential mapping edits: the package
 * Credentials tabs (POST credentials.json) and the approval page's Approve
 * both resolve changes here and write them in one batch, so a mapping is
 * never saved that the other path would refuse.
 */
import {
	enablementToggleEvent,
	toggleActorFromRequest,
	toggleSourceFromRequest,
} from '#worker/jobs/toggle-audit.ts'
import {
	EmailSenderInsertAdopted,
	armCronJobsForCallerEnablementIds,
	planTriggerEnablementForCaller,
	runNewEnablementPlans,
	TriggerEnablementError,
	type DeclaredTrigger,
	type NewTriggerEnablementPlan,
} from '#worker/enablements/service.ts'
import {
	commitOrgAuditOutbox,
	orgAuditOutboxInsertStatement,
	orgAuditWriterFromRequest,
	planOrgAuditOutbox,
	type OrgAuditOutboxPlan,
	type OrgAuditWriter,
} from '#worker/orgs/org-audit.ts'
import {
	describeCredentialMappingTarget,
	isInboundEmailApprovalTopic,
	type CredentialApprovalChangeView,
	type CredentialApprovalEnableView,
	type CredentialApprovalErrorCode,
	type CredentialMappingChange,
	type CredentialPick,
	type CredentialProposalSender,
	type CredentialRef,
	type CredentialTriggerRef,
} from '#universal/credential-contracts.ts'
import { type UsableCredential } from './credential-candidates.ts'
import {
	buildCredentialMappingUnchangedStatement,
	buildWriteCredentialMappingStatement,
	noteCredentialMappingWritesCommitted,
	type CredentialMappingRowTarget,
} from './credential-mappings.ts'
import { type CredentialNeed } from './credential-needs.ts'
import {
	findStoredRow,
	needAcceptsKind,
	needAcceptsProvider,
	needCreateUrls,
	refsForIds,
	toCredentialRef,
	viewerEnablement,
	type PackageMappingScope,
} from './package-credential-mappings.ts'

/** One org audit row per mapping create, update, or clear. Never holds values. */
export const credentialMappingUpdateAuditAction = 'credential.mapping.update'

/** At most this many refs in one mapping for a `multiple` need. */
export const maxMappedCredentials = 16

export type ResolvedMappingChange = CredentialApprovalChangeView & {
	/** Ordered ids to store; null clears the override. */
	credentialIds: Array<string> | null
	/** The stored ids this replaces, usable or not; null when none are stored. */
	beforeCredentialIds: Array<string> | null
	/** Where the row lives; null when the trigger has no enablement yet. */
	rowTarget: CredentialMappingRowTarget | null
	trigger: DeclaredTrigger | null
}

type ChangeError = NonNullable<CredentialApprovalChangeView['error']>

class ChangeRefused extends Error {
	readonly error: ChangeError

	constructor(error: ChangeError) {
		super(error.message)
		this.error = error
	}
}

function refuse(
	code: CredentialApprovalErrorCode,
	message: string,
	createUrl?: string,
): never {
	throw new ChangeRefused({
		code,
		message,
		...(createUrl ? { createUrl } : {}),
	})
}

function describePick(pick: CredentialPick) {
	if ('id' in pick) return `id "${pick.id}"`
	return pick.scope
		? `${pick.scope} credential "${pick.name}"`
		: `"${pick.name}"`
}

function resolvePick(input: {
	pick: CredentialPick
	need: CredentialNeed
	usable: ReadonlyArray<UsableCredential>
	createUrl: string
}): UsableCredential {
	const { pick, need } = input
	const named =
		'id' in pick
			? input.usable.filter((credential) => credential.id === pick.id)
			: input.usable.filter(
					(credential) =>
						credential.name === pick.name &&
						(!pick.scope || credential.scope === pick.scope),
				)
	if (named.length === 0) {
		refuse(
			'credential_not_found',
			`No credential ${describePick(pick)} that you can use here.`,
			input.createUrl,
		)
	}
	const fitting = named.filter(
		(credential) =>
			needAcceptsKind(need.kind, credential.kind) &&
			needAcceptsProvider(need.provider, credential.provider),
	)
	const [only, second] = fitting.length > 0 ? fitting : named
	if (second) {
		refuse(
			'credential_ambiguous',
			`More than one credential matches ${describePick(pick)}. Pick it by scope or id.`,
		)
	}
	if (!needAcceptsKind(need.kind, only!.kind)) {
		refuse(
			'kind_mismatch',
			`"${only!.name}" is ${only!.kind}; need "${need.key}" takes ${need.kind ?? 'a Key, OAuth, or login credential'}.`,
		)
	}
	if (!needAcceptsProvider(need.provider, only!.provider)) {
		refuse(
			'provider_mismatch',
			`"${only!.name}" is for provider "${only!.provider}"; need "${need.key}" is for "${need.provider}".`,
		)
	}
	return only!
}

type TargetResolution = {
	rowTarget: CredentialMappingRowTarget | null
	trigger: DeclaredTrigger | null
	willEnable: boolean
}

/**
 * The declared trigger and the viewer's enablement of it. Refuses a trigger
 * the package does not declare, an unminted webhook, and a webhook someone
 * else already runs.
 */
function resolveViewerTrigger(
	scope: PackageMappingScope,
	ref: CredentialTriggerRef,
	sender?: CredentialProposalSender | null,
) {
	const candidates = scope.triggers.filter(
		(candidate) => candidate.kind === ref.kind && candidate.name === ref.name,
	)
	const trigger = ref.endpointId
		? candidates.find((candidate) => candidate.instanceId === ref.endpointId)
		: candidates[0]
	if (!trigger) {
		refuse(
			'trigger_unknown',
			`This package declares no ${describeCredentialMappingTarget({ type: 'trigger', trigger: ref })}.`,
		)
	}
	if (trigger.kind === 'webhook' && trigger.instanceId === null) {
		refuse(
			'webhook_not_minted',
			`Webhook "${trigger.name}" has no URL yet. Mint its URL first, then approve it here.`,
		)
	}
	const { enablement, otherEnabler } = viewerEnablement(
		trigger,
		scope.actorId,
		sender,
	)
	if (otherEnabler) {
		refuse(
			'webhook_other_enabler',
			`Webhook "${trigger.name}" runs as another person; only they map its credentials.`,
		)
	}
	return { trigger, enablement }
}

function resolveTarget(
	scope: PackageMappingScope,
	change: CredentialMappingChange,
	sender?: CredentialProposalSender | null,
): TargetResolution {
	const { target } = change
	switch (target.type) {
		case 'default':
			if (target.layer === 'org') {
				if (!scope.canManage) {
					refuse('not_allowed', 'Only package managers set the org default.')
				}
				return {
					rowTarget: { target: 'org' },
					trigger: null,
					willEnable: false,
				}
			}
			return {
				rowTarget: { target: 'mine', personId: scope.actorId },
				trigger: null,
				willEnable: false,
			}
		case 'trigger': {
			const { trigger, enablement } = resolveViewerTrigger(
				scope,
				target.trigger,
				sender,
			)
			if (target.enablementId) {
				const named = trigger.enablements.find(
					(row) =>
						row.id === target.enablementId &&
						String(row.enablerUserId) === scope.actorId,
				)
				if (!named) {
					refuse(
						'not_allowed',
						`Enablement "${target.enablementId}" is not one of yours for this trigger.`,
					)
				}
				return {
					rowTarget: {
						target: 'enablement',
						enablementId: named.id,
						personId: scope.actorId,
					},
					trigger,
					willEnable: false,
				}
			}
			if (target.createInstance) {
				if (trigger.kind === 'webhook') {
					refuse(
						'not_allowed',
						`Webhook "${trigger.name}" already has a URL. Each webhook URL runs as one enablement; mint another URL for another instance.`,
					)
				}
				if (
					trigger.kind === 'subscription' &&
					isInboundEmailApprovalTopic(trigger.name)
				) {
					refuse(
						'email_approval_required',
						`Inbound email runs per sender. Approve another sender from the inbox; do not create a second instance here.`,
					)
				}
				return {
					rowTarget: null,
					trigger,
					willEnable: change.credentials !== null,
				}
			}
			return enablement
				? {
						rowTarget: {
							target: 'enablement',
							enablementId: enablement.id,
							personId: scope.actorId,
						},
						trigger,
						willEnable: false,
					}
				: {
						rowTarget: null,
						trigger,
						willEnable: change.credentials !== null,
					}
		}
		default: {
			const exhaustive: never = target
			throw new Error(`Unhandled mapping target: ${JSON.stringify(exhaustive)}`)
		}
	}
}

/**
 * Resolves each change for the scope's viewer: the need, the stored override
 * it replaces, the credentials it would store, and whether it turns a trigger
 * on. A change that cannot apply carries an `error` instead.
 */
export async function resolveMappingChanges(
	scope: PackageMappingScope,
	changes: ReadonlyArray<CredentialMappingChange>,
	/**
	 * Inbound-email sender the changes apply to. Without it, an enabler with
	 * several sender rules would edit the oldest one.
	 */
	sender?: CredentialProposalSender | null,
): Promise<Array<ResolvedMappingChange>> {
	const createUrls = await needCreateUrls(scope)
	return changes.map((change): ResolvedMappingChange => {
		const need = scope.needs.find(
			(candidate) => candidate.key === change.needKey,
		)
		const base = {
			target: change.target,
			needKey: change.needKey,
			need: need
				? {
						kind: need.kind ?? null,
						provider: need.provider,
						description: need.description,
						multiple: need.multiple,
					}
				: null,
		}
		let before: Array<CredentialRef> | null = null
		let beforeUnusableIds: Array<string> = []
		let beforeCredentialIds: Array<string> | null = null
		try {
			if (!need) {
				refuse(
					'need_unknown',
					`Package "${scope.savedPackage.kodyId}" has no credential need "${change.needKey}".`,
				)
			}
			const orgLevel =
				change.target.type === 'default' && change.target.layer === 'org'
			if (
				need.supplier === 'publisher' &&
				!orgLevel &&
				change.credentials !== null
			) {
				refuse(
					'not_allowed',
					`Credential need "${need.key}" is supplied by the publisher. Only the org-level mapping can set it.`,
				)
			}
			if (need.supplier === 'executor' && orgLevel) {
				refuse(
					'not_allowed',
					`Credential need "${need.key}" is supplied by the executor. Org-level mappings cannot set it.`,
				)
			}
			const target = resolveTarget(scope, change, sender)
			const stored = target.rowTarget
				? findStoredRow(scope, need.key, target.rowTarget)
				: null
			before = stored ? refsForIds(scope, stored.credentialIds) : null
			beforeCredentialIds = stored ? [...stored.credentialIds] : null
			const beforeUsableIds = new Set(before?.map((ref) => ref.id))
			beforeUnusableIds = (beforeCredentialIds ?? []).filter(
				(id) => !beforeUsableIds.has(id),
			)
			if (change.credentials === null) {
				return {
					...base,
					before,
					beforeUnusableIds,
					after: [],
					willEnable: false,
					error: null,
					credentialIds: null,
					beforeCredentialIds,
					rowTarget: target.rowTarget,
					trigger: target.trigger,
				}
			}
			const limit = need.multiple ? maxMappedCredentials : 1
			if (change.credentials.length > limit) {
				refuse(
					'too_many',
					need.multiple
						? `Need "${need.key}" takes at most ${limit} credentials.`
						: `Need "${need.key}" takes one credential.`,
				)
			}
			const usable =
				change.target.type === 'default' && change.target.layer === 'org'
					? scope.usable.filter((credential) => credential.scope === 'org')
					: scope.usable
			const picked = change.credentials.map((pick) =>
				resolvePick({
					pick,
					need,
					usable,
					createUrl: createUrls.get(need.key)!,
				}),
			)
			const unique = [...new Map(picked.map((c) => [c.id, c])).values()]
			return {
				...base,
				before,
				beforeUnusableIds,
				after: unique.map(toCredentialRef),
				willEnable: target.willEnable,
				error: null,
				credentialIds: unique.map((credential) => credential.id),
				beforeCredentialIds,
				rowTarget: target.rowTarget,
				trigger: target.trigger,
			}
		} catch (error) {
			if (!(error instanceof ChangeRefused)) throw error
			return {
				...base,
				before,
				beforeUnusableIds,
				after: [],
				willEnable: false,
				error: error.error,
				credentialIds: null,
				beforeCredentialIds,
				rowTarget: null,
				trigger: null,
			}
		}
	})
}

export type ResolvedTriggerEnable = CredentialApprovalEnableView & {
	declared: DeclaredTrigger | null
}

/**
 * Resolves triggers a proposal turns on without mapping anything: a webhook
 * with no credential needs still goes through Approve.
 */
export function resolveTriggerEnables(
	scope: PackageMappingScope,
	refs: ReadonlyArray<CredentialTriggerRef>,
	sender?: CredentialProposalSender | null,
): Array<ResolvedTriggerEnable> {
	return refs.map((ref) => {
		const trigger: CredentialTriggerRef = {
			kind: ref.kind,
			name: ref.name,
			...(ref.endpointId ? { endpointId: ref.endpointId } : {}),
		}
		try {
			const { trigger: declared, enablement } = resolveViewerTrigger(
				scope,
				ref,
				sender,
			)
			return {
				trigger,
				willEnable: enablement === null,
				error: null,
				declared,
			}
		} catch (error) {
			if (!(error instanceof ChangeRefused)) throw error
			return {
				trigger,
				willEnable: false,
				error: { code: error.error.code, message: error.error.message },
				declared: null,
			}
		}
	})
}

function mappingAuditPlan(
	audit: OrgAuditWriter,
	scope: PackageMappingScope,
	change: ResolvedMappingChange,
): OrgAuditOutboxPlan {
	const trigger =
		change.target.type === 'trigger' ? change.target.trigger : null
	return planOrgAuditOutbox(audit, {
		orgId: scope.savedPackage.userId,
		action: credentialMappingUpdateAuditAction,
		resourceType: 'package',
		resourceId: scope.savedPackage.id,
		details: {
			packageId: scope.savedPackage.id,
			kodyId: scope.savedPackage.kodyId,
			needKey: change.needKey,
			target: change.target,
			trigger,
			beforeCredentialIds: change.beforeCredentialIds,
			afterCredentialIds: change.credentialIds,
			willEnable: change.willEnable,
		},
	})
}

/**
 * A trigger that could not be turned on at write time (it changed since the
 * changes were resolved). `webhook_other_enabler` is a conflict; the other
 * codes mean the change no longer applies. `change` is null when the trigger
 * came from `enable` rather than a mapping change.
 */
export class MappingWriteRefused extends Error {
	readonly change: ResolvedMappingChange | null
	readonly code: MappingWriteRefusalCode

	constructor(
		change: ResolvedMappingChange | null,
		code: MappingWriteRefusalCode,
		message: string,
	) {
		super(message)
		this.name = 'MappingWriteRefused'
		this.change = change
		this.code = code
	}
}

/**
 * Planning a turn-on never asks for webhook approval; only `enablementEnable`
 * does. An inbound-email subscription without a sender is a write refusal.
 */
export type MappingWriteRefusalCode =
	| Exclude<TriggerEnablementError['code'], 'webhook_approval_required'>
	| 'not_allowed'
type MappingWriteRefusal = TriggerEnablementError & {
	code: MappingWriteRefusalCode
}

function isMappingWriteRefusal(error: unknown): error is MappingWriteRefusal {
	return (
		error instanceof TriggerEnablementError &&
		error.code !== 'webhook_approval_required'
	)
}

/** A mapping the write would replace changed after the changes were resolved. */
export class MappingChangedSinceResolve extends Error {
	constructor() {
		super('A mapping changed after these changes were resolved.')
		this.name = 'MappingChangedSinceResolve'
	}
}

function isMalformedJsonError(error: unknown) {
	return error instanceof Error && /malformed JSON/i.test(error.message)
}

function changeTargetKey(change: ResolvedMappingChange) {
	const { target } = change
	const where =
		target.type === 'default'
			? `default:${target.layer}`
			: `trigger:${target.trigger.kind}:${target.trigger.name}:${target.enablementId ?? ''}:${target.createInstance ? 'new' : ''}`
	return `${where}\u0000${change.needKey}`
}

/**
 * Writes resolved changes in one batch, turning on any trigger a change maps
 * for the first time and every trigger in `enable` that is not on yet, and
 * records one `credential.mapping.update` org audit row per written mapping
 * (actor and automation credential from the request; package, trigger, need,
 * and old/new credential ids in details — never values). Every change and
 * enable must have resolved without an error. When one request edits the
 * same need and target twice, the last edit wins, so a set then clear never
 * turns a trigger on. A webhook lost to another enabler since the resolve
 * writes nothing and throws `MappingWriteRefused` (`webhook_other_enabler`).
 * With `requireUnchanged` (Approve), each replaced row must still hold what
 * was resolved, or nothing is written and it throws
 * `MappingChangedSinceResolve`. `also` statements join the same batch.
 */
export async function writeMappingChanges(
	scope: PackageMappingScope,
	resolved: ReadonlyArray<ResolvedMappingChange>,
	options: {
		now?: string
		enable?: ReadonlyArray<ResolvedTriggerEnable>
		/**
		 * Sender stored on an inbound-email enablement this write turns on.
		 * Other triggers ignore it.
		 */
		sender?: CredentialProposalSender | null
		also?: ReadonlyArray<D1PreparedStatement>
		requireUnchanged?: boolean
	} = {},
) {
	const now = options.now ?? new Date().toISOString()
	const enable = options.enable ?? []
	if (
		resolved.some((change) => change.error) ||
		enable.some((entry) => entry.error)
	) {
		throw new Error('Refusing to write mapping changes that have errors.')
	}
	const finalChanges = [
		...new Map(
			resolved.map((change) => [changeTargetKey(change), change]),
		).values(),
	]
	for (const change of finalChanges) {
		const need = scope.needs.find(
			(candidate) => candidate.key === change.needKey,
		)
		const orgLevel =
			change.target.type === 'default' && change.target.layer === 'org'
		if (
			need?.supplier === 'publisher' &&
			!orgLevel &&
			change.credentialIds !== null
		) {
			throw new MappingWriteRefused(
				change,
				'not_allowed',
				`Credential need "${need.key}" is supplied by the publisher. Only the org-level mapping can set it.`,
			)
		}
		if (need?.supplier === 'executor' && orgLevel) {
			throw new MappingWriteRefused(
				change,
				'not_allowed',
				`Credential need "${need.key}" is supplied by the executor. Org-level mappings cannot set it.`,
			)
		}
	}
	const db = scope.env.APP_DB
	const audit = orgAuditWriterFromRequest(scope.env, scope.request)
	const commitMappingWrite = async () => {
		const newEnablements: Array<NewTriggerEnablementPlan> = []
		const enabledIds = new Map<DeclaredTrigger, string>()
		const guards: Array<D1PreparedStatement> = []
		const statements: Array<D1PreparedStatement> = []
		const auditPlans: Array<OrgAuditOutboxPlan> = []
		const newInstanceIds = new Map<DeclaredTrigger, string>()
		const enableTrigger = async (
			trigger: DeclaredTrigger,
			change: ResolvedMappingChange | null,
		) => {
			const createInstance =
				change?.target.type === 'trigger' &&
				Boolean(change.target.createInstance)
			if (createInstance) {
				const knownNew = newInstanceIds.get(trigger)
				if (knownNew) return knownNew
			} else {
				const known = enabledIds.get(trigger)
				if (known) return known
			}
			const email =
				trigger.kind === 'subscription' &&
				isInboundEmailApprovalTopic(trigger.name)
			const plan = await planTriggerEnablementForCaller({
				env: scope.env,
				baseUrl: scope.baseUrl,
				request: scope.request,
				savedPackage: scope.savedPackage,
				kind: trigger.kind,
				name: trigger.name,
				now,
				createInstance,
				...(trigger.kind === 'webhook' && trigger.instanceId
					? { endpointId: trigger.instanceId }
					: {}),
				...(email ? { sender: options.sender ?? null } : {}),
			}).catch((error: unknown) => {
				if (isMappingWriteRefusal(error)) {
					throw new MappingWriteRefused(change, error.code, error.message)
				}
				throw error
			})
			let enablementId: string
			if (plan.enablement) {
				enablementId = plan.enablement.id
			} else {
				enablementId = plan.enablementId
				newEnablements.push(plan)
			}
			if (createInstance) newInstanceIds.set(trigger, enablementId)
			else enabledIds.set(trigger, enablementId)
			return enablementId
		}
		for (const entry of enable) {
			if (entry.willEnable && entry.declared) {
				await enableTrigger(entry.declared, null)
			}
		}
		for (const change of finalChanges) {
			let rowTarget = change.rowTarget
			if (!rowTarget && change.willEnable && change.trigger) {
				const enablementId = await enableTrigger(change.trigger, change)
				rowTarget = {
					target: 'enablement',
					enablementId,
					personId: scope.actorId,
				}
			}
			if (!rowTarget) continue
			// A trigger that was off at resolve may have been turned on and mapped
			// since; its adopted enablement must still have no row.
			if (options.requireUnchanged) {
				guards.push(
					buildCredentialMappingUnchangedStatement({
						db,
						orgId: scope.savedPackage.userId,
						packageId: scope.savedPackage.id,
						needKey: change.needKey,
						target: rowTarget,
						credentialIds: change.beforeCredentialIds,
					}),
				)
			}
			statements.push(
				buildWriteCredentialMappingStatement({
					db,
					orgId: scope.savedPackage.userId,
					packageId: scope.savedPackage.id,
					needKey: change.needKey,
					target: rowTarget,
					credentialIds: change.credentialIds,
					updatedByUserId: scope.actorId,
					now,
				}),
			)
			auditPlans.push(mappingAuditPlan(audit, scope, change))
		}
		for (const plan of newEnablements) {
			auditPlans.push(
				planOrgAuditOutbox(
					audit,
					enablementToggleEvent({
						enablement: {
							id: plan.enablementId,
							orgId: plan.orgId,
							triggerKind: plan.kind,
							triggerName: plan.triggerName,
							instanceId: plan.instanceId,
						},
						from: 'off',
						to: 'on',
						source: toggleSourceFromRequest(scope.request),
						actorKind: toggleActorFromRequest(scope.request).kind,
						reason: 'Approved on the credentials page.',
					}),
				),
			)
		}
		try {
			await runNewEnablementPlans({
				db,
				plans: newEnablements,
				before: guards,
				after: [
					...statements,
					...auditPlans.map((plan) => orgAuditOutboxInsertStatement(db, plan)),
					...(options.also ?? []),
				],
			})
		} catch (error) {
			if (isMappingWriteRefusal(error)) {
				throw new MappingWriteRefused(null, error.code, error.message)
			}
			if (guards.length > 0 && isMalformedJsonError(error)) {
				throw new MappingChangedSinceResolve()
			}
			throw error
		}
		if (statements.length > 0) noteCredentialMappingWritesCommitted(db)
		for (const plan of auditPlans) {
			await commitOrgAuditOutbox({ ...audit, appDb: db }, plan)
		}
		return [...enabledIds, ...newInstanceIds]
			.filter(([trigger]) => trigger.kind === 'cron')
			.map(([, enablementId]) => enablementId)
	}
	// A concurrent approval of the same sender inserts first. The batch rolls
	// back; planning again attaches mappings to that row instead of a second run.
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const cronEnablementIds = await commitMappingWrite()
			// The write is committed. Arming is best-effort: a thrown error would
			// invite a retry, and a retried createInstance inserts a second
			// enablement. Turning the trigger on again or jobUpdate arms it later.
			try {
				await armCronJobsForCallerEnablementIds({
					env: scope.env,
					request: scope.request,
					orgId: scope.savedPackage.userId,
					enablementIds: cronEnablementIds,
				})
			} catch (error) {
				console.error('credential mapping: arming cron jobs failed', {
					enablementIds: cronEnablementIds,
					error: error instanceof Error ? error.message : String(error),
				})
			}
			return
		} catch (error) {
			if (!(error instanceof EmailSenderInsertAdopted)) throw error
			if (attempt === 0) continue
			throw new MappingWriteRefused(
				null,
				'email_sender_conflict',
				'This sender already has a live email enablement. Approve again to use it.',
			)
		}
	}
}
