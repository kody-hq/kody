import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { findPublicOwnerIdentityByHandle } from '#worker/identity/user-lookup.ts'
import { isPaidOrg } from '#worker/orgs/billing.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { resolveEntitlementLimit } from '#universal/plans.ts'
import {
	assertWithinEntitlement,
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryBytes,
	resolveBaseUserEntitlement,
} from '#worker/entitlements/service.ts'
import { recordUsage } from '#worker/usage/record-usage.ts'
import { normalizeEmailAddress, normalizeSubject } from './address.ts'
import { ensureDefaultEmailInbox } from './default-inbox.ts'
import { evaluateEmailSenderRules } from './sender-rules.ts'
import {
	InboundRawMimeTooLargeError,
	maxSurvivableInboundRawBytes,
	mergePreparedInboundParse,
	parseForwardableEmailRawMime,
	readAndPrepareForwardableEmailRawMime,
} from './parser.ts'
import {
	buildInboundDelivery,
	readUserInboundReceiveCount,
	type InboundDelivery,
	userInboundQuotaDay,
} from './inbound-delivery.ts'
import {
	createUserInboundDeliveryAuthority,
	type UserInboundDeliveryAuthority,
	type UserInboundDeliveryAuthorityEnv,
} from './inbound-delivery-authority.ts'
import { assertUserEmailGraphAuthority } from './user-email-graph-authority.ts'
import {
	pruneUserExpiredInboundDedupePointers,
	reconcileUserStaleInboundDeliveries,
} from './inbound-delivery-reconciliation-authority.ts'
import {
	getAcceptedSystemEmailDomains,
	getAcceptedUserEmailDomains,
	getSystemEmailDomain,
} from './platform-address.ts'
import {
	scheduleInboundReceivedTerminalWork,
	scheduleInboundRejectedTerminalWork,
	type InboundMailboxEnv,
} from './inbound-mailbox.ts'
import { resolveInboundMailboxRoute } from './inbound-mailbox-route.ts'
import {
	countInternalUserEmailMessages,
	getInternalEmailMessageById,
} from './mailbox-internal-read.ts'
import {
	recordEmailReportingEvent,
	type EmailReportingEnv,
} from './reporting-events.ts'
import {
	recordBoundedEmailRejectionEvent,
	RetryableInboundStorageError,
	storeIdempotentInboundEmail,
} from './service.ts'
import { handleSystemInboundEmail } from './system-inbound-email.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

type InboundMailboxAccountRow = {
	actor_person_id: string | null
	email: string | null
	plan: string | null
	stripe_plan: string | null
	entitlement_ladder: string | null
	stripe_credits_eligible: number | null
	admin_credits_eligible: number | null
	email_verified_at: string | null
	suspended_at: string | null
}

/**
 * Personal orgs keep the account email's verified and suspended gates.
 * Team orgs are already live (`findPublicOwnerIdentityByHandle` uses
 * `andActiveOrgSql`); their plan comes from `orgs` and must be paid.
 */
async function loadInboundMailboxAccount(db: D1Database, ownerId: OwnerId) {
	const personal = await isPersonalOrg(db, ownerId)
	if (personal) {
		// ownerId is the personal org id (mailbox owner). Match via
		// personal_org_id or legacy equal-id stable_user_id.
		const row = await db
			.prepare(
				`SELECT u.stable_user_id AS actor_person_id, u.email AS email, o.plan AS plan, o.stripe_plan AS stripe_plan,
				        o.entitlement_ladder AS entitlement_ladder,
				        o.stripe_credits_eligible AS stripe_credits_eligible,
				        o.admin_credits_eligible AS admin_credits_eligible,
				        u.email_verified_at AS email_verified_at,
				        u.suspended_at AS suspended_at
				 FROM users u
				 LEFT JOIN orgs o ON o.id = COALESCE(NULLIF(TRIM(u.personal_org_id), ''), u.stable_user_id)${andLiveDeletedAtSql('o')}
				 WHERE (
				 	(u.personal_org_id IS NOT NULL AND TRIM(u.personal_org_id) != '' AND u.personal_org_id = ?)
				 	OR ((u.personal_org_id IS NULL OR TRIM(u.personal_org_id) = '') AND u.stable_user_id = ?)
				 )${andLiveDeletedAtSql('u')}`,
			)
			.bind(ownerId, ownerId)
			.first<InboundMailboxAccountRow>()
		return { personal: true as const, row }
	}
	const row = await db
		.prepare(
			`SELECT NULL AS actor_person_id, NULL AS email, plan, stripe_plan, entitlement_ladder,
			        stripe_credits_eligible, admin_credits_eligible,
			        NULL AS email_verified_at, NULL AS suspended_at
			 FROM orgs
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(ownerId)
		.first<InboundMailboxAccountRow>()
	return { personal: false as const, row }
}

/**
 * Rejection audit writes are best-effort (the SMTP reject already happened),
 * but a failure must still be visible to operators — silently losing the
 * rejection trail weakens abuse detection on attacker-controlled paths.
 */
function warnRejectionAuditWriteFailed(error: unknown) {
	console.warn('email-rejection-audit-write-failed', error)
}

async function rejectClaimedInboundDelivery(input: {
	message: ForwardableEmailMessage
	delivery: InboundDelivery
	reason: string
	authority: UserInboundDeliveryAuthority
}) {
	const transitioned = await input.authority
		.reject(input.delivery, input.reason)
		.catch((error: unknown) => {
			warnRejectionAuditWriteFailed(error)
			throw error
		})
	if (transitioned) input.message.setReject(input.reason)
	return transitioned
}

function estimateInboundEmailStorageBytes(input: {
	message: ForwardableEmailMessage
	recipient: string
	keptRawSize: number
}) {
	return (
		input.keptRawSize * 2 +
		estimateEntitlementStorageEntryBytes({
			value: {
				from: input.message.from,
				to: input.message.to,
				recipient: input.recipient,
				headers: Object.fromEntries(input.message.headers.entries()),
			},
		})
	)
}

async function parseAndStoreInboundEmail(input: {
	db: D1Database
	blobs: R2Bucket
	delivery: InboundDelivery
	parsed: Awaited<ReturnType<typeof parseForwardableEmailRawMime>>
	authority: UserInboundDeliveryAuthority
}) {
	if (!input.authority) {
		throw new Error('User inbound storage requires Mailbox authority.')
	}
	const now = new Date().toISOString()
	try {
		return await storeIdempotentInboundEmail({
			db: input.db,
			blobs: input.blobs,
			delivery: input.delivery,
			parsed: input.parsed,
			subjectNormalized: normalizeSubject(input.parsed.subject),
			now,
			authority: input.authority,
		})
	} catch (error) {
		if (error instanceof RetryableInboundStorageError) throw error
		throw new RetryableInboundStorageError(
			'Failed to store inbound email before durable commit; delivery should be retried.',
			error,
		)
	}
}

async function cleanupInboundDurability(input: {
	env: UserInboundDeliveryAuthorityEnv & { EMAIL_BLOBS: R2Bucket }
	userId: OwnerId
}) {
	try {
		await reconcileUserStaleInboundDeliveries(input)
		await pruneUserExpiredInboundDedupePointers(input)
	} catch (error) {
		console.warn('inbound-email-durability-cleanup-failed', input.userId, error)
	}
}

export async function handleInboundEmail(
	message: ForwardableEmailMessage,
	inputEnv: Pick<
		Env,
		| 'APP_DB'
		| 'EMAIL_BLOBS'
		| 'BUNDLE_ARTIFACTS_KV'
		| 'APP_BASE_URL'
		| 'USER_EMAIL_DOMAIN'
		| 'SYSTEM_EMAIL_DOMAIN'
		| 'LEGACY_USER_EMAIL_DOMAINS'
		| 'LEGACY_SYSTEM_EMAIL_DOMAINS'
		| 'USAGE_EVENTS'
		| 'USER_METER'
		| 'MAILBOX'
		| 'EMAIL_EVENTS'
	> &
		EmailReportingEnv &
		InboundMailboxEnv,
	ctx?: ExecutionContext,
) {
	// Inbound accepts the canonical domains plus any LEGACY_*_EMAIL_DOMAINS;
	// mail on those addresses resolves to the same inboxes. Outbound
	// (senders, alert lanes) always uses the canonical domains only.
	const acceptedUserDomains = getAcceptedUserEmailDomains(inputEnv)
	const acceptedSystemDomains = getAcceptedSystemEmailDomains(inputEnv)
	const systemDomain = getSystemEmailDomain(inputEnv)
	const route = resolveInboundMailboxRoute({
		envelopeTo: message.to,
		acceptedUserDomains,
		acceptedSystemDomains,
		systemDomain,
	})
	switch (route.kind) {
		case 'reject':
			message.setReject(route.reason)
			return
		case 'system':
			await handleSystemInboundEmail({
				message,
				env: inputEnv,
				recipient: route.recipient,
				localPart: route.localBase,
				// Replies and threading always use the canonical system domain,
				// even when the message arrived on a legacy one.
				systemDomain: route.systemDomain,
				ctx,
			})
			return
		case 'org':
			break
		default: {
			const exhaustive: never = route
			throw new Error(
				`Unsupported inbound mailbox route: ${String(exhaustive)}`,
			)
		}
	}
	const recipient = route.recipient
	const localPart = route.localPart
	// Provisioning always records the canonical address (first accepted
	// domain), even when the message arrived on a legacy domain.
	const platformDomain = acceptedUserDomains[0]
	if (!platformDomain) {
		message.setReject('Email routing is not configured.')
		return
	}
	const env = {
		...inputEnv,
		APP_DB: inputEnv.APP_DB,
	}

	const identity = await findPublicOwnerIdentityByHandle({
		db: env.APP_DB,
		handle: localPart,
	})
	if (!identity) {
		message.setReject('Unknown Kody email address.')
		return
	}

	const ownerId = identity.ownerId
	// Mailbox, quota, and storage are keyed by org id (personal or team).
	const userId = ownerId
	return await withAccountWriteLease({
		db: env.APP_DB,
		stableUserId: userId,
		env,
		async write() {
			await assertUserEmailGraphAuthority({
				db: env.APP_DB,
				ownerId: userId,
			})
			const authority = createUserInboundDeliveryAuthority({ env, userId })
			// Require email + canonical stable id together (same contract as
			// getUserPlan / isAccountEmailVerified) so a mismatched identity pair
			// cannot apply another account's plan or verification state.
			const loadedAccount = await loadInboundMailboxAccount(env.APP_DB, userId)
			const accountRow = loadedAccount.row
			// A missing org (or missing user) keeps the synthetic max plan.
			// Verification and suspension still come from the users row.
			const orgPlan = accountRow?.plan
			const accountEntitlement = await resolveBaseUserEntitlement({
				db: env.APP_DB,
				stableUserId: userId,
				row: orgPlan
					? {
							plan: orgPlan,
							stripe_plan: accountRow?.stripe_plan ?? null,
							entitlement_ladder: accountRow?.entitlement_ladder ?? null,
							stripe_credits_eligible: accountRow?.stripe_credits_eligible ?? 0,
							admin_credits_eligible: accountRow?.admin_credits_eligible ?? 0,
						}
					: {
							plan: 'max',
							stripe_plan: null,
							entitlement_ladder: null,
							stripe_credits_eligible: 0,
							admin_credits_eligible: 0,
						},
			})
			const account = {
				personal: loadedAccount.personal,
				email: accountRow?.email ?? null,
				entitlement: accountEntitlement,
				plan: accountEntitlement.plan,
				ladder: accountEntitlement.ladder,
				creditWallet: accountEntitlement.creditWallet,
				emailVerified: Boolean(accountRow?.email_verified_at),
				suspended: Boolean(accountRow?.suspended_at),
			}

			const provisioned = await ensureDefaultEmailInbox({
				db: env.APP_DB,
				userId,
				actorPersonId: accountRow?.actor_person_id ?? userId,
				username: identity.handle,
				domain: platformDomain,
			})
			if (!provisioned) {
				message.setReject('Email inbox is unavailable.')
				return
			}
			const { inbox } = provisioned
			if (!inbox.enabled) {
				message.setReject('Email inbox is disabled.')
				return
			}

			const receiveStartedAtMs = Date.now()
			const recordReceiveUsage = async (input: {
				entityId?: string | null
				outcome: 'success' | 'error'
			}) => {
				await recordUsage(env, {
					userId,
					eventType: 'email_received',
					entityId: input.entityId ?? null,
					bytes: message.rawSize,
					durationMs: Date.now() - receiveStartedAtMs,
					outcome: input.outcome,
					actorUserId: '',
					automationSource: 'email',
				})
			}

			// Inbound volume is attacker-controlled (anyone can send to a
			// {handle}@<platform domain> address), so every fail-closed gate runs
			// before any parsing work, cheapest rejection first: verified account,
			// per-message size cap, storage bytes, per-day receive rate, and
			// stored-message cap (entitlements, including max-plan email caps).

			// Verified-account gate first: an unverified account can never receive
			// mail, so the attempt must not consume any of the daily receive quota
			// or trip the other counters. Rejection rows go through the bounded
			// recorder because unverified-alias floods are the same
			// attacker-controlled row-growth shape as over-quota floods.
			if (account.personal && !account.emailVerified) {
				const reason = 'Account email is not verified.'
				message.setReject(reason)
				await recordBoundedEmailRejectionEvent({
					env,
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					recipient,
					reason,
					phase: 'account-verification',
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
				return
			}

			// A free team org has a live handle but cannot receive mail.
			// Personal orgs keep the free plan's own receive caps. Use the
			// effective entitlement (stripe_plan ranked in), not orgs.plan alone.
			if (!account.personal && !isPaidOrg(account.plan)) {
				const reason = 'Team email requires a paid plan.'
				message.setReject(reason)
				await recordBoundedEmailRejectionEvent({
					env,
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					recipient,
					reason,
					phase: 'account-plan',
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
				return
			}

			// A platform-suspended account cannot receive mail either; the
			// rejection goes through the same bounded recorder so suspended
			// aliases cannot be used to grow storage.
			if (account.personal && account.suspended) {
				const reason = 'Account is suspended.'
				message.setReject(reason)
				await recordBoundedEmailRejectionEvent({
					env,
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					recipient,
					reason,
					phase: 'account-suspension',
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
				return
			}

			const senderAddress = normalizeEmailAddress(message.from)
			if (senderAddress) {
				const senderRule = await evaluateEmailSenderRules({
					db: env.APP_DB,
					userId,
					senderAddress,
				})
				if (senderRule?.effect === 'block') {
					const reason = 'Message rejected by recipient policy.'
					message.setReject(reason)
					await recordBoundedEmailRejectionEvent({
						env,
						db: env.APP_DB,
						userId,
						inboxId: inbox.id,
						recipient,
						reason,
						phase: 'sender-policy',
					}).catch(warnRejectionAuditWriteFailed)
					await recordReceiveUsage({ outcome: 'error' })
					return
				}
			}

			if (message.rawSize > maxSurvivableInboundRawBytes) {
				message.setReject('Recipient mailbox is over quota.')
				await recordBoundedEmailRejectionEvent({
					env,
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					recipient,
					reason: `Inbound email raw MIME is too large (${message.rawSize} bytes, max ${maxSurvivableInboundRawBytes}).`,
					phase: 'size',
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
				return
			}

			await cleanupInboundDurability({
				env,
				userId,
			})
			const keepCap = resolveEntitlementLimit(
				account.entitlement,
				'email_message_bytes',
			)
			let prepared
			try {
				prepared = await readAndPrepareForwardableEmailRawMime(message, {
					maxKeptBytes: keepCap,
				})
			} catch (error) {
				// Unsurvivable size is permanent. Reject instead of asking
				// Email Routing to retry a read that can never succeed.
				if (error instanceof InboundRawMimeTooLargeError) {
					message.setReject('Recipient mailbox is over quota.')
					await recordBoundedEmailRejectionEvent({
						env,
						db: env.APP_DB,
						userId,
						inboxId: inbox.id,
						recipient,
						reason: error.message,
						phase: 'size',
					}).catch(warnRejectionAuditWriteFailed)
					await recordReceiveUsage({ outcome: 'error' })
					return
				}
				throw new RetryableInboundStorageError(
					'Failed to read inbound raw MIME; delivery should be retried.',
					error,
				)
			}
			try {
				await assertWithinEntitlement({
					db: env.APP_DB,
					userId,
					email: account.email,
					resource: 'email_message_bytes',
					requested: 0,
					getCurrent: async () => prepared.keptRawSize,
				})
			} catch (error) {
				if (!isEntitlementLimitError(error)) throw error
				message.setReject('Recipient mailbox is over quota.')
				await recordBoundedEmailRejectionEvent({
					env,
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					recipient,
					reason: error.message,
					phase: 'size',
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
				return
			}
			const quotaNow = new Date()
			const candidateDelivery = await buildInboundDelivery({
				userId,
				inboxId: inbox.id,
				recipient,
				envelopeFrom: message.from,
				rawMime: prepared.rawMime,
				quotaDay: userInboundQuotaDay(quotaNow),
				now: quotaNow,
			})
			const activeWindow = await authority.getWindow(
				candidateDelivery.fingerprint,
				quotaNow,
			)
			const delivery = activeWindow ?? candidateDelivery
			let existingDelivery = await authority.get(delivery.deliveryId)
			if (!existingDelivery) {
				try {
					// New deliveries check storage bytes and stored-message caps
					// before their durable quota claim. A retry with an existing
					// ledger bypasses both so already-charged mail can still repair
					// after unrelated writes fill the mailbox.
					await assertWithinStorageBytesEntitlement({
						db: env.APP_DB,
						env,
						userId,
						email: account.email,
						requested: estimateInboundEmailStorageBytes({
							message,
							recipient,
							keptRawSize: prepared.keptRawSize,
						}),
					})
					await assertWithinEntitlement({
						db: env.APP_DB,
						userId,
						email: account.email,
						resource: 'stored_email_messages',
						getCurrent: async () =>
							await countInternalUserEmailMessages({
								env,
								ownerId: userId,
							}),
					})
					const receiveLimit = resolveEntitlementLimit(
						account.entitlement,
						'email_receives_per_day',
					)
					const receivesToday = await readUserInboundReceiveCount({
						db: env.APP_DB,
						env,
						userId,
						day: userInboundQuotaDay(quotaNow),
						now: quotaNow,
					})
					if (receivesToday >= receiveLimit) {
						message.setReject('Recipient mailbox is over quota.')
						await recordBoundedEmailRejectionEvent({
							env,
							db: env.APP_DB,
							userId,
							inboxId: inbox.id,
							recipient,
							reason: `Daily receive cap ${receiveLimit} reached.`,
							phase: 'entitlement',
						}).catch(warnRejectionAuditWriteFailed)
						await recordReceiveUsage({ outcome: 'error' })
						return
					}
				} catch (error) {
					if (!isEntitlementLimitError(error)) throw error
					message.setReject('Recipient mailbox is over quota.')
					await recordBoundedEmailRejectionEvent({
						env,
						db: env.APP_DB,
						userId,
						inboxId: inbox.id,
						recipient,
						reason: error.message,
						phase: 'entitlement',
					}).catch(warnRejectionAuditWriteFailed)
					await recordReceiveUsage({ outcome: 'error' })
					return
				}
			}
			let claimedDelivery: InboundDelivery
			let chargedReceive = false
			try {
				if (existingDelivery) {
					claimedDelivery = existingDelivery
				} else {
					const chargeCandidate = {
						...delivery,
						quotaDay: userInboundQuotaDay(quotaNow),
					}
					const chargeResult = await authority.charge({
						delivery: chargeCandidate,
						plan: account.plan,
						limit: resolveEntitlementLimit(
							account.entitlement,
							'email_receives_per_day',
						),
						now: quotaNow,
					})
					claimedDelivery = chargeResult.delivery
					chargedReceive = chargeResult.charged
				}
			} catch (error) {
				if (!isEntitlementLimitError(error)) throw error
				message.setReject('Recipient mailbox is over quota.')
				await recordBoundedEmailRejectionEvent({
					env,
					db: env.APP_DB,
					userId,
					inboxId: inbox.id,
					recipient,
					reason: error.message,
					phase: 'entitlement',
				}).catch(warnRejectionAuditWriteFailed)
				await recordReceiveUsage({ outcome: 'error' })
				return
			}
			if (chargedReceive) {
				recordEmailReportingEvent(env, {
					userId,
					eventType: 'email_receive',
					timestamp: quotaNow.toISOString(),
				})
			}
			if (claimedDelivery.state === 'rejected') {
				message.setReject(
					claimedDelivery.rejectionReason ?? 'Failed to parse inbound email.',
				)
				await scheduleInboundRejectedTerminalWork({
					env,
					userId,
					deliveryId: claimedDelivery.deliveryId,
					ctx,
				})
				return
			}
			if (claimedDelivery.state === 'received') {
				const existing = await getInternalEmailMessageById({
					env,
					ownerId: userId,
					messageId: claimedDelivery.messageId,
				})
				if (existing) {
					await scheduleInboundReceivedTerminalWork({
						env,
						userId,
						messageId: claimedDelivery.messageId,
						deliveryId: claimedDelivery.deliveryId,
						expectedFinalizationToken: claimedDelivery.finalizationToken,
						durationMs: Date.now() - receiveStartedAtMs,
						ctx,
						logLabel: 'Inbound email effect reconciliation failed',
					})
					return
				}
			}
			let parsed
			try {
				parsed = mergePreparedInboundParse(
					await parseForwardableEmailRawMime(message, prepared.rawMime),
					prepared,
				)
			} catch (error) {
				const reason =
					error instanceof Error
						? error.message
						: 'Failed to parse inbound email.'
				const rejected = await rejectClaimedInboundDelivery({
					message,
					delivery: claimedDelivery,
					reason,
					authority,
				})
				if (!rejected) return
				await recordReceiveUsage({ outcome: 'error' })
				await scheduleInboundRejectedTerminalWork({
					env,
					userId,
					deliveryId: claimedDelivery.deliveryId,
					ctx,
				})
				return
			}
			const storageClaim = await authority.claimStorage(
				claimedDelivery,
				parsed.attachments.length,
				new Date(receiveStartedAtMs).toISOString(),
			)
			if (!storageClaim.claimed) {
				if (storageClaim.delivery?.state === 'received') {
					await scheduleInboundReceivedTerminalWork({
						env,
						userId,
						messageId: claimedDelivery.messageId,
						deliveryId: storageClaim.delivery.deliveryId,
						expectedFinalizationToken: storageClaim.delivery.finalizationToken,
						durationMs: Date.now() - receiveStartedAtMs,
						ctx,
						logLabel: 'Inbound email effect reconciliation failed',
					})
					return
				}
				throw new RetryableInboundStorageError(
					'Inbound delivery is already being stored; retry the stable delivery.',
				)
			}
			let storedResult
			try {
				storedResult = await parseAndStoreInboundEmail({
					db: env.APP_DB,
					blobs: env.EMAIL_BLOBS,
					delivery: storageClaim.delivery,
					parsed,
					authority,
				})
			} catch (error) {
				await authority
					.releaseStorage(storageClaim.delivery)
					.catch((releaseError) => {
						console.error(
							'inbound-email-storage-lease-release-failed',
							storageClaim.delivery.deliveryId,
							releaseError,
						)
					})
				throw error
			}
			if (!storedResult.wonFinalization) return
			await scheduleInboundReceivedTerminalWork({
				env,
				userId,
				messageId: storedResult.finalizedDelivery.messageId,
				deliveryId: storedResult.finalizedDelivery.deliveryId,
				expectedFinalizationToken:
					storedResult.finalizedDelivery.finalizationToken,
				durationMs: Date.now() - receiveStartedAtMs,
				ctx,
				logLabel: 'Inbound email effect dispatch failed',
			})
		},
	})
}
