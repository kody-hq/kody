import {
	type EmailVerificationDelivery,
	parseEmailVerificationDelivery,
} from '#universal/email-verification-delivery.ts'
import {
	permissionAccesses,
	permissionActions,
	permissionEntities,
	roleNames,
	type PermissionString,
	type RoleName,
} from '#universal/permissions.ts'
import {
	featureFlagKeys,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import { type OrganizationSummary } from '#universal/org-pages.ts'

export type SessionInfo = {
	email: string
	emailVerified: boolean
	emailVerificationDelivery: EmailVerificationDelivery | null
	username: string
	avatarUrl: string | null
	roles: Array<RoleName>
	permissions: Array<PermissionString>
	featureFlags: Record<FeatureFlagKey, boolean>
	organizations?: Array<OrganizationSummary>
	inviteCount?: number
}

export function getSessionDisplayName(session: SessionInfo | null) {
	return session?.username || session?.email || ''
}

export function parseSessionInfo(value: unknown): SessionInfo | null {
	const payload = value as {
		ok?: unknown
		session?: Partial<SessionInfo> | null
	} | null
	const email =
		payload?.ok && typeof payload?.session?.email === 'string'
			? payload.session.email.trim()
			: ''
	const username =
		payload?.ok && typeof payload?.session?.username === 'string'
			? payload.session.username.trim()
			: ''
	const avatarUrl =
		payload?.ok && typeof payload?.session?.avatarUrl === 'string'
			? payload.session.avatarUrl.trim() || null
			: null
	const roles = readRoleNames(payload?.session?.roles)
	const permissions = readPermissionStrings(payload?.session?.permissions)
	const featureFlags = readFeatureFlags(payload?.session?.featureFlags)
	const emailVerified = payload?.session?.emailVerified === true
	const emailVerificationDelivery = parseEmailVerificationDelivery(
		payload?.session?.emailVerificationDelivery &&
			typeof payload.session.emailVerificationDelivery === 'object'
			? {
					status: payload.session.emailVerificationDelivery.status,
					class: payload.session.emailVerificationDelivery.class,
					at: payload.session.emailVerificationDelivery.at,
				}
			: {},
	)
	return email
		? {
				email,
				emailVerified,
				emailVerificationDelivery,
				username,
				avatarUrl,
				roles,
				permissions,
				featureFlags,
				organizations: readOrganizations(payload?.session?.organizations),
				inviteCount: readInviteCount(payload?.session?.inviteCount),
			}
		: null
}

function readInviteCount(value: unknown) {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.max(0, Math.floor(value))
		: 0
}

function readOrganizations(value: unknown): Array<OrganizationSummary> {
	if (!Array.isArray(value)) return []
	const organizations: Array<OrganizationSummary> = []
	for (const item of value) {
		if (!item || typeof item !== 'object') continue
		const row = item as Record<string, unknown>
		if (typeof row.slug !== 'string' || !row.slug.trim()) continue
		const role =
			row.role === 'owner' || row.role === 'member' || row.role === 'billing'
				? row.role
				: null
		organizations.push({
			slug: row.slug,
			displayName: typeof row.displayName === 'string' ? row.displayName : null,
			role,
			personal: row.personal === true,
			// Team-org photos live on the membership row. Dropping this field
			// leaves the chooser on the letter avatar after /session refreshes.
			avatarUrl:
				typeof row.avatarUrl === 'string' ? row.avatarUrl.trim() || null : null,
		})
	}
	return organizations
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}

function isPermissionString(value: string): value is PermissionString {
	const parts = value.split(':')
	if (parts.length !== 3) return false
	const action = parts[0]
	const entity = parts[1]
	const access = parts[2]
	if (!action || !entity || !access) return false
	return (
		(permissionActions as ReadonlyArray<string>).includes(action) &&
		(permissionEntities as ReadonlyArray<string>).includes(entity) &&
		(permissionAccesses as ReadonlyArray<string>).includes(access)
	)
}

function readRoleNames(value: unknown) {
	if (!Array.isArray(value)) return []
	return value.filter(
		(entry): entry is RoleName =>
			typeof entry === 'string' && isRoleName(entry),
	)
}

function readPermissionStrings(value: unknown) {
	if (!Array.isArray(value)) return []
	return value.filter(
		(entry): entry is PermissionString =>
			typeof entry === 'string' && isPermissionString(entry),
	)
}

function readFeatureFlags(value: unknown): Record<FeatureFlagKey, boolean> {
	const source =
		value && typeof value === 'object'
			? (value as Record<string, unknown>)
			: null
	const flags = {} as Record<FeatureFlagKey, boolean>
	for (const key of featureFlagKeys) {
		flags[key] = source?.[key] === true
	}
	return flags
}
