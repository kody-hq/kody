/**
 * Links an owner opens to widen a credential's fill placement. Agents only
 * build and share them: `/connect/secrets?placement=` asks the owner to allow
 * the query, URL path, or body for a user credential (optionally with hosts),
 * and the credential page anchor opens its fill placement setting.
 */
import {
	fillPlacementAnchor,
	normalizePlacementApprovalParts,
	placementApprovalCredentialParam,
	placementApprovalParam,
	type PlacementApprovalPart,
} from '#universal/credential-placement-approval.ts'
import { routes } from '#universal/routes.ts'
import { classifyBulkApprovalHosts } from '#mcp/secrets/host-approval.ts'
import { normalizeBulkPackageSecretApprovalNames } from '#mcp/secrets/package-approval-url.ts'

const connectSecretsPath = '/connect/secrets'

/**
 * `/connect/secrets?name=…&placement=body[&hosts=…][&org=…][&credential=…]`. Hosts already
 * allowed are shown as allowed; any others are approved in the same click.
 */
export function buildCredentialPlacementApprovalUrl(input: {
	baseUrl: string
	names: ReadonlyArray<string>
	parts: ReadonlyArray<PlacementApprovalPart | string>
	hosts?: ReadonlyArray<string>
	orgSlug?: string | null
	/** Pins a single-name request to this credential. */
	credentialId?: string | null
}) {
	const names = normalizeBulkPackageSecretApprovalNames([...input.names])
	const parts = normalizePlacementApprovalParts(input.parts)
	if (names.length === 0) {
		throw new Error('At least one credential name is required.')
	}
	if (parts.length === 0) {
		throw new Error(
			'At least one placement part (query, path, or body) is required.',
		)
	}
	const url = new URL(connectSecretsPath, input.baseUrl)
	if (names.length === 1) url.searchParams.set('name', names[0] ?? '')
	else url.searchParams.set('names', names.join(','))
	// Keep invalid hosts so the owner's page lists them instead of hiding them.
	const classified = classifyBulkApprovalHosts([...(input.hosts ?? [])])
	const hosts = [
		...classified.valid,
		...classified.rejected.map(({ host }) => host),
	]
	if (hosts.length > 0) url.searchParams.set('hosts', hosts.join(','))
	url.searchParams.set(placementApprovalParam, parts.join(','))
	const orgSlug = input.orgSlug?.trim()
	if (orgSlug) url.searchParams.set('org', orgSlug)
	const credentialId = input.credentialId?.trim()
	if (credentialId) {
		if (names.length !== 1) {
			throw new Error('A pinned credential needs exactly one name.')
		}
		url.searchParams.set(placementApprovalCredentialParam, credentialId)
	}
	return url.toString()
}

/** The credential page, scrolled to (and opening) its fill placement setting. */
export function buildCredentialPlacementSettingUrl(input: {
	baseUrl: string
	orgSlug: string
	credentialId: string
}) {
	const url = new URL(
		routes.orgCredentials.href({
			orgSlug: input.orgSlug,
			rest: input.credentialId,
		}),
		input.baseUrl,
	)
	url.hash = fillPlacementAnchor
	return url.toString()
}
