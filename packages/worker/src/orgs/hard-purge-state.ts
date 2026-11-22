import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { createAsyncLogic, setup, types } from 'xstate'
import { PurgeWebhookFailed } from './purge-webhook.ts'

export type PersonalOrgHardPurgeRelation =
	| 'soft_deleted_person'
	| 'live_person'
	| 'none'

export type OrgHardPurgeOutput =
	| { status: 'purged' }
	| { status: 'blocked_live_person' }
	| { status: 'purges_with_person' }
	| { status: 'webhook_failed'; error: PurgeWebhookFailed }
	| { status: 'failed'; error: unknown }

async function notProvided(): Promise<never> {
	throw new Error('hard purge actor was not provided')
}

const orgPurgeActors = {
	wipePinnedConnections: createAsyncLogic<void, { orgId: OwnerId }>({
		run: notProvided,
	}),
	deleteOrgData: createAsyncLogic<
		void,
		{ orgId: OwnerId; mode: 'team' | 'personal' }
	>({ run: notProvided }),
	auditOrgPurged: createAsyncLogic<void, { orgId: OwnerId }>({
		run: notProvided,
	}),
}

type OrgPurgeContext = {
	orgId: OwnerId
	webhookFailure: PurgeWebhookFailed | null
	error: unknown
}

/**
 * Hard purge of a soft-deleted team org. Personal orgs are refused before any
 * write; a team org wipes pinned connections while its apps exist, deletes
 * out-of-band storage, posts the purge webhook, then deletes its D1 rows, and
 * records `org.purged` last. A failed webhook keeps every D1 row.
 */
export const orgHardPurgeState = setup({
	schemas: {
		input: types<{ orgId: OwnerId }>(),
		context: types<OrgPurgeContext>(),
		output: types<OrgHardPurgeOutput>(),
	},
	actors: {
		...orgPurgeActors,
		readPersonalOrgRelation: createAsyncLogic<
			PersonalOrgHardPurgeRelation,
			{ orgId: OwnerId }
		>({ run: notProvided }),
		purgeOutOfBandSurfaces: createAsyncLogic<void, { orgId: OwnerId }>({
			run: notProvided,
		}),
		postPurgeWebhook: createAsyncLogic<void, { orgId: OwnerId }>({
			run: notProvided,
		}),
	},
	guards: {
		isWebhookFailure: (error: unknown): error is PurgeWebhookFailed =>
			error instanceof PurgeWebhookFailed,
		ownedByLivePerson: (relation: PersonalOrgHardPurgeRelation) =>
			relation === 'live_person',
		ownedBySoftDeletedPerson: (relation: PersonalOrgHardPurgeRelation) =>
			relation === 'soft_deleted_person',
	},
}).createMachine({
	id: 'org_hard_purge.team_org',
	description:
		'Refuses personal orgs, then wipes pinned connections, deletes out-of-band storage, posts the purge webhook, deletes D1 rows and the org row, and records org.purged; a failed webhook or any other failed step stops the purge for a later retry.',
	context: ({ input }) => ({
		orgId: input.orgId,
		webhookFailure: null,
		error: undefined,
	}),
	initial: 'checking_relation',
	states: {
		checking_relation: {
			invoke: {
				src: 'readPersonalOrgRelation',
				input: ({ context }) => ({ orgId: context.orgId }),
				onDone: ({ event, guards }) => {
					if (guards.ownedByLivePerson(event.output))
						return { target: 'blocked_live_person' }
					if (guards.ownedBySoftDeletedPerson(event.output))
						return { target: 'purges_with_person' }
					return { target: 'wiping_pinned_connections' }
				},
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		wiping_pinned_connections: {
			invoke: {
				src: 'wipePinnedConnections',
				input: ({ context }) => ({ orgId: context.orgId }),
				onDone: { target: 'purging_out_of_band' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		purging_out_of_band: {
			invoke: {
				src: 'purgeOutOfBandSurfaces',
				input: ({ context }) => ({ orgId: context.orgId }),
				onDone: { target: 'posting_purge_webhook' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		posting_purge_webhook: {
			invoke: {
				src: 'postPurgeWebhook',
				input: ({ context }) => ({ orgId: context.orgId }),
				onDone: { target: 'deleting_org_data' },
				onError: ({ context, event, guards }) => {
					if (guards.isWebhookFailure(event.error))
						return {
							target: 'webhook_failed',
							context: { ...context, webhookFailure: event.error },
						}
					return {
						target: 'failed',
						context: { ...context, error: event.error },
					}
				},
			},
		},
		deleting_org_data: {
			invoke: {
				src: 'deleteOrgData',
				input: ({ context }) => ({
					orgId: context.orgId,
					mode: 'team' as const,
				}),
				onDone: { target: 'auditing_org_purged' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		auditing_org_purged: {
			invoke: {
				src: 'auditOrgPurged',
				input: ({ context }) => ({ orgId: context.orgId }),
				onDone: { target: 'purged' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		purged: { type: 'final', output: { status: 'purged' as const } },
		blocked_live_person: {
			type: 'final',
			output: { status: 'blocked_live_person' as const },
		},
		purges_with_person: {
			type: 'final',
			output: { status: 'purges_with_person' as const },
		},
		webhook_failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'webhook_failed' as const,
				error: context.webhookFailure!,
			}),
		},
		failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'failed' as const,
				error: context.error,
			}),
		},
	},
})

export type PersonPurgeMode = 'soft_deleted' | 'legacy'

export type PersonPurgeRow = {
	stableUserId: string
	storageOwnerId: OwnerId
	personUserId: string
	deletedAt: string | null
	deletingAt: string | null
}

export type LegacyNotPendingReason = 'id_mismatch' | 'soft_deleted' | 'live'

export type PersonHardPurgeOutput =
	| { status: 'purged'; storageOwnerId: OwnerId }
	| { status: 'already_gone' }
	| { status: 'not_pending'; reason: LegacyNotPendingReason }
	| { status: 'row_not_removed' }
	| { status: 'webhook_failed'; error: PurgeWebhookFailed }
	| { status: 'failed'; error: unknown }

type PersonPurgeContext = {
	mode: PersonPurgeMode
	dbUserId: number
	stableUserId: OwnerId
	person: PersonPurgeRow | null
	personalOrgId: OwnerId | null
	deletedUserRows: number
	notPendingReason: LegacyNotPendingReason
	webhookFailure: PurgeWebhookFailed | null
	error: unknown
}

export type PersonPurgeTarget = {
	dbUserId: number
	stableUserId: OwnerId
	storageOwnerId: OwnerId
	personUserId: string
	personalOrgId: OwnerId | null
	mode: PersonPurgeMode
}

function target(context: PersonPurgeContext): PersonPurgeTarget {
	return {
		dbUserId: context.dbUserId,
		stableUserId: context.stableUserId,
		storageOwnerId: context.person?.storageOwnerId ?? context.stableUserId,
		personUserId: context.person?.personUserId ?? context.stableUserId,
		personalOrgId: context.personalOrgId,
		mode: context.mode,
	}
}

/**
 * Hard purge of a person and its personal org, for a soft-deleted user past
 * its window or an account deletion the pre-soft-delete flow left fenced.
 * Pinned connections go first while the owner's apps exist, account deletion
 * reads billing identity before the personal org rows are deleted, and
 * `user.purged` is recorded last. Account deletion posts the purge webhook for
 * the person and its personal org after Stripe and before any D1 row delete;
 * a failure for either half keeps both halves' rows.
 */
export const personHardPurgeState = setup({
	schemas: {
		input: types<{
			mode: PersonPurgeMode
			dbUserId: number
			stableUserId: OwnerId
		}>(),
		context: types<PersonPurgeContext>(),
		output: types<PersonHardPurgeOutput>(),
	},
	actors: {
		...orgPurgeActors,
		readPerson: createAsyncLogic<PersonPurgeRow | null, { dbUserId: number }>({
			run: notProvided,
		}),
		tombstonePersonalOrg: createAsyncLogic<
			void,
			{ orgId: OwnerId; deletedAt: string }
		>({ run: notProvided }),
		resolveSoftDeletedOrg: createAsyncLogic<OwnerId | null, { orgId: OwnerId }>(
			{
				run: notProvided,
			},
		),
		redactAuditActors: createAsyncLogic<void, { userId: OwnerId }>({
			run: notProvided,
		}),
		deleteAccount: createAsyncLogic<number, PersonPurgeTarget>({
			run: notProvided,
		}),
		readUserRowPresent: createAsyncLogic<boolean, { dbUserId: number }>({
			run: notProvided,
		}),
		auditUserPurged: createAsyncLogic<void, PersonPurgeTarget>({
			run: notProvided,
		}),
	},
	guards: {
		isWebhookFailure: (error: unknown): error is PurgeWebhookFailed =>
			error instanceof PurgeWebhookFailed,
		isLegacy: (context: PersonPurgeContext) => context.mode === 'legacy',
		hasPersonalOrg: (context: PersonPurgeContext) =>
			context.personalOrgId !== null,
		legacyRowMayRemain: (context: PersonPurgeContext) =>
			context.mode === 'legacy' && context.deletedUserRows === 0,
		personMissing: (person: PersonPurgeRow | null): person is null =>
			person === null,
		personIdMismatch: (context: PersonPurgeContext, person: PersonPurgeRow) =>
			person.stableUserId !== context.stableUserId,
		personSoftDeleted: (person: PersonPurgeRow) => Boolean(person.deletedAt),
		personNotFenced: (person: PersonPurgeRow) => !person.deletingAt,
		noSoftDeletedPersonalOrg: (orgId: OwnerId | null) => orgId === null,
		userRowRemains: (present: boolean) => present,
	},
}).createMachine({
	id: 'org_hard_purge.person',
	description:
		'Reads the person (a legacy retry also checks it is still a fenced, non-soft-deleted row and tombstones its personal org), then wipes pinned connections, redacts audit actors, deletes the account (posting the person and personal org purge webhooks after Stripe and before its row deletes; a failed webhook keeps both halves), deletes the personal org rows, verifies a legacy row is gone, and records user.purged.',
	context: ({ input }) => ({
		...input,
		person: null,
		personalOrgId: null,
		deletedUserRows: 0,
		notPendingReason: 'live',
		webhookFailure: null,
		error: undefined,
	}),
	initial: 'reading_person',
	states: {
		reading_person: {
			invoke: {
				src: 'readPerson',
				input: ({ context }) => ({ dbUserId: context.dbUserId }),
				onDone: ({ context, event, guards }) => {
					const person = event.output
					if (!guards.isLegacy(context))
						return {
							target: 'resolving_personal_org',
							context: { ...context, person },
						}
					if (guards.personMissing(person)) return { target: 'already_gone' }
					if (guards.personIdMismatch(context, person))
						return {
							target: 'not_pending',
							context: { ...context, notPendingReason: 'id_mismatch' as const },
						}
					if (guards.personSoftDeleted(person))
						return {
							target: 'not_pending',
							context: {
								...context,
								notPendingReason: 'soft_deleted' as const,
							},
						}
					if (guards.personNotFenced(person))
						return {
							target: 'not_pending',
							context: { ...context, notPendingReason: 'live' as const },
						}
					return {
						target: 'tombstoning_personal_org',
						context: { ...context, person },
					}
				},
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		tombstoning_personal_org: {
			invoke: {
				src: 'tombstonePersonalOrg',
				input: ({ context }) => ({
					orgId: context.person!.storageOwnerId,
					deletedAt: context.person!.deletingAt!,
				}),
				onDone: { target: 'resolving_personal_org' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		resolving_personal_org: {
			invoke: {
				src: 'resolveSoftDeletedOrg',
				input: ({ context }) => ({ orgId: target(context).storageOwnerId }),
				onDone: ({ context, event, guards }) => {
					if (guards.noSoftDeletedPersonalOrg(event.output))
						return { target: 'redacting_audit_actors' }
					return {
						target: 'wiping_pinned_connections',
						context: { ...context, personalOrgId: event.output },
					}
				},
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		wiping_pinned_connections: {
			invoke: {
				src: 'wipePinnedConnections',
				input: ({ context }) => ({ orgId: context.personalOrgId! }),
				onDone: { target: 'redacting_audit_actors' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		redacting_audit_actors: {
			invoke: {
				src: 'redactAuditActors',
				input: ({ context }) => ({ userId: context.stableUserId }),
				onDone: { target: 'deleting_account' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		deleting_account: {
			invoke: {
				src: 'deleteAccount',
				input: ({ context }) => target(context),
				onDone: ({ context, event, guards }) => {
					const next = { ...context, deletedUserRows: event.output }
					if (guards.hasPersonalOrg(next))
						return { target: 'deleting_personal_org_data', context: next }
					if (guards.legacyRowMayRemain(next))
						return { target: 'verifying_row_removed', context: next }
					return { target: 'auditing_user_purged', context: next }
				},
				onError: ({ context, event, guards }) => {
					if (guards.isWebhookFailure(event.error))
						return {
							target: 'webhook_failed',
							context: { ...context, webhookFailure: event.error },
						}
					return {
						target: 'failed',
						context: { ...context, error: event.error },
					}
				},
			},
		},
		deleting_personal_org_data: {
			invoke: {
				src: 'deleteOrgData',
				input: ({ context }) => ({
					orgId: context.personalOrgId!,
					mode: 'personal' as const,
				}),
				onDone: { target: 'auditing_personal_org_purged' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		auditing_personal_org_purged: {
			invoke: {
				src: 'auditOrgPurged',
				input: ({ context }) => ({ orgId: context.personalOrgId! }),
				onDone: ({ context, guards }) => {
					if (guards.legacyRowMayRemain(context))
						return { target: 'verifying_row_removed' }
					return { target: 'auditing_user_purged' }
				},
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		verifying_row_removed: {
			invoke: {
				src: 'readUserRowPresent',
				input: ({ context }) => ({ dbUserId: context.dbUserId }),
				onDone: ({ event, guards }) => {
					if (guards.userRowRemains(event.output))
						return { target: 'row_not_removed' }
					return { target: 'auditing_user_purged' }
				},
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		auditing_user_purged: {
			invoke: {
				src: 'auditUserPurged',
				input: ({ context }) => target(context),
				onDone: { target: 'purged' },
				onError: ({ context, event }) => ({
					target: 'failed',
					context: { ...context, error: event.error },
				}),
			},
		},
		purged: {
			type: 'final',
			output: ({ context }) => ({
				status: 'purged' as const,
				storageOwnerId: target(context).storageOwnerId,
			}),
		},
		already_gone: {
			type: 'final',
			output: { status: 'already_gone' as const },
		},
		not_pending: {
			type: 'final',
			output: ({ context }) => ({
				status: 'not_pending' as const,
				reason: context.notPendingReason,
			}),
		},
		row_not_removed: {
			type: 'final',
			output: { status: 'row_not_removed' as const },
		},
		webhook_failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'webhook_failed' as const,
				error: context.webhookFailure!,
			}),
		},
		failed: {
			type: 'final',
			output: ({ context }) => ({
				status: 'failed' as const,
				error: context.error,
			}),
		},
	},
})
