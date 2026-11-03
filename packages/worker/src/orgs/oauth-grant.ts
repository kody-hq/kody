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

export function grantMatchesConsentOrg(input: {
	metadata: unknown
	userId: string
	orgId: string
}): boolean {
	const bound = readOrgIdFromGrantMetadata(input.metadata)
	return bound === input.orgId
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
