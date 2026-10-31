import { type OrgAuditCause } from '#worker/orgs/org-audit.ts'
/**
 * Enablement writes from people (credentials plan v4, section 3.3). Each
 * person turns triggers on for themselves; nobody enables a trigger for
 * someone else, and publishing never turns anything on. An enabler, or an
 * Owner, can turn an enablement off.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	authorize,
	checkPermission,
	computeEffectivePermissions,
	packageResource,
} from '#worker/authorization/authorize.ts'
import {
	armJobForEnablement,
	type ArmJobForEnablementResult,
} from '#worker/jobs/arm-job-for-enablement.ts'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import {
	deliverPlannedEnablementToggle,
	planEnablementToggle,
	plannedEnablementToggleStatements,
	toggleActorFromRequest,
} from '#worker/jobs/toggle-audit.ts'
import { resolveSavedPackage } from '#worker/package-invocations/module-artifacts.ts'
import {
	listPackageSubscriptions,
	listPackageWebhooks,
	webhookHmacVerification,
} from '#worker/package-registry/manifest.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	buildCredentialApprovalHref,
	isInboundEmailApprovalTopic,
	type CredentialProposalSender,
} from '#universal/credential-contracts.ts'
import { buildWebhookApprovalUrl } from '#worker/webhooks/approval.ts'
import {
	buildSetWebhookEndpointHmacSecretStatement,
	getWebhookEndpointByIdForUser,
	getWebhookEndpointByKey,
	listWebhookEndpointsByName,
} from '#worker/webhooks/repo.ts'
import { mintPackageOwnedWebhookHmacCiphertext } from '#worker/webhooks/signing-secret.ts'
import {
	buildEnablementInsertedGuardStatement,
	buildInsertEnablementStatement,
	buildInsertWebhookEnablementStatement,
	buildDisableEnablementStatement,
	emailSenderEnablementConflictMessage,
	findLiveEmailSenderEnablement,
	getEnablementById,
	isEmailSenderOneLiveConflict,
	isWebhookOneLiveConflict,
	listEnablementsForInstance,
	listEnablementsForOrg,
	rebindProfilePausedEnablement,
} from './repo.ts'
import {
	canonicalizeEnablementSender,
	isCompleteEnablementSender,
} from './sender-match.ts'
import {
	type EnablementRecord,
	type EnablementSenderKind,
	type EnablementTriggerKind,
} from './types.ts'

export type TriggerEnablementErrorCode =
	| 'trigger_unknown'
	| 'webhook_not_minted'
	| 'webhook_other_enabler'
	| 'webhook_approval_required'
	| 'email_approval_required'
	| 'email_sender_conflict'

/** A trigger the caller cannot turn on, with a code mapping surfaces can show. */
export class TriggerEnablementError extends McpCallerError {
	readonly code: TriggerEnablementErrorCode

	constructor(code: TriggerEnablementErrorCode, message: string) {
		super(message)
		this.name = 'TriggerEnablementError'
		this.code = code
	}
}

function requireActor(request: RequestContext) {
	if (!request.actor) {
		throw new McpCallerError(
			'Only a signed-in person can turn a trigger on, and it runs as them.',
		)
	}
	return request.actor
}

async function resolveOrgPackage(input: {
	db: D1Database
	request: RequestContext
	packageIdOrKodyId: string
}): Promise<SavedPackageRecord> {
	const ref = input.packageIdOrKodyId.trim()
	if (!ref) throw new McpCallerError('packageId or kodyId is required.')
	const savedPackage = await resolveSavedPackage({
		db: input.db,
		userId: input.request.org.id,
		packageIdOrKodyId: ref,
	})
	if (!savedPackage) {
		throw new McpCallerError(`Saved package "${ref}" was not found.`)
	}
	return savedPackage
}

type ResolvedTrigger = {
	instanceId: string
	triggerName: string
	/** A webhook already enabled by someone else: one enabler per endpoint. */
	webhookEnablers?: Array<EnablementRecord>
	/** A webhook URL with no signing secret whose manifest declares no HMAC scheme. */
	unsignedWebhookEndpointId?: string
}

async function resolveDeclaredTrigger(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	kind: EnablementTriggerKind
	name: string
	/** Webhook only: mint to approve. Omit → oldest URL under the name. */
	endpointId?: string | null
}): Promise<ResolvedTrigger> {
	const { savedPackage } = input
	const name = input.name.trim()
	if (!name) throw new McpCallerError('trigger name is required.')
	const { manifest } = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: savedPackage.userId,
		sourceId: savedPackage.sourceId,
	})
	const notDeclared = (where: string) =>
		new TriggerEnablementError(
			'trigger_unknown',
			`Package "${savedPackage.kodyId}" does not declare ${input.kind} "${name}" in package.json#kody.${where}.`,
		)
	switch (input.kind) {
		case 'cron': {
			if (!Object.hasOwn(manifest.kody.jobs ?? {}, name)) {
				throw notDeclared('jobs')
			}
			return {
				instanceId: buildPackageJobId(savedPackage.id, name),
				triggerName: name,
			}
		}
		case 'subscription': {
			const declared = listPackageSubscriptions(manifest).some(
				(subscription) => subscription.topic === name,
			)
			if (!declared) throw notDeclared('subscriptions')
			return { instanceId: savedPackage.id, triggerName: name }
		}
		case 'webhook': {
			const declared = listPackageWebhooks(manifest).find(
				(webhook) => webhook.name === name,
			)
			if (!declared) throw notDeclared('webhooks')
			const endpoint = input.endpointId
				? await getWebhookEndpointByIdForUser({
						db: input.env.APP_DB,
						userId: savedPackage.userId,
						endpointId: input.endpointId,
					})
				: await getWebhookEndpointByKey({
						db: input.env.APP_DB,
						userId: savedPackage.userId,
						packageId: savedPackage.id,
						webhookName: name,
					})
			if (
				!endpoint ||
				endpoint.packageId !== savedPackage.id ||
				endpoint.webhookName !== name
			) {
				throw new TriggerEnablementError(
					'webhook_not_minted',
					`Webhook "${name}" has no URL yet. Mint one with webhookUrlMint, then approve it at the approval URL the mint returns.`,
				)
			}
			return {
				instanceId: endpoint.id,
				triggerName: name,
				webhookEnablers: await listEnablementsForInstance({
					db: input.env.APP_DB,
					orgId: savedPackage.userId,
					triggerKind: 'webhook',
					instanceId: endpoint.id,
				}),
				...(!webhookHmacVerification(declared.verification) &&
				!endpoint.hmacSecretEncrypted
					? { unsignedWebhookEndpointId: endpoint.id }
					: {}),
			}
		}
		default: {
			const exhaustive: never = input.kind
			throw new Error(`Unhandled trigger kind: ${String(exhaustive)}`)
		}
	}
}

export type DeclaredTrigger = {
	kind: EnablementTriggerKind
	name: string
	/** Job id, package id, or webhook endpoint id; null for an unminted webhook. */
	instanceId: string | null
	/** Webhook only: short label for this minted URL; null when unlabeled. */
	instanceLabel?: string | null
	/** Enablements of this instance that are not off, oldest first. */
	enablements: Array<EnablementRecord>
}

/** Every trigger the package declares, with each instance's live enablements. */
export async function listDeclaredTriggers(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
}): Promise<Array<DeclaredTrigger>> {
	const { savedPackage } = input
	const db = input.env.APP_DB
	const orgId = savedPackage.userId
	const { manifest } = await loadPackageManifestBySourceId({
		env: input.env,
		baseUrl: input.baseUrl,
		userId: savedPackage.userId,
		sourceId: savedPackage.sourceId,
	})
	const declared: Array<Omit<DeclaredTrigger, 'enablements'>> = [
		...Object.keys(manifest.kody.jobs ?? {}).map((name) => ({
			kind: 'cron' as const,
			name,
			instanceId: buildPackageJobId(savedPackage.id, name),
		})),
		...listPackageSubscriptions(manifest).map((subscription) => ({
			kind: 'subscription' as const,
			name: subscription.topic,
			instanceId: savedPackage.id,
		})),
		...(
			await Promise.all(
				listPackageWebhooks(manifest).map(async (webhook) => {
					// One DeclaredTrigger per minted URL so Approve and credential
					// mapping can target a specific endpoint. Unminted → one row.
					const endpoints = await listWebhookEndpointsByName({
						db,
						userId: orgId,
						packageId: savedPackage.id,
						webhookName: webhook.name,
					})
					if (endpoints.length === 0) {
						return [
							{
								kind: 'webhook' as const,
								name: webhook.name,
								instanceId: null as string | null,
								instanceLabel: null as string | null,
							},
						]
					}
					return endpoints.map((endpoint) => ({
						kind: 'webhook' as const,
						name: webhook.name,
						instanceId: endpoint.id as string | null,
						instanceLabel: endpoint.instanceLabel,
					}))
				}),
			)
		).flat(),
	]
	return await Promise.all(
		declared.map(async (trigger) => ({
			...trigger,
			enablements: trigger.instanceId
				? await listEnablementsForInstance({
						db,
						orgId,
						triggerKind: trigger.kind,
						instanceId: trigger.instanceId,
						...(trigger.kind === 'subscription'
							? { triggerName: trigger.name }
							: {}),
					})
				: [],
		})),
	)
}

export type NewTriggerEnablementPlan = {
	enablement: null
	kind: EnablementTriggerKind
	triggerName: string
	orgId: string
	instanceId: string
	enablementId: string
	/** Set for an inbound-email insert so a unique-index race can re-read it. */
	enablerUserId?: string
	senderKind?: EnablementSenderKind | null
	senderValue?: string | null
	/**
	 * Inserts the caller's enablement; run it with `runNewEnablementPlans`
	 * (a webhook insert writes nothing when another enabler got there first).
	 */
	statement: D1PreparedStatement
	/** Writes that land in the same batch, just before the insert. */
	prepareStatements: () => Promise<Array<D1PreparedStatement>>
}

/**
 * The email-sender insert lost to a row this same enabler already holds.
 * The batch rolled back. The caller plans again and writes against that row.
 */
export class EmailSenderInsertAdopted extends Error {
	constructor() {
		super('An email sender enablement already exists for this enabler.')
		this.name = 'EmailSenderInsertAdopted'
	}
}

export type TriggerEnablementPlan =
	| { enablement: EnablementRecord }
	| NewTriggerEnablementPlan

function webhookOtherEnablerError(triggerName: string) {
	return new TriggerEnablementError(
		'webhook_other_enabler',
		`Webhook "${triggerName}" was just turned on for another person. Each webhook URL runs as one enabler.`,
	)
}

/**
 * Runs new-enablement inserts in one batch, between `before` and `after`
 * (related writes such as credential mappings). A webhook insert that lost a
 * race with another enabler rolls the whole batch back; the caller gets
 * `webhook_other_enabler` when another live enablement holds the webhook.
 * An inbound-email sender insert that loses its unique index rolls back too:
 * `EmailSenderInsertAdopted` when the same enabler already holds the row,
 * `email_sender_conflict` when someone else does.
 */
export async function runNewEnablementPlans(input: {
	db: D1Database
	plans: ReadonlyArray<NewTriggerEnablementPlan>
	before?: ReadonlyArray<D1PreparedStatement>
	after?: ReadonlyArray<D1PreparedStatement>
}) {
	const { db, plans } = input
	const batch: Array<D1PreparedStatement> = [...(input.before ?? [])]
	for (const plan of plans) {
		batch.push(...(await plan.prepareStatements()), plan.statement)
		if (plan.kind === 'webhook') {
			batch.push(
				buildEnablementInsertedGuardStatement({ db, id: plan.enablementId }),
			)
		}
	}
	batch.push(...(input.after ?? []))
	if (batch.length === 0) return
	try {
		await db.batch(batch)
	} catch (error) {
		const loser = await findWebhookRaceLoser(db, plans)
		if (loser) throw webhookOtherEnablerError(loser.triggerName)
		if (isWebhookOneLiveConflict(error)) {
			const firstWebhook = plans.find((plan) => plan.kind === 'webhook')
			if (firstWebhook) throw webhookOtherEnablerError(firstWebhook.triggerName)
		}
		if (isEmailSenderOneLiveConflict(error)) {
			const race = await classifyEmailSenderRace(db, plans)
			if (race === 'adopt') throw new EmailSenderInsertAdopted()
			if (race === 'conflict') {
				throw new TriggerEnablementError(
					'email_sender_conflict',
					emailSenderEnablementConflictMessage,
				)
			}
		}
		throw error
	}
}

/**
 * After a unique failure, the winner's row is committed and this batch is
 * not. Same enabler adopts that row; anyone else is a conflict.
 */
async function classifyEmailSenderRace(
	db: D1Database,
	plans: ReadonlyArray<NewTriggerEnablementPlan>,
): Promise<'adopt' | 'conflict' | 'unrelated'> {
	const emailPlans = plans.filter(
		(plan) =>
			plan.kind === 'subscription' &&
			isInboundEmailApprovalTopic(plan.triggerName) &&
			plan.senderKind &&
			plan.enablerUserId,
	)
	if (emailPlans.length === 0) return 'unrelated'
	let adopt = false
	for (const plan of emailPlans) {
		const senderKind = plan.senderKind
		const enablerUserId = plan.enablerUserId
		if (!senderKind || !enablerUserId) continue
		const sender = canonicalizeEnablementSender({
			senderKind,
			senderValue: plan.senderValue,
		})
		if (!sender.senderKind) continue
		const existing = await findLiveEmailSenderEnablement({
			db,
			orgId: plan.orgId,
			instanceId: plan.instanceId,
			triggerName: plan.triggerName,
			senderKind: sender.senderKind,
			senderValue: sender.senderValue,
		})
		if (!existing) continue
		const same =
			String(existing.enablerUserId) === enablerUserId &&
			existing.senderKind === sender.senderKind &&
			(existing.senderValue ?? '') === (sender.senderValue ?? '')
		if (!same) return 'conflict'
		adopt = true
	}
	// No live winner found yet (replication lag / transient read): rethrow the
	// original unique failure instead of blaming another enabler.
	return adopt ? 'adopt' : 'unrelated'
}

async function findWebhookRaceLoser(
	db: D1Database,
	plans: ReadonlyArray<NewTriggerEnablementPlan>,
) {
	for (const plan of plans) {
		if (plan.kind !== 'webhook') continue
		const live = await listEnablementsForInstance({
			db,
			orgId: plan.orgId,
			triggerKind: 'webhook',
			instanceId: plan.instanceId,
		})
		if (live.length > 0) return plan
	}
	return null
}

/**
 * What turning a declared trigger on for the caller takes, without writing
 * the enablement: the caller's existing enablement (or the webhook's), or an
 * insert to batch with related writes. The caller has already been
 * authorized for `package:execute` on `savedPackage`.
 */
function emailApprovalRequiredMessage(input: {
	baseUrl: string
	orgSlug: string | null
	kodyId: string
	topic: string
}) {
	const topic = input.topic.trim()
	const href = input.orgSlug
		? new URL(
				buildCredentialApprovalHref({
					username: input.orgSlug,
					kodyId: input.kodyId,
					changes: [],
					enable: [{ kind: 'subscription', name: topic }],
				}),
				input.baseUrl,
			).toString()
		: null
	return `Subscription "${topic}" runs only for a sender you approve. Approve it${
		href ? ` at ${href}` : ` from package "${input.kodyId}"`
	} with sender_kind and sender_value (member, address, domain, or any_authenticated). enablementEnable cannot turn it on.`
}

function senderMatches(
	row: EnablementRecord,
	sender: CredentialProposalSender,
) {
	const canonical = canonicalizeEnablementSender({
		senderKind: sender.kind,
		senderValue: sender.value,
	})
	return (
		row.senderKind === canonical.senderKind &&
		(row.senderValue ?? null) === (canonical.senderValue ?? null)
	)
}

function findCallerEnablement(
	rows: ReadonlyArray<EnablementRecord>,
	sender: CredentialProposalSender | null,
) {
	if (!sender) return rows[0]
	return rows.find((row) => senderMatches(row, sender))
}

export async function planTriggerEnablementForCaller(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	savedPackage: SavedPackageRecord
	kind: EnablementTriggerKind
	name: string
	now?: string
	/** Required when turning on an inbound-email subscription. */
	sender?: CredentialProposalSender | null
	/**
	 * Insert another enablement even when the caller already holds one.
	 * Cron and non-email subscriptions only; webhooks stay one live row per
	 * URL, and inbound email keeps its sender-scoped Approve path.
	 */
	createInstance?: boolean
	/** Webhook only: mint to approve. Omit → oldest URL under the name. */
	endpointId?: string | null
}): Promise<TriggerEnablementPlan> {
	const actor = requireActor(input.request)
	const { savedPackage } = input
	const trigger = await resolveDeclaredTrigger({
		env: input.env,
		baseUrl: input.baseUrl,
		savedPackage,
		kind: input.kind,
		name: input.name,
		endpointId: input.endpointId,
	})
	const db = input.env.APP_DB
	const orgId = savedPackage.userId
	const [webhookEnabler] = trigger.webhookEnablers ?? []
	if (
		webhookEnabler &&
		String(webhookEnabler.enablerUserId) !== String(actor.userId)
	) {
		throw new TriggerEnablementError(
			'webhook_other_enabler',
			`Webhook "${trigger.triggerName}" is already on for another person. Each webhook URL runs as one enabler.`,
		)
	}
	// Keeps every enabled URL holding a signing secret, so requiring
	// X-Kody-Signature later would not need a re-mint. Ingress does not check it.
	const prepareStatements = async () => {
		if (!trigger.unsignedWebhookEndpointId) return []
		const { encrypted } = await mintPackageOwnedWebhookHmacCiphertext({
			env: input.env,
			userId: orgId,
			endpointId: trigger.unsignedWebhookEndpointId,
		})
		return [
			buildSetWebhookEndpointHmacSecretStatement({
				db,
				userId: orgId,
				endpointId: trigger.unsignedWebhookEndpointId,
				hmacSecretEncrypted: encrypted,
			}),
		]
	}
	if (webhookEnabler) {
		const statements = await prepareStatements()
		if (statements.length > 0) await db.batch(statements)
		return { enablement: webhookEnabler }
	}
	const email =
		input.kind === 'subscription' &&
		isInboundEmailApprovalTopic(trigger.triggerName)
	let storedSender: CredentialProposalSender | null = null
	if (email) {
		if (!input.sender) {
			throw new TriggerEnablementError(
				'email_approval_required',
				emailApprovalRequiredMessage({
					baseUrl: input.baseUrl,
					orgSlug: input.request.org.slug,
					kodyId: savedPackage.kodyId,
					topic: trigger.triggerName,
				}),
			)
		}
		const canonical = canonicalizeEnablementSender({
			senderKind: input.sender.kind,
			senderValue: input.sender.value,
		})
		if (!isCompleteEnablementSender(canonical) || !canonical.senderKind) {
			throw new TriggerEnablementError(
				'email_approval_required',
				emailApprovalRequiredMessage({
					baseUrl: input.baseUrl,
					orgSlug: input.request.org.slug,
					kodyId: savedPackage.kodyId,
					topic: trigger.triggerName,
				}),
			)
		}
		storedSender = {
			kind: canonical.senderKind,
			value: canonical.senderValue,
		}
	}
	const ownRows = (
		await listEnablementsForInstance({
			db,
			orgId,
			triggerKind: input.kind,
			instanceId: trigger.instanceId,
			...(input.kind === 'subscription'
				? { triggerName: trigger.triggerName }
				: {}),
		})
	).filter((row) => String(row.enablerUserId) === String(actor.userId))
	const createInstance = Boolean(input.createInstance)
	if (createInstance) {
		if (input.kind === 'webhook') {
			throw new TriggerEnablementError(
				'webhook_other_enabler',
				`Webhook "${trigger.triggerName}" already has a URL. Each webhook URL runs as one enablement; mint another URL for another instance.`,
			)
		}
		if (
			input.kind === 'subscription' &&
			isInboundEmailApprovalTopic(trigger.triggerName)
		) {
			throw new TriggerEnablementError(
				'email_approval_required',
				emailApprovalRequiredMessage({
					baseUrl: input.baseUrl,
					orgSlug: input.request.org.slug,
					kodyId: savedPackage.kodyId,
					topic: trigger.triggerName,
				}),
			)
		}
	}
	const ownExisting = createInstance
		? undefined
		: findCallerEnablement(ownRows, storedSender)
	if (ownExisting) {
		// The caller's credential already passed the chain check above, so a
		// profile-paused enablement turns on again acting as this credential.
		if (
			ownExisting.pause?.reason === 'profile_inactive' &&
			(await rebindProfilePausedEnablement({
				db,
				orgId,
				id: ownExisting.id,
				enablerScopes: input.request.credential.scopes,
				enablerProfileId: input.request.credential.profileId ?? null,
				now: input.now,
			}))
		) {
			const rebound = await getEnablementById({ db, orgId, id: ownExisting.id })
			return { enablement: rebound ?? ownExisting }
		}
		return { enablement: ownExisting }
	}
	const buildInsert =
		input.kind === 'webhook'
			? buildInsertWebhookEnablementStatement
			: buildInsertEnablementStatement
	const { id, statement } = buildInsert({
		db,
		enablement: {
			orgId,
			packageId: savedPackage.id,
			triggerKind: input.kind,
			triggerName: trigger.triggerName,
			instanceId: trigger.instanceId,
			enablerUserId: actor.userId,
			enablerScopes: input.request.credential.scopes,
			enablerProfileId: input.request.credential.profileId ?? null,
			origin: 'enabled',
			senderKind: storedSender?.kind ?? null,
			senderValue: storedSender?.value ?? null,
		},
		now: input.now ?? new Date().toISOString(),
	})
	return {
		enablement: null,
		kind: input.kind,
		triggerName: trigger.triggerName,
		orgId,
		instanceId: trigger.instanceId,
		enablementId: id,
		enablerUserId: String(actor.userId),
		senderKind: storedSender?.kind ?? null,
		senderValue: storedSender?.value ?? null,
		statement,
		prepareStatements,
	}
}

/**
 * Turn a declared trigger on for the caller. The caller needs
 * `package:execute` on the package, and every run then acts as them. A
 * webhook's first turn-on is refused here: a person approves it (credential
 * approval), which also reviews what it will use. Inbound email is refused
 * here too: it runs only for a sender on that same approval page.
 */
export async function enableTriggerForCaller(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	packageIdOrKodyId: string
	kind: EnablementTriggerKind
	name: string
}): Promise<EnablementRecord> {
	return (await enableTriggerWithJobForCaller(input)).enablement
}

/**
 * What turning a cron enablement on did to its job. `left_off` means the job
 * row is still off because the caller lacks `job:write`; `message` says why
 * and how to get it.
 */
export type EnablementJobOutcome = {
	jobId: string
	state: 'armed' | 'already_on' | 'left_off' | 'expired' | 'missing'
	missingPermission: 'job:write' | null
	message: string | null
}

export function jobLeftOffMessage(jobName: string | null) {
	const job = jobName ? `job "${jobName}"` : 'job'
	return `The enablement is on, but its ${job} is still off, so it will not run yet. Turning a job on needs job:write (what jobUpdate needs), and you do not hold it in this org. Ask an Owner to grant you job:write (accessGrant on the org), or to turn the job on with jobUpdate.`
}

function toEnablementJobOutcome(input: {
	jobId: string
	jobName: string | null
	result: ArmJobForEnablementResult | 'left_off'
}): EnablementJobOutcome {
	if (input.result === 'left_off') {
		return {
			jobId: input.jobId,
			state: 'left_off',
			missingPermission: 'job:write',
			message: jobLeftOffMessage(input.jobName),
		}
	}
	return {
		jobId: input.jobId,
		state: input.result,
		missingPermission: null,
		message:
			input.result === 'expired'
				? 'The enablement is on, but its job passed its expiry time and stays off. Change or clear expiresAt with jobUpdate to run it again.'
				: input.result === 'missing'
					? 'The enablement is on, but its job was not found.'
					: null,
	}
}

/**
 * {@link enableTriggerForCaller} plus what happened to a cron enablement's job,
 * so a caller without `job:write` learns the job stayed off and why.
 */
export async function enableTriggerWithJobForCaller(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	packageIdOrKodyId: string
	kind: EnablementTriggerKind
	name: string
	/** Set when a package run turns the trigger on. */
	cause?: OrgAuditCause | null
}): Promise<{
	enablement: EnablementRecord
	job: EnablementJobOutcome | null
}> {
	requireActor(input.request)
	const savedPackage = await resolveOrgPackage({
		db: input.env.APP_DB,
		request: input.request,
		packageIdOrKodyId: input.packageIdOrKodyId,
	})
	await authorize(
		{ env: input.env, request: input.request },
		'package:execute',
		packageResource({
			id: savedPackage.id,
			userId: savedPackage.userId,
			label: savedPackage.kodyId,
		}),
	)
	const topic = input.name.trim()
	if (input.kind === 'subscription' && isInboundEmailApprovalTopic(topic)) {
		throw new TriggerEnablementError(
			'email_approval_required',
			emailApprovalRequiredMessage({
				baseUrl: input.baseUrl,
				orgSlug: input.request.org.slug,
				kodyId: savedPackage.kodyId,
				topic,
			}),
		)
	}
	const plan = await planTriggerEnablementForCaller({
		env: input.env,
		baseUrl: input.baseUrl,
		request: input.request,
		savedPackage,
		kind: input.kind,
		name: input.name,
	})
	if (plan.enablement) {
		const job = await armCronJobWithOutcome({
			env: input.env,
			request: input.request,
			enablement: plan.enablement,
			cause: input.cause ?? null,
		})
		return { enablement: plan.enablement, job }
	}
	if (input.kind === 'webhook') {
		const approvalUrl = buildWebhookApprovalUrl({
			baseUrl: input.baseUrl,
			orgSlug: input.request.org.slug,
			packageKodyId: savedPackage.kodyId,
			webhookName: input.name.trim(),
		})
		throw new TriggerEnablementError(
			'webhook_approval_required',
			`Webhook "${input.name.trim()}" is not approved yet. A webhook's first turn-on needs a person to Approve it${
				approvalUrl
					? ` at ${approvalUrl}`
					: ` from package "${savedPackage.kodyId}"'s Credentials page`
			}; enablementEnable cannot do it.`,
		)
	}
	const toggle = planEnablementToggle({
		env: input.env,
		request: input.request,
		enablement: {
			id: plan.enablementId,
			orgId: plan.orgId,
			triggerKind: plan.kind,
			triggerName: plan.triggerName,
			instanceId: plan.instanceId,
		},
		from: 'off',
		to: 'on',
		cause: input.cause ?? null,
	})
	await runNewEnablementPlans({
		db: input.env.APP_DB,
		plans: [plan],
		after: plannedEnablementToggleStatements(toggle),
	})
	await deliverPlannedEnablementToggle(toggle)
	const created = await getEnablementById({
		db: input.env.APP_DB,
		orgId: savedPackage.userId,
		id: plan.enablementId,
	})
	if (!created) throw new Error('Unable to read the new enablement.')
	const job = await armCronJobWithOutcome({
		env: input.env,
		request: input.request,
		enablement: created,
		cause: input.cause ?? null,
	})
	return { enablement: created, job }
}

async function armCronJobWithOutcome(input: {
	env: Env
	request: RequestContext
	enablement: EnablementRecord
	cause?: OrgAuditCause | null
}): Promise<EnablementJobOutcome | null> {
	const result = await armCronJobForCallerEnablement(input)
	if (result === 'not_applicable') return null
	const jobId = input.enablement.instanceId
	const row = await jobsData(input.env).getJobById({
		userId: input.enablement.orgId,
		jobId,
	})
	if (result === 'not_permitted') {
		// The job:write gate stays. Only explain it when the job is actually off.
		if (!row)
			return toEnablementJobOutcome({ jobId, jobName: null, result: 'missing' })
		return toEnablementJobOutcome({
			jobId,
			jobName: row.record.name,
			result: row.record.enabled ? 'already_on' : 'left_off',
		})
	}
	return toEnablementJobOutcome({
		jobId,
		jobName: row?.record.name ?? null,
		result,
	})
}

/**
 * A scheduled tick runs only when the job row is enabled and an enablement is
 * on. Turning a cron enablement on must not leave its job row off (with a
 * stale `next_run_at`), so when the caller may also write jobs (`job:write`,
 * what `jobUpdate` needs) the job is turned on and rescheduled from now.
 * Without `job:write` the job keeps the state its writers chose.
 */
export async function armCronJobForCallerEnablement(input: {
	env: Env
	request: RequestContext
	enablement: EnablementRecord
	/** Set when a package run turned the enablement on. */
	cause?: OrgAuditCause | null
}): Promise<ArmJobForEnablementResult | 'not_permitted' | 'not_applicable'> {
	const { enablement } = input
	if (enablement.triggerKind !== 'cron' || enablement.state !== 'on') {
		return 'not_applicable'
	}
	const access = await computeEffectivePermissions({
		env: input.env,
		request: input.request,
	})
	if (!checkPermission(access, 'job:write').allowed) return 'not_permitted'
	return await armJobForEnablement({
		env: input.env,
		orgId: enablement.orgId,
		jobId: enablement.instanceId,
		actor: toggleActorFromRequest(input.request),
		enablementId: enablement.id,
		cause: input.cause ?? null,
	})
}

/** {@link armCronJobForCallerEnablement} for enablements written by id. */
export async function armCronJobsForCallerEnablementIds(input: {
	env: Env
	request: RequestContext
	orgId: OwnerId
	enablementIds: ReadonlyArray<string>
}) {
	// One failure must not skip the rest; rethrow the first after the loop.
	const errors: Array<unknown> = []
	for (const id of new Set(input.enablementIds)) {
		try {
			const enablement = await getEnablementById({
				db: input.env.APP_DB,
				orgId: input.orgId,
				id,
			})
			if (!enablement) continue
			await armCronJobForCallerEnablement({
				env: input.env,
				request: input.request,
				enablement,
			})
		} catch (error) {
			errors.push(error)
		}
	}
	if (errors.length > 0) throw errors[0]
}

/** Turn an enablement off for good. Only its enabler or an Owner may. */
export async function disableEnablementForCaller(input: {
	env: Env
	request: RequestContext
	enablementId: string
	/** Why it was turned off, recorded in the org audit log. */
	reason?: string | null
	/** Set when a package run turns the trigger off. */
	cause?: OrgAuditCause | null
}): Promise<EnablementRecord> {
	const actor = requireActor(input.request)
	const db = input.env.APP_DB
	const orgId = input.request.org.id
	const enablement = await getEnablementById({
		db,
		orgId,
		id: input.enablementId,
	})
	const notFound = new McpCallerError(
		`Enablement "${input.enablementId}" was not found.`,
	)
	if (!enablement) throw notFound
	if (String(enablement.enablerUserId) !== String(actor.userId)) {
		const access = await computeEffectivePermissions({
			env: input.env,
			request: input.request,
		})
		// Someone else's enablement is invisible to non-Owners.
		if (!access.isOwner) throw notFound
	}
	const toggle = planEnablementToggle({
		env: input.env,
		request: input.request,
		enablement,
		from: enablement.state,
		to: 'off',
		reason: input.reason,
		cause: input.cause ?? null,
	})
	// The audit row commits with the turn-off and only when it changed a row.
	await db.batch([
		buildDisableEnablementStatement({ db, orgId, id: enablement.id }),
		...plannedEnablementToggleStatements(toggle, { onlyIfChanged: true }),
	])
	await deliverPlannedEnablementToggle(toggle)
	const updated = await getEnablementById({ db, orgId, id: enablement.id })
	if (!updated) throw notFound
	return updated
}

/** The caller's enablements; an Owner may list the whole org's. */
export async function listEnablementsForCaller(input: {
	env: Env
	request: RequestContext
	scope: 'mine' | 'org'
	includeOff: boolean
}): Promise<Array<EnablementRecord>> {
	const actor = requireActor(input.request)
	if (input.scope === 'org') {
		const access = await computeEffectivePermissions({
			env: input.env,
			request: input.request,
		})
		if (!access.isOwner) {
			throw new McpCallerError(
				'Only an Owner can list every enablement in the org.',
			)
		}
	}
	return await listEnablementsForOrg({
		db: input.env.APP_DB,
		orgId: input.request.org.id,
		enablerUserId: input.scope === 'mine' ? actor.userId : undefined,
		includeOff: input.includeOff,
	})
}
