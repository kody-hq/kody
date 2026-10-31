/**
 * Org id and person id stamped onto new MCP OAuth grants (props + metadata).
 * Public surfaces show slugs; these ids are the internal grant binding
 * (ADR 0064). `personId` names the person the grant acts as without relying
 * on `userId` doubling as the personal org id.
 */
export function grantBindingFields(input: {
	orgId: string
	personId: string
}): {
	props: { orgId: string; personId: string }
	metadata: { orgId: string; personId: string }
} {
	const binding = { orgId: input.orgId, personId: input.personId }
	return {
		props: { ...binding },
		metadata: { ...binding },
	}
}

function readOrgIdField(value: unknown, key: 'orgId'): string | null {
	if (!value || typeof value !== 'object') return null
	const orgId = (value as { orgId?: unknown })[key]
	if (typeof orgId !== 'string') return null
	const trimmed = orgId.trim()
	return trimmed.length > 0 ? trimmed : null
}

export function readOrgIdFromGrantProps(props: unknown): string | null {
	return readOrgIdField(props, 'orgId')
}

export function readOrgIdFromGrantMetadata(metadata: unknown): string | null {
	return readOrgIdField(metadata, 'orgId')
}

/**
 * True when a stored OAuth grant value has a non-empty plaintext
 * `metadata.orgId`. Props stay encrypted and are never consulted here — same
 * predicate as the Teams production OAuth inventory.
 */
export function grantHasMetadataOrgId(value: unknown): boolean {
	if (typeof value !== 'object' || value === null) return false
	return (
		readOrgIdFromGrantMetadata((value as { metadata?: unknown }).metadata) !==
		null
	)
}

/**
 * Org bound on a listed grant for silent-consent reuse.
 * Prefer `metadata.orgId`; pre-P4 grants fall back to the grant subject's
 * user id (personal org) until P9 (#3057).
 */
export function readOrgIdFromGrantMetadataOrUserId(input: {
	metadata: unknown
	userId: string
}): string | null {
	const stamped = readOrgIdFromGrantMetadata(input.metadata)
	if (stamped) return stamped
	const userId = input.userId.trim()
	return userId.length > 0 ? userId : null
}

export function grantMatchesConsentOrg(input: {
	metadata: unknown
	userId: string
	orgId: string
}): boolean {
	const bound = readOrgIdFromGrantMetadataOrUserId({
		metadata: input.metadata,
		userId: input.userId,
	})
	return bound === input.orgId
}

export type TokenExchangeOrgStampInput = {
	props?: unknown
	grantType?: string
}

/**
 * Backfill `orgId` on token exchange. Spec: `orgId = props.orgId ?? props.userId`.
 * No-op when already stamped or when neither field is a string.
 */
export function readOrgIdFromGrantPropsOrUserId(props: unknown): string | null {
	const stamped = readOrgIdFromGrantProps(props)
	if (stamped) return stamped
	if (!props || typeof props !== 'object') return null
	const userId = (props as { userId?: unknown }).userId
	if (typeof userId !== 'string') return null
	const trimmed = userId.trim()
	return trimmed.length > 0 ? trimmed : null
}

export function stampOrgIdOnTokenExchange(
	input: TokenExchangeOrgStampInput,
): { newProps: Record<string, unknown> } | undefined {
	const props = input.props
	if (!props || typeof props !== 'object') return
	const record = props as Record<string, unknown>
	const stamped =
		typeof record.orgId === 'string' && record.orgId.trim().length > 0
			? record.orgId.trim()
			: null
	const fallback =
		typeof record.userId === 'string' && record.userId.trim().length > 0
			? record.userId.trim()
			: null
	const orgId = stamped ?? fallback
	if (!orgId) return
	if (stamped === orgId) return
	return { newProps: { ...record, orgId } }
}

/**
 * Grants stamped with a retired connection profile were narrowed to that
 * profile's resources. Connection profiles no longer exist, so such a grant
 * is refused rather than widened to the whole person.
 */
export function grantHasRetiredConnectionProfile(props: unknown): boolean {
	if (!props || typeof props !== 'object') return false
	const value = (props as { connectionProfileName?: unknown })
		.connectionProfileName
	return typeof value === 'string' && value.trim().length > 0
}
