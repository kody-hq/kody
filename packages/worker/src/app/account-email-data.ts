import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { authorize } from '#worker/authorization/authorize.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import {
	entitlementEmailForOwner,
	ownerIdFromCaller,
} from '#worker/request-context/owner-id.ts'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import { type readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	emailVerificationRequiredMessage,
	isAccountEmailVerified,
} from '#app/email-verification.ts'
import { toMessageDetail } from '#mcp/capabilities/email/shared.ts'
import {
	getOwnerEmailMessageById,
	listOwnerEmailAttachmentsForMessage,
	listOwnerEmailDeliveryEvents,
	listOwnerEmailMessagesPage,
} from '#worker/email/owner-email-reader.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { classifyInboundEmailSender } from '#worker/email/inbound-sender.ts'
import {
	buildPlatformEmailAddress,
	getPlatformEmailDomain,
} from '#worker/email/platform-address.ts'
import {
	listEmailInboxAddressesForUser,
	listEmailInboxesForUser,
} from '#worker/email/repo.ts'
import {
	emailClassificationValues,
	type EmailClassification,
	type EmailDeliveryStatus,
	type EmailDirection,
	type EmailMessageRecord,
	type EmailProcessingStatus,
} from '#worker/email/types.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { resolveEntitlementLimit, type PlanName } from '#universal/plans.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	getUserEntitlement,
	readCurrentEntitlementResourceUsage,
	readDailyEntitlementResourceUsage,
	type EntitlementUsageEnv,
} from '#worker/entitlements/service.ts'
import { readPagination } from '#worker/query-params.ts'
import { loadOutboundDeliveryPause } from '#worker/email/outbound-consecutive-failures.ts'

type AuthenticatedUser = NonNullable<
	Awaited<ReturnType<typeof readAuthenticatedAppUser>>
>

const accountEmailBasePath = '/account/email'
const defaultPageSize = 25
const maxPageSize = 100
const deliveryEventsLimit = 25

export type AccountEmailUsageEntry = {
	count: number
	limit: number
}

export type AccountEmailUsage = {
	plan: PlanName
	day: string
	stored_messages: AccountEmailUsageEntry
	sends_today: AccountEmailUsageEntry
	receives_today: AccountEmailUsageEntry
	max_message_bytes: number
}

export type AccountEmailInboxAddress = {
	id: string
	address: string
	enabled: boolean
	created_at: string
}

export type AccountEmailInbox = {
	id: string
	name: string
	description: string
	enabled: boolean
	addresses: Array<AccountEmailInboxAddress>
	created_at: string
	updated_at: string
}

export type AccountEmailSenderClassification =
	| 'member'
	| 'authenticated'
	| 'unverified'

export type AccountEmailEnableSender = {
	sender: { kind: 'member' | 'address'; value: string }
	topic: 'email.message.received' | 'email.message.quarantined'
	org_slug: string
	packages_href: string
	packages: Array<{ kody_id: string }>
}

export type AccountEmailMessageListItem = {
	id: string
	direction: EmailDirection
	inbox_id: string | null
	thread_id: string | null
	from_address: string | null
	envelope_from: string | null
	to_addresses: Array<string>
	subject: string | null
	message_id_header: string | null
	processing_status: EmailProcessingStatus
	classification: EmailClassification
	classification_reason: string | null
	/** Null for outbound mail, which has no inbound sender to classify. */
	sender_classification: AccountEmailSenderClassification | null
	sender_classification_reason: string | null
	provider_message_id: string | null
	delivery_status: EmailDeliveryStatus | null
	delivery_status_at: string | null
	error: string | null
	received_at: string | null
	sent_at: string | null
	created_at: string
	updated_at: string
}

export type AccountEmailAttachment = {
	id: string
	filename: string | null
	content_type: string | null
	content_id: string | null
	disposition: string | null
	size: number | null
	storage_kind: string
	storage_key: string | null
	created_at: string
}

export type AccountEmailDeliveryEvent = {
	id: string
	event_type: string
	provider: string | null
	provider_message_id: string | null
	provider_event_id: string | null
	detail_json: string
	created_at: string
}

export type AccountEmailMessageDetail = AccountEmailMessageListItem & {
	cc_addresses: Array<string>
	bcc_addresses: Array<string>
	reply_to_addresses: Array<string>
	in_reply_to_header: string | null
	references: Array<string>
	headers: Record<string, unknown> | null
	auth_results: string | null
	text_body: string | null
	html_body: string | null
	raw_size: number | null
	attachments: Array<AccountEmailAttachment>
	delivery_events: Array<AccountEmailDeliveryEvent>
	/** Package approval for this sender. Null when the sender cannot be enabled. */
	enable_sender: AccountEmailEnableSender | null
}

/**
 * Loader payload for `/account/email`. Types live here until the integrator
 * adds `accountEmail` to `AppLoaderData`.
 */
export type AccountEmailLoaderData = {
	ok: true
	emailVerified: boolean
	email: string
	username: string
	/** Platform-assigned `{username}@<platform domain>` when configured. */
	inboxAddress: string | null
	verificationMessage: string | null
	outboundDeliveryPausedAt: string | null
	inboxes: Array<AccountEmailInbox>
	messages: Array<AccountEmailMessageListItem>
	selectedMessage: AccountEmailMessageDetail | null
	usage: AccountEmailUsage | null
	page: number
	pageSize: number
	total: number
	query: string
	/** `null` means no classification filter (all messages). */
	classification: EmailClassification | null
}

export function readAccountEmailSelectedMessageId(
	requestUrl: string,
	pathMessageId?: string,
) {
	if (pathMessageId?.trim()) return pathMessageId.trim()
	const url = new URL(requestUrl, 'http://localhost')
	const detailPrefix = `${accountEmailBasePath}/`
	if (url.pathname.startsWith(detailPrefix)) {
		const segment = url.pathname.slice(detailPrefix.length)
		if (segment && !segment.includes('/')) {
			try {
				const messageId = decodeURIComponent(segment)
				if (messageId) return messageId
			} catch {
				if (segment) return segment
			}
		}
	}
	return url.searchParams.get('selected')?.trim() || null
}

export function readAccountEmailClassificationFilter(
	requestUrl: string,
): EmailClassification | null {
	const url = new URL(requestUrl, 'http://localhost')
	const raw = url.searchParams.get('classification')?.trim() ?? ''
	return (emailClassificationValues as ReadonlyArray<string>).includes(raw)
		? (raw as EmailClassification)
		: null
}

function asStringAddresses(value: Array<unknown>): Array<string> {
	return value.filter((entry): entry is string => typeof entry === 'string')
}

function messageToListItem(
	message: EmailMessageRecord,
): AccountEmailMessageListItem {
	return {
		id: message.id,
		direction: message.direction,
		inbox_id: message.inboxId,
		thread_id: message.threadId,
		from_address: message.fromAddress,
		envelope_from: message.envelopeFrom,
		to_addresses: asStringAddresses(message.toAddresses),
		subject: message.subject,
		message_id_header: message.messageIdHeader,
		processing_status: message.processingStatus,
		classification: message.classification,
		classification_reason: message.classificationReason,
		sender_classification: null,
		sender_classification_reason: null,
		provider_message_id: message.providerMessageId,
		delivery_status: message.deliveryStatus,
		delivery_status_at: message.deliveryStatusAt,
		error: message.error,
		received_at: message.receivedAt,
		sent_at: message.sentAt,
		created_at: message.createdAt,
		updated_at: message.updatedAt,
	}
}

async function loadUsage(input: {
	db: D1Database
	env: EntitlementUsageEnv
	userId: OwnerId
	email: string | null
}): Promise<AccountEmailUsage> {
	const now = new Date()
	const entitlement = await getUserEntitlement(input.db, {
		userId: input.userId,
		email: input.email,
	})
	const plan: PlanName = entitlement.plan
	const [storedMessages, sendsToday, receivesToday] = await Promise.all([
		readCurrentEntitlementResourceUsage({
			db: input.db,
			env: input.env,
			userId: input.userId,
			resource: 'stored_email_messages',
			now,
		}),
		readDailyEntitlementResourceUsage({
			env: input.env,
			userId: input.userId,
			resource: 'email_sends_per_day',
			now,
		}),
		readDailyEntitlementResourceUsage({
			env: input.env,
			userId: input.userId,
			resource: 'email_receives_per_day',
			now,
		}),
	])
	return {
		plan,
		day: utcDayKey(now),
		stored_messages: {
			count: storedMessages,
			limit: resolveEntitlementLimit(entitlement, 'stored_email_messages', now),
		},
		sends_today: {
			count: sendsToday,
			limit: resolveEntitlementLimit(entitlement, 'email_sends_per_day', now),
		},
		receives_today: {
			count: receivesToday,
			limit: resolveEntitlementLimit(
				entitlement,
				'email_receives_per_day',
				now,
			),
		},
		max_message_bytes: resolveEntitlementLimit(
			entitlement,
			'email_message_bytes',
			now,
		),
	}
}

async function loadInboxes(input: {
	db: D1Database
	userId: OwnerId
}): Promise<Array<AccountEmailInbox>> {
	const [inboxes, addresses] = await Promise.all([
		listEmailInboxesForUser(input),
		listEmailInboxAddressesForUser(input),
	])
	return inboxes.map((inbox) => ({
		id: inbox.id,
		name: inbox.name,
		description: inbox.description,
		enabled: inbox.enabled,
		addresses: addresses
			.filter((address) => address.inboxId === inbox.id)
			.map((address) => ({
				id: address.id,
				address: address.address,
				enabled: address.enabled,
				created_at: address.createdAt,
			})),
		created_at: inbox.createdAt,
		updated_at: inbox.updatedAt,
	}))
}

type ClassifiedSender = {
	sender_classification: AccountEmailSenderClassification | null
	sender_classification_reason: string | null
	enableSender: AccountEmailEnableSender['sender'] | null
}

async function classifyMessageSender(input: {
	db: D1Database
	orgId: OwnerId
	message: Pick<
		EmailMessageRecord,
		'direction' | 'fromAddress' | 'envelopeFrom' | 'authResults'
	>
}): Promise<ClassifiedSender> {
	if (input.message.direction !== 'inbound') {
		return {
			sender_classification: null,
			sender_classification_reason: null,
			enableSender: null,
		}
	}
	const classified = await classifyInboundEmailSender({
		db: input.db,
		orgId: input.orgId,
		message: input.message,
	})
	switch (classified.kind) {
		case 'member':
			return {
				sender_classification: 'member',
				sender_classification_reason: 'From is a verified org member.',
				enableSender: {
					kind: 'member',
					value: String(classified.actor.userId),
				},
			}
		case 'inbox-owner': {
			const address = input.message.fromAddress
				? normalizeEmailAddress(input.message.fromAddress)
				: null
			return {
				sender_classification: 'authenticated',
				sender_classification_reason:
					'From authenticated and is not an org member.',
				enableSender: address ? { kind: 'address', value: address } : null,
			}
		}
		case 'unverified':
			return {
				sender_classification: 'unverified',
				sender_classification_reason: classified.reason,
				enableSender: null,
			}
		default: {
			const exhaustive: never = classified
			throw new Error(
				`Unhandled inbound sender classification: ${String(exhaustive)}`,
			)
		}
	}
}

function packagesHrefForSender(input: {
	orgSlug: string
	sender: AccountEmailEnableSender['sender']
	topic: AccountEmailEnableSender['topic']
}) {
	const params = new URLSearchParams({
		enable_sender: '1',
		sender_kind: input.sender.kind,
		sender_value: input.sender.value,
		topic: input.topic,
	})
	return `${orgResourcePath(input.orgSlug, 'repositories')}?${params.toString()}`
}

async function listOrgPackageKodyIds(db: D1Database, orgId: OwnerId) {
	const rows = await db
		.prepare(
			`SELECT kody_id FROM saved_packages
			 WHERE user_id = ?${andLiveDeletedAtSql()}
			 ORDER BY kody_id
			 LIMIT 100`,
		)
		.bind(orgId)
		.all<{ kody_id: string }>()
	return (rows.results ?? [])
		.map((row) => row.kody_id)
		.filter((kodyId) => kodyId.length > 0)
		.map((kodyId) => ({ kody_id: kodyId }))
}

async function loadSelectedMessage(input: {
	env: Env
	stableUserId: OwnerId
	orgSlug: string | null
	messageId: string
}): Promise<AccountEmailMessageDetail | null> {
	const message = await getOwnerEmailMessageById({
		env: input.env,
		ownerId: input.stableUserId,
		messageId: input.messageId,
	})
	if (!message) return null
	const [attachments, deliveryEvents] = await Promise.all([
		listOwnerEmailAttachmentsForMessage({
			env: input.env,
			ownerId: input.stableUserId,
			messageId: message.id,
		}),
		listOwnerEmailDeliveryEvents({
			env: input.env,
			ownerId: input.stableUserId,
			messageId: message.id,
			limit: deliveryEventsLimit,
		}),
	])
	const detail = toMessageDetail(message, attachments)
	const sender = await classifyMessageSender({
		db: input.env.APP_DB,
		orgId: input.stableUserId,
		message,
	})
	const topic: AccountEmailEnableSender['topic'] =
		message.classification === 'quarantined'
			? 'email.message.quarantined'
			: 'email.message.received'
	const enable_sender =
		sender.enableSender && input.orgSlug
			? {
					sender: sender.enableSender,
					topic,
					org_slug: input.orgSlug,
					packages_href: packagesHrefForSender({
						orgSlug: input.orgSlug,
						sender: sender.enableSender,
						topic,
					}),
					packages: await listOrgPackageKodyIds(
						input.env.APP_DB,
						input.stableUserId,
					),
				}
			: null
	return {
		...detail,
		classification: message.classification,
		classification_reason: message.classificationReason,
		sender_classification: sender.sender_classification,
		sender_classification_reason: sender.sender_classification_reason,
		enable_sender,
		delivery_events: deliveryEvents.map((event) => ({
			id: event.id,
			event_type: event.eventType,
			provider: event.provider,
			provider_message_id: event.providerMessageId,
			provider_event_id: event.providerEventId,
			detail_json: event.detailJson,
			created_at: event.createdAt,
		})),
	}
}

function orgSlugFor(user: AuthenticatedUser) {
	return user.request.org.slug?.trim() || null
}

function resolveInboxAddress(input: {
	env: Env
	orgSlug: string | null
}): string | null {
	const domain = getPlatformEmailDomain(input.env)
	if (!domain || !input.orgSlug) return null
	return buildPlatformEmailAddress({
		username: input.orgSlug,
		domain,
	})
}

function emptyVerifiedShell(input: {
	user: AuthenticatedUser
	env: Env
	page: number
	pageSize: number
	query: string
	classification: EmailClassification | null
	emailVerified: boolean
}): AccountEmailLoaderData {
	return {
		ok: true,
		emailVerified: input.emailVerified,
		email: input.user.email,
		username: input.user.username,
		inboxAddress: resolveInboxAddress({
			env: input.env,
			orgSlug: orgSlugFor(input.user),
		}),
		verificationMessage: input.emailVerified
			? null
			: emailVerificationRequiredMessage,
		outboundDeliveryPausedAt: null,
		inboxes: [],
		messages: [],
		selectedMessage: null,
		usage: null,
		page: input.page,
		pageSize: input.pageSize,
		total: 0,
		query: input.query,
		classification: input.classification,
	}
}

/** Read one message without reloading the inbox list, usage, or destinations.
 * The caller supplies an authenticated, organization-bound user. */
export async function loadAccountEmailDetail(input: {
	env: Env
	user: AuthenticatedUser
	messageId: string
}): Promise<AccountEmailMessageDetail | null> {
	await authorize({ env: input.env, request: input.user.request }, 'email:read')
	const verified =
		input.user.emailVerified ||
		(await isAccountEmailVerified({
			db: input.env.APP_DB,
			email: input.user.email,
			stableUserId: input.user.mcpUser.userId,
		}))
	if (!verified) return null
	return loadSelectedMessage({
		env: input.env,
		stableUserId: ownerIdFromCaller({
			request: input.user.request,
			user: input.user.mcpUser,
		}),
		orgSlug: orgSlugFor(input.user),
		messageId: input.messageId,
	})
}

export async function loadAccountEmailData(input: {
	env: Env
	request: Request
	user: AuthenticatedUser
	pathMessageId?: string
}): Promise<AccountEmailLoaderData> {
	const url = new URL(input.request.url, 'http://localhost')
	const { page, pageSize } = readPagination(url, {
		defaultPageSize,
		maxPageSize,
	})
	return readAccountEmailData({
		env: input.env,
		user: input.user,
		page,
		pageSize,
		query: url.searchParams.get('q')?.trim() ?? '',
		classification: readAccountEmailClassificationFilter(input.request.url),
		selectedMessageId: readAccountEmailSelectedMessageId(
			input.request.url,
			input.pathMessageId,
		),
	})
}

/** Mailbox reads use explicit filters and an already authorized owner context. */
export async function readAccountEmailData(input: {
	env: Env
	user: AuthenticatedUser
	page: number
	pageSize: number
	query: string
	classification: AccountEmailLoaderData['classification']
	selectedMessageId?: string | null
}): Promise<AccountEmailLoaderData> {
	await authorize({ env: input.env, request: input.user.request }, 'email:read')
	const page = Math.max(1, Math.floor(input.page))
	const pageSize = Math.min(
		maxPageSize,
		Math.max(1, Math.floor(input.pageSize)),
	)
	const offset = (page - 1) * pageSize
	const query = input.query.trim()
	const classification = input.classification
	const userId = ownerIdFromCaller({
		request: input.user.request,
		user: input.user.mcpUser,
	})
	const emailVerified =
		input.user.emailVerified ||
		(await isAccountEmailVerified({
			db: input.env.APP_DB,
			email: input.user.email,
			stableUserId: input.user.mcpUser.userId,
		}))

	// Personal inboxes stay behind account email verification. A team mailbox
	// is the org's: a viewer with email:read sees it even when their own
	// address is unverified.
	if (!emailVerified && (await isPersonalOrg(input.env.APP_DB, userId))) {
		return emptyVerifiedShell({
			user: input.user,
			env: input.env,
			page,
			pageSize,
			query,
			classification,
			emailVerified: false,
		})
	}

	const selectedMessageId = input.selectedMessageId?.trim() || null
	const orgSlug = orgSlugFor(input.user)
	const [listResult, inboxes, usage, selectedMessage, deliveryPause] =
		await Promise.all([
			listOwnerEmailMessagesPage({
				env: input.env,
				ownerId: userId,
				query,
				classification,
				pageSize,
				offset,
			}),
			loadInboxes({ db: input.env.APP_DB, userId }),
			loadUsage({
				db: input.env.APP_DB,
				env: input.env,
				userId,
				email: entitlementEmailForOwner({ user: input.user.mcpUser }, userId),
			}),
			selectedMessageId
				? loadSelectedMessage({
						env: input.env,
						stableUserId: userId,
						orgSlug,
						messageId: selectedMessageId,
					})
				: Promise.resolve(null),
			loadOutboundDeliveryPause({
				db: input.env.APP_DB,
				ownerId: userId,
			}),
		])
	const messages = await Promise.all(
		listResult.messages.map(async (message) => {
			const sender = await classifyMessageSender({
				db: input.env.APP_DB,
				orgId: userId,
				message,
			})
			return {
				...messageToListItem(message),
				sender_classification: sender.sender_classification,
				sender_classification_reason: sender.sender_classification_reason,
			}
		}),
	)

	return {
		ok: true,
		emailVerified: true,
		email: input.user.email,
		username: input.user.username,
		inboxAddress: resolveInboxAddress({
			env: input.env,
			orgSlug,
		}),
		verificationMessage: null,
		outboundDeliveryPausedAt: deliveryPause?.pausedAt ?? null,
		inboxes,
		messages,
		selectedMessage,
		usage,
		page,
		pageSize,
		total: listResult.total,
		query,
		classification,
	}
}
