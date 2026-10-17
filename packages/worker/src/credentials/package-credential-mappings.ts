/**
 * The package credentials view (contract: docs/contributing/contracts/
 * credential-mappings-api.md, "Package credentials API"): a package's needs
 * with their default mappings, its triggers with the viewer's overrides, and
 * what a run would use for each. Everything is seen as the viewer: options
 * and effective mappings hold only credentials they can Use, and only their
 * own `mine` layer and enablements show. Nothing here reads a value.
 */
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	listDeclaredTriggers,
	type DeclaredTrigger,
} from '#worker/enablements/service.ts'
import { canonicalizeEnablementSender } from '#worker/enablements/sender-match.ts'
import { type EnablementRecord } from '#worker/enablements/types.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	fetchCapableCredentialKinds,
	isInboundEmailApprovalTopic,
	type CredentialKind,
	type CredentialListItem,
	type CredentialProposalSender,
	type CredentialRef,
	type EffectiveCredentialMapping,
	type PackageCredentialNeedView,
	type PackageCredentialsIncomplete,
	type PackageCredentialsView,
	type PackageTriggerInstanceView,
	type PackageTriggerView,
	type StoredCredentialMapping,
} from '#universal/credential-contracts.ts'
import {
	listUsableCredentials,
	resolveNeedCandidates,
	type UsableCredential,
} from './credential-candidates.ts'
import { listCredentialsForViewer } from './credential-list.ts'
import {
	loadCredentialMappings,
	resolveStoredMapping,
	type CredentialMappingRow,
	type CredentialMappingRowTarget,
} from './credential-mappings.ts'
import { loadPublishedCredentialNeeds } from './credential-needs-closure.ts'
import { type CredentialNeed } from './credential-needs.ts'
import { buildNeedCreateUrl } from './need-create-url.ts'

export type PackageMappingScope = {
	env: Env
	baseUrl: string
	/** A session context bound to the package's org. */
	request: RequestContext
	actorId: string
	savedPackage: SavedPackageRecord
	canManage: boolean
	needs: Array<CredentialNeed>
	usable: Array<UsableCredential>
	triggers: Array<DeclaredTrigger>
	rows: Array<CredentialMappingRow>
	usernames: Map<string, string>
}

function sameSender(
	enablement: EnablementRecord,
	sender: CredentialProposalSender,
) {
	const canonical = canonicalizeEnablementSender({
		senderKind: sender.kind,
		senderValue: sender.value,
	})
	return (
		enablement.senderKind === canonical.senderKind &&
		(enablement.senderValue ?? null) === (canonical.senderValue ?? null)
	)
}

/**
 * The enablement a viewer edits for a trigger: their own for a schedule or
 * subscription, or the webhook's single enabler, which may be someone else.
 * An inbound-email subscription with `sender` matches that sender only, so
 * another sender of the same topic stays a separate enablement. With no
 * sender, one email row is that rule; several rows are ambiguous and match
 * nothing, so a caller cannot edit an arbitrary sender's credentials.
 */
export function viewerEnablement(
	trigger: DeclaredTrigger,
	actorId: string,
	sender?: CredentialProposalSender | null,
): { enablement: EnablementRecord | null; otherEnabler: boolean } {
	const ownRows = trigger.enablements.filter(
		(enablement) => String(enablement.enablerUserId) === actorId,
	)
	const emailTopic =
		trigger.kind === 'subscription' && isInboundEmailApprovalTopic(trigger.name)
	let own: EnablementRecord | null
	if (emailTopic && sender) {
		own = ownRows.find((enablement) => sameSender(enablement, sender)) ?? null
	} else if (emailTopic && ownRows.length !== 1) {
		// Zero rows, or several sender rules and no sender to choose among them.
		own = null
	} else {
		own = ownRows[0] ?? null
	}
	if (own) return { enablement: own, otherEnabler: false }
	if (trigger.kind === 'webhook' && trigger.enablements[0]) {
		return { enablement: trigger.enablements[0], otherEnabler: true }
	}
	return { enablement: null, otherEnabler: false }
}

async function loadUsernames(db: D1Database, ids: ReadonlyArray<string>) {
	const unique = [...new Set(ids.filter(Boolean))]
	if (unique.length === 0) return new Map<string, string>()
	const result = await db
		.prepare(
			`SELECT stable_user_id, username FROM users
			WHERE stable_user_id IN (${unique.map(() => '?').join(', ')})
				AND deleted_at IS NULL`,
		)
		.bind(...unique)
		.all<{ stable_user_id: string; username: string }>()
	return new Map(
		(result.results ?? []).map((row) => [row.stable_user_id, row.username]),
	)
}

export async function loadPackageMappingScope(input: {
	env: Env
	baseUrl: string
	request: RequestContext
	savedPackage: SavedPackageRecord
	canManage: boolean
}): Promise<PackageMappingScope> {
	const actorId = input.request.actor?.userId
	if (!actorId) {
		throw new Error('Package credentials are only available to a person.')
	}
	const { savedPackage } = input
	const [needs, usable, triggers] = await Promise.all([
		loadPublishedCredentialNeeds({
			env: input.env,
			userId: savedPackage.userId,
			sourceId: savedPackage.sourceId,
		}),
		listUsableCredentials({
			env: input.env,
			request: input.request,
			packageId: savedPackage.id,
		}),
		listDeclaredTriggers({
			env: input.env,
			baseUrl: input.baseUrl,
			savedPackage,
		}),
	])
	const ownEnablementIds = triggers.flatMap((trigger) =>
		// One person may hold several enablements of the same trigger (cron,
		// subscription, or inbound-email senders). Load every one of theirs so
		// each instance's mapping is visible and editable.
		trigger.enablements
			.filter((enablement) => String(enablement.enablerUserId) === actorId)
			.map((enablement) => enablement.id),
	)
	const rows = await loadCredentialMappings({
		db: input.env.APP_DB,
		orgId: savedPackage.userId,
		packageId: savedPackage.id,
		personId: actorId,
		enablementIds: ownEnablementIds,
	})
	const usernames = await loadUsernames(
		input.env.APP_DB,
		rows.map((row) => row.updatedByUserId ?? ''),
	)
	return {
		env: input.env,
		baseUrl: input.baseUrl,
		request: input.request,
		actorId,
		savedPackage,
		canManage: input.canManage,
		needs,
		usable,
		triggers,
		rows,
		usernames,
	}
}

export function toCredentialRef(credential: UsableCredential): CredentialRef {
	return {
		id: credential.id,
		name: credential.name,
		scope: credential.scope,
		kind: credential.kind,
	}
}

/** Kinds that can fill a need: its own, or any fetch-capable kind without one. */
export function needAcceptsKind(
	needKind: CredentialKind | null | undefined,
	kind: CredentialKind,
) {
	return needKind == null
		? (fetchCapableCredentialKinds as ReadonlyArray<CredentialKind>).includes(
				kind,
			)
		: needKind === kind
}

/** A provider matches when both sides have one and they agree. */
export function needAcceptsProvider(
	needProvider: string,
	provider: string | null,
) {
	return provider === null || provider === needProvider
}

export function findStoredRow(
	scope: PackageMappingScope,
	needKey: string,
	target: CredentialMappingRowTarget,
): CredentialMappingRow | null {
	return (
		scope.rows.find((row) => {
			if (row.needKey !== needKey) return false
			switch (target.target) {
				case 'org':
					return row.target.target === 'org'
				case 'mine':
					return row.target.target === 'mine'
				case 'enablement':
					return (
						row.target.target === 'enablement' &&
						row.target.enablementId === target.enablementId
					)
				default: {
					const exhaustive: never = target
					throw new Error(
						`Unhandled mapping target: ${JSON.stringify(exhaustive)}`,
					)
				}
			}
		}) ?? null
	)
}

export function refsForIds(
	scope: PackageMappingScope,
	ids: ReadonlyArray<string>,
): Array<CredentialRef> {
	const byId = new Map(
		scope.usable.map((credential) => [credential.id, credential]),
	)
	return ids.flatMap((id) => {
		const credential = byId.get(id)
		return credential ? [toCredentialRef(credential)] : []
	})
}

function storedView(
	scope: PackageMappingScope,
	row: CredentialMappingRow | null,
): StoredCredentialMapping | null {
	if (!row) return null
	const usableIds = new Set(scope.usable.map((credential) => credential.id))
	const username = row.updatedByUserId
		? scope.usernames.get(row.updatedByUserId)
		: undefined
	return {
		credentials: refsForIds(scope, row.credentialIds),
		unusableIds: row.credentialIds.filter((id) => !usableIds.has(id)),
		updatedAt: row.updatedAt,
		updatedBy: username ? { username } : null,
	}
}

function effectiveMapping(
	scope: PackageMappingScope,
	need: CredentialNeed,
	input: { trigger: CredentialMappingRow | null; createUrl: string },
): EffectiveCredentialMapping {
	const layer = (target: CredentialMappingRowTarget) =>
		findStoredRow(scope, need.key, target)?.credentialIds ?? null
	const stored = resolveStoredMapping({
		trigger: input.trigger?.credentialIds ?? null,
		mine: layer({ target: 'mine', personId: scope.actorId }),
		org: layer({ target: 'org' }),
		usable: scope.usable,
		accepts: (credential) =>
			needAcceptsKind(need.kind, credential.kind) &&
			needAcceptsProvider(need.provider, credential.provider),
	})
	const notReady = (
		status: Exclude<EffectiveCredentialMapping['status'], 'ready'>,
		source: EffectiveCredentialMapping['source'],
		candidates: Array<CredentialRef> = [],
	): EffectiveCredentialMapping => ({
		source,
		status,
		credentials: [],
		candidates,
		createUrl: input.createUrl,
	})
	if (stored) {
		switch (stored.status) {
			case 'ready':
				return {
					source: stored.source,
					status: 'ready',
					credentials: stored.credentials.map(toCredentialRef),
					candidates: [],
					createUrl: null,
				}
			case 'none':
				return notReady('none', stored.source)
			case 'unusable':
				return notReady('unusable', stored.source)
			default: {
				const exhaustive: never = stored
				throw new Error(
					`Unhandled mapping status: ${JSON.stringify(exhaustive)}`,
				)
			}
		}
	}
	const resolution = resolveNeedCandidates(need, scope.usable)
	if (resolution.autoPick) {
		return {
			source: 'auto',
			status: 'ready',
			credentials: [toCredentialRef(resolution.autoPick)],
			candidates: [],
			createUrl: null,
		}
	}
	return resolution.status === 'ambiguous'
		? notReady('ambiguous', 'auto', resolution.candidates.map(toCredentialRef))
		: notReady('unbound', 'auto')
}

function isIncomplete(
	status: EffectiveCredentialMapping['status'],
): status is PackageCredentialsIncomplete['status'] {
	return status === 'unbound' || status === 'ambiguous' || status === 'unusable'
}

export async function needCreateUrls(scope: PackageMappingScope) {
	const urls = await Promise.all(
		scope.needs.map(
			async (need) =>
				[
					need.key,
					await buildNeedCreateUrl({
						db: scope.env.APP_DB,
						baseUrl: scope.baseUrl,
						orgSlug: scope.request.org.slug,
						key: need.key,
						provider: need.provider,
						need,
						packageKodyId: scope.savedPackage.kodyId,
					}),
				] as const,
		),
	)
	return new Map(urls)
}

function lockedToPackage(
	items: ReadonlyArray<CredentialListItem>,
	packageId: string,
) {
	return items.filter(
		(item) =>
			item.packageId === packageId ||
			item.lockedToPackageIds.includes(packageId),
	)
}

export async function buildPackageCredentialsView(
	scope: PackageMappingScope,
): Promise<PackageCredentialsView> {
	const createUrls = await needCreateUrls(scope)
	const createUrlFor = (key: string) => createUrls.get(key)!
	const incomplete: Array<PackageCredentialsIncomplete> = []
	const needs = scope.needs.map((need): PackageCredentialNeedView => {
		const effective = effectiveMapping(scope, need, {
			trigger: null,
			createUrl: createUrlFor(need.key),
		})
		if (isIncomplete(effective.status)) {
			incomplete.push({
				needKey: need.key,
				where: { type: 'default' },
				status: effective.status,
			})
		}
		return {
			key: need.key,
			kind: need.kind ?? null,
			provider: need.provider,
			description: need.description,
			multiple: need.multiple,
			...(need.from ? { from: need.from } : {}),
			defaults: {
				org: storedView(
					scope,
					findStoredRow(scope, need.key, { target: 'org' }),
				),
				mine: storedView(
					scope,
					findStoredRow(scope, need.key, {
						target: 'mine',
						personId: scope.actorId,
					}),
				),
			},
			effective,
			options: scope.usable
				.filter(
					(credential) =>
						needAcceptsKind(need.kind, credential.kind) &&
						needAcceptsProvider(need.provider, credential.provider),
				)
				.map(toCredentialRef),
			createUrl: createUrlFor(need.key),
		}
	})
	// Webhooks list one DeclaredTrigger per minted URL; group by name so the
	// Triggers tab shows one card with every sibling enablement as an instance.
	const groupedTriggers = new Map<string, typeof scope.triggers>()
	for (const trigger of scope.triggers) {
		const key = `${trigger.kind}:${trigger.name}`
		const members = groupedTriggers.get(key)
		if (members) members.push(trigger)
		else groupedTriggers.set(key, [trigger])
	}
	const triggers = [...groupedTriggers.values()].map(
		(members): PackageTriggerView => {
			const primary = members[0]!
			const merged = {
				...primary,
				instanceId:
					members.find((member) => member.instanceId)?.instanceId ?? null,
				enablements: members.flatMap((member) => member.enablements),
			}
			const { enablement, otherEnabler } = viewerEnablement(
				merged,
				scope.actorId,
			)
			const ref = { kind: primary.kind, name: primary.name }
			const emailTopic =
				primary.kind === 'subscription' &&
				isInboundEmailApprovalTopic(primary.name)
			const ownRows = merged.enablements.filter(
				(row) => String(row.enablerUserId) === scope.actorId,
			)
			const liveOwnCount = ownRows.filter((row) => row.state !== 'off').length
			const mappingRowsFor = (
				row: EnablementRecord | null,
				options: { recordIncomplete: boolean },
			) =>
				otherEnabler
					? []
					: scope.needs.map((need) => {
							const override = row
								? findStoredRow(scope, need.key, {
										target: 'enablement',
										enablementId: row.id,
										personId: scope.actorId,
									})
								: null
							const effective = effectiveMapping(scope, need, {
								trigger: override,
								createUrl: createUrlFor(need.key),
							})
							if (
								options.recordIncomplete &&
								row &&
								isIncomplete(effective.status)
							) {
								incomplete.push({
									needKey: need.key,
									where: {
										type: 'trigger',
										trigger: ref,
										// Disambiguate only when the viewer has several live instances.
										...(liveOwnCount > 1 ? { enablementId: row.id } : {}),
									},
									status: effective.status,
								})
							}
							return {
								needKey: need.key,
								override: storedView(scope, override),
								effective,
							}
						})
			const canEditPrimary =
				primary.kind === 'webhook'
					? merged.instanceId !== null && !otherEnabler
					: true
			const labelFor = (row: EnablementRecord) =>
				members.find((member) => member.instanceId === row.instanceId)
					?.instanceLabel ?? null
			const instances: Array<PackageTriggerInstanceView> = otherEnabler
				? enablement
					? [
							{
								enablement: {
									id: enablement.id,
									state: enablement.state,
									enabledByYou: false,
								},
								canEdit: false,
								endpointId:
									primary.kind === 'webhook' ? enablement.instanceId : null,
								instanceLabel: labelFor(enablement),
								mappings: [],
							},
						]
					: []
				: ownRows.map((row) => ({
						enablement: {
							id: row.id,
							state: row.state,
							enabledByYou: true,
						},
						canEdit: canEditPrimary,
						endpointId: primary.kind === 'webhook' ? row.instanceId : null,
						instanceLabel: labelFor(row),
						mappings: mappingRowsFor(row, { recordIncomplete: true }),
					}))
			// An off trigger still lists need rows (null overrides) so the editor
			// can turn it on by saving a pick, same shape as before instances.
			const mappings = otherEnabler
				? []
				: (instances[0]?.mappings ??
					mappingRowsFor(null, { recordIncomplete: false }))
			return {
				trigger: ref,
				instanceId: merged.instanceId,
				enablement: enablement
					? {
							id: enablement.id,
							state: enablement.state,
							enabledByYou: !otherEnabler,
						}
					: null,
				canEdit: canEditPrimary,
				mappings,
				instances,
				canAddInstance:
					canEditPrimary && !emailTopic && merged.instanceId !== null,
			}
		},
	)
	const listed = await listCredentialsForViewer({
		env: scope.env,
		request: scope.request,
	})
	return {
		ok: true,
		package: {
			id: scope.savedPackage.id,
			kodyId: scope.savedPackage.kodyId,
			canManage: scope.canManage,
		},
		needs,
		triggers,
		locked: lockedToPackage(listed, scope.savedPackage.id),
		incomplete,
	}
}
