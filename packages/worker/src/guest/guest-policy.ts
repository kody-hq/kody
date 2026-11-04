import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	guestClaimCapabilityName,
	guestClaimFinishCapabilityName,
	guestClaimUrl,
	guestPhase,
	readGuestAccountByPerson,
} from '#worker/guest/guest-accounts.ts'
import {
	GuestRestrictionError,
	guestErrorPayload,
} from '#worker/guest/guest-errors.ts'

const storeCredentials = 'store credentials'
const connectIntegrations = 'connect credentials or integrations'
const joinOrgs = 'create or join organizations'
const invitePeople = 'invite people'
const publishPublic = 'publish public or internet-visible packages'

/** Capabilities a guest can never call, with the plain-words reason. */
export const guestBlockedCapabilities: Readonly<Record<string, string>> = {
	secretSet: storeCredentials,
	secretSetMany: storeCredentials,
	secretProviderBind: storeCredentials,
	serviceAccountKey: storeCredentials,
	credentialUpdate: storeCredentials,
	credentialOrgGrant: storeCredentials,
	credentialMappingPropose: storeCredentials,
	credentialTriggerPickSet: storeCredentials,
	integrationSave: connectIntegrations,
	integrationDeviceConnectStart: connectIntegrations,
	integrationDeviceConnectPoll: connectIntegrations,
	orgCreate: joinOrgs,
	inviteAccept: joinOrgs,
	inviteLinkAccept: joinOrgs,
	inviteCreate: invitePeople,
	inviteLinkCreate: invitePeople,
	teamMemberAdd: invitePeople,
	packageCollaboratorSet: invitePeople,
	executionContextShareSet: invitePeople,
	communityPublish: publishPublic,
	communityProfileUpdate: publishPublic,
	packagePublishExternalPush: publishPublic,
	packageAppCustomHostnameAdd: publishPublic,
}

function readRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null
}

/** The reason a guest may not make this call, or null when it is allowed. */
export function guestBlockedReason(
	capabilityName: string,
	args: unknown,
): string | null {
	const blocked = guestBlockedCapabilities[capabilityName]
	if (blocked) return blocked
	if (capabilityName === 'packageUpdate') {
		const changes = readRecord(readRecord(args)?.changes)
		if (
			changes?.visibility === 'public' ||
			changes?.internet_visible === true
		) {
			return publishPublic
		}
	}
	return null
}

export function isGuestCaller(callerContext: McpCallerContext) {
	return Boolean(callerContext.user?.guestExpiresAt)
}

export async function guestRestrictionError(input: {
	db: D1Database
	baseUrl: string
	personId: string
	blocked: string
	code: 'guest_not_allowed' | 'guest_claim_required'
}) {
	const guest = await readGuestAccountByPerson(input.db, input.personId)
	return new GuestRestrictionError(
		guestErrorPayload({
			code: input.code,
			blocked: input.blocked,
			claimUrl: guest ? guestClaimUrl(input.baseUrl, guest.claimCode) : null,
		}),
	)
}

/** Throws guest_not_allowed when a guest calls a blocked capability. */
export async function assertGuestCapabilityAllowed(input: {
	db: D1Database
	callerContext: McpCallerContext
	capabilityName: string
	readOnly?: boolean
	args: unknown
}) {
	const user = input.callerContext.user
	if (!user?.guestExpiresAt) return
	if (
		guestPhase(user.guestExpiresAt) === 'hold' &&
		!input.readOnly &&
		input.capabilityName !== guestClaimCapabilityName &&
		input.capabilityName !== guestClaimFinishCapabilityName
	) {
		throw await guestRestrictionError({
			db: input.db,
			baseUrl: input.callerContext.baseUrl,
			personId: user.userId,
			blocked: 'saving changes',
			code: 'guest_claim_required',
		})
	}
	const blocked = guestBlockedReason(input.capabilityName, input.args)
	if (!blocked) return
	throw await guestRestrictionError({
		db: input.db,
		baseUrl: input.callerContext.baseUrl,
		personId: user.userId,
		blocked,
		code: 'guest_not_allowed',
	})
}
