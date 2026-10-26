/**
 * Shareable invite links. Token plaintext is shown once at create; only the
 * SHA-256 hash is stored. Links never grant Owner.
 *
 * A link carries one target:
 * - `membership`: join the org with a role (team orgs only).
 * - `team`: join the org as a Member (an existing role is kept) and the team.
 * - `resource`: a preset on one package. Non-members stay outside
 *   collaborators, so these links also work in personal orgs.
 *
 * Opening a link never applies it. The recipient accepts on `/join/:token`
 * (or from their Organizations page once they have opened it); see
 * `invite-link-redeem.ts` and `invite-link-pending.ts`.
 */
import { toHex } from '@kody-internal/shared/hex.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { normalizeEmailAddress } from '#worker/email/address.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { isOrgActive } from '#worker/orgs/repo.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { recordOrgAuditEvent, type OrgAuditWriter } from './org-audit.ts'

export type InviteLinkRole = 'member' | 'billing'

const inviteLinkRoles = ['member', 'billing'] as const

export function isInviteLinkRole(value: unknown): value is InviteLinkRole {
	return (
		typeof value === 'string' &&
		(inviteLinkRoles as ReadonlyArray<string>).includes(value)
	)
}

export const inviteLinkResourcePresets = [
	'use',
	'contribute',
	'manage',
] as const

export type InviteLinkResourcePreset =
	(typeof inviteLinkResourcePresets)[number]

export function isInviteLinkResourcePreset(
	value: unknown,
): value is InviteLinkResourcePreset {
	return (
		typeof value === 'string' &&
		(inviteLinkResourcePresets as ReadonlyArray<string>).includes(value)
	)
}

export type InviteLinkTarget =
	| { kind: 'membership'; role: InviteLinkRole }
	| { kind: 'team'; teamId: string }
	| {
			kind: 'resource'
			resourceType: 'package'
			resourceId: string
			preset: InviteLinkResourcePreset
	  }

export type InviteLinkKind = InviteLinkTarget['kind']

export type StoredInviteLink = {
	id: string
	orgId: string
	tokenHash: string
	target: InviteLinkTarget
	/** Membership links only; empty for team and resource links. */
	teamIds: Array<string>
	label: string | null
	allowedEmailDomains: Array<string>
	maxUses: number | null
	useCount: number
	lastUsedAt: string | null
	status: 'active' | 'revoked'
	createdByUserId: string
	expiresAt: string
	createdAt: string
	revokedAt: string | null
}

export type ListedInviteLink = {
	id: string
	target: InviteLinkTarget
	teamIds: Array<string>
	label: string | null
	allowedEmailDomains: Array<string>
	maxUses: number | null
	useCount: number
	lastUsedAt: string | null
	expiresAt: string
	createdAt: string
	createdByUserId: string
	createdByUsername: string | null
	createdByDisplayName: string | null
}

export type InviteLinkRedeemBlockReason =
	| 'invalid'
	| 'revoked'
	| 'expired'
	| 'exhausted'
	| 'org_inactive'
	| 'personal_org'
	| 'domain'
	| 'unverified_email'
	| 'inviter_gone'
	| 'target_gone'
	| 'already_used'

export type InviteLinkRow = {
	id: string
	org_id: string
	token_hash: string
	kind: string | null
	role: string | null
	team_id: string | null
	resource_type: string | null
	resource_id: string | null
	preset: string | null
	team_ids_json: string | null
	label: string | null
	allowed_email_domains_json: string | null
	max_uses: number | null
	use_count: number
	last_used_at: string | null
	status: string
	created_by_user_id: string
	expires_at: string
	created_at: string
	revoked_at: string | null
}

const linkColumnNames = [
	'id',
	'org_id',
	'token_hash',
	'kind',
	'role',
	'team_id',
	'resource_type',
	'resource_id',
	'preset',
	'team_ids_json',
	'label',
	'allowed_email_domains_json',
	'max_uses',
	'use_count',
	'last_used_at',
	'status',
	'created_by_user_id',
	'expires_at',
	'created_at',
	'revoked_at',
] as const satisfies ReadonlyArray<keyof InviteLinkRow>

export function linkColumns(alias?: string) {
	return linkColumnNames
		.map((column) => (alias ? `${alias}.${column}` : column))
		.join(', ')
}

const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000

export function generateInviteLinkToken() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

export async function hashInviteLinkToken(token: string) {
	return await sha256Hex(token.trim())
}

function parseAllowedDomains(value: string | null): Array<string> {
	if (!value) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(value) as unknown
	} catch {
		throw new Error('Invite link domain rules are invalid.')
	}
	if (!Array.isArray(parsed)) {
		throw new Error('Invite link domain rules are invalid.')
	}
	const domains: Array<string> = []
	for (const entry of parsed) {
		if (typeof entry !== 'string') {
			throw new Error('Invite link domain rules are invalid.')
		}
		const trimmed = entry.trim().toLowerCase()
		if (trimmed.length > 0) domains.push(trimmed)
	}
	return domains
}

function readAllowedDomainsOrBlock(
	value: string | null,
): { ok: true; domains: Array<string> } | { ok: false } {
	try {
		return { ok: true, domains: parseAllowedDomains(value) }
	} catch {
		return { ok: false }
	}
}

function normalizeDomainList(
	domains: ReadonlyArray<string> | null | undefined,
): Array<string> {
	if (!domains || domains.length === 0) return []
	const unique = new Set<string>()
	for (const raw of domains) {
		const trimmed = raw.trim().toLowerCase().replace(/^@/, '')
		if (!trimmed) continue
		if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(trimmed)) {
			throw new Error(`Invalid email domain: ${raw}`)
		}
		unique.add(trimmed)
	}
	return [...unique].sort()
}

function normalizeInviteLinkLabel(
	value: string | null | undefined,
): string | null {
	if (value == null) return null
	const trimmed = value.trim()
	if (!trimmed) return null
	if (trimmed.length > 80) {
		throw new Error('Label must be 80 characters or fewer.')
	}
	return trimmed
}

function parseTeamIdsJson(value: string | null): Array<string> {
	if (!value) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(value) as unknown
	} catch {
		throw new Error('Invite link team list is invalid.')
	}
	if (!Array.isArray(parsed)) {
		throw new Error('Invite link team list is invalid.')
	}
	const ids: Array<string> = []
	for (const entry of parsed) {
		if (typeof entry !== 'string' || !entry.trim()) {
			throw new Error('Invite link team list is invalid.')
		}
		ids.push(entry.trim())
	}
	return ids
}

function readTeamIdsOrBlock(
	value: string | null,
): { ok: true; teamIds: Array<string> } | { ok: false } {
	try {
		return { ok: true, teamIds: parseTeamIdsJson(value) }
	} catch {
		return { ok: false }
	}
}

function normalizeTeamIds(
	teamIds: ReadonlyArray<string> | null | undefined,
): Array<string> {
	if (!teamIds || teamIds.length === 0) return []
	const unique = new Set<string>()
	for (const raw of teamIds) {
		const trimmed = raw.trim()
		if (!trimmed) continue
		unique.add(trimmed)
	}
	return [...unique]
}

export async function assertInviteLinkTeamsInOrg(
	db: D1Database,
	orgId: string,
	teamIds: ReadonlyArray<string>,
) {
	for (const teamId of teamIds) {
		const row = await db
			.prepare(
				`SELECT id FROM teams
				 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
			)
			.bind(teamId, orgId)
			.first<{ id: string }>()
		if (!row) {
			throw new Error('That team was not found in this organization.')
		}
	}
}

/** `null` when the row does not describe a target this code understands. */
export function rowTarget(
	row: Pick<
		InviteLinkRow,
		'kind' | 'role' | 'team_id' | 'resource_type' | 'resource_id' | 'preset'
	>,
): InviteLinkTarget | null {
	const kind = row.kind ?? 'membership'
	switch (kind) {
		case 'membership':
			return isInviteLinkRole(row.role)
				? { kind: 'membership', role: row.role }
				: null
		case 'team':
			return row.team_id ? { kind: 'team', teamId: row.team_id } : null
		case 'resource':
			return row.resource_type === 'package' &&
				row.resource_id &&
				isInviteLinkResourcePreset(row.preset)
				? {
						kind: 'resource',
						resourceType: 'package',
						resourceId: row.resource_id,
						preset: row.preset,
					}
				: null
		default:
			return null
	}
}

export function rowToStored(row: InviteLinkRow): StoredInviteLink {
	const target = rowTarget(row)
	if (!target) {
		throw new Error(`Invite link ${row.id} has an unknown target.`)
	}
	if (row.status !== 'active' && row.status !== 'revoked') {
		throw new Error(`Invite link ${row.id} has status ${row.status}.`)
	}
	const domains = readAllowedDomainsOrBlock(row.allowed_email_domains_json)
	const teams = readTeamIdsOrBlock(row.team_ids_json)
	const teamIds = target.kind === 'membership' && teams.ok ? teams.teamIds : []
	return {
		id: row.id,
		orgId: row.org_id,
		tokenHash: row.token_hash,
		target,
		teamIds,
		label: row.label?.trim() ? row.label.trim() : null,
		allowedEmailDomains: domains.ok ? domains.domains : [],
		maxUses: row.max_uses,
		useCount: row.use_count,
		lastUsedAt: row.last_used_at,
		status: row.status,
		createdByUserId: row.created_by_user_id,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		revokedAt: row.revoked_at,
	}
}

export function rowDomainsBlocked(row: InviteLinkRow) {
	return (
		!readAllowedDomainsOrBlock(row.allowed_email_domains_json).ok ||
		!readTeamIdsOrBlock(row.team_ids_json).ok
	)
}

/** The org role a recipient who is not yet a member gets, if any. */
export function inviteLinkJoinRole(
	target: InviteLinkTarget,
): InviteLinkRole | null {
	switch (target.kind) {
		case 'membership':
			return target.role
		case 'team':
			return 'member'
		case 'resource':
			return null
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

export type InviteLinkAvailabilityReason = Extract<
	InviteLinkRedeemBlockReason,
	'revoked' | 'expired' | 'exhausted'
>

export function inviteLinkIsRedeemable(
	link: StoredInviteLink,
	nowIso = new Date().toISOString(),
): InviteLinkAvailabilityReason | null {
	if (link.status === 'revoked') return 'revoked'
	if (link.expiresAt <= nowIso) return 'expired'
	if (link.maxUses != null && link.useCount >= link.maxUses) return 'exhausted'
	return null
}

export function emailMatchesInviteLinkDomains(
	email: string,
	domains: ReadonlyArray<string>,
): boolean {
	if (domains.length === 0) return true
	const normalized = normalizeEmailAddress(email)
	if (!normalized) return false
	const at = normalized.lastIndexOf('@')
	if (at < 0) return false
	const domain = normalized.slice(at + 1)
	return domains.includes(domain)
}

async function teamIsLive(db: D1Database, orgId: string, teamId: string) {
	const row = await db
		.prepare(
			`SELECT id FROM teams
			 WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
		)
		.bind(teamId, orgId)
		.first<{ id: string }>()
	return Boolean(row)
}

async function packageIsLive(db: D1Database, orgId: string, packageId: string) {
	const row = await db
		.prepare(
			`SELECT id FROM saved_packages
			 WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(packageId, orgId)
		.first<{ id: string }>()
	return Boolean(row)
}

export async function targetIsLive(
	db: D1Database,
	orgId: string,
	target: InviteLinkTarget,
) {
	switch (target.kind) {
		case 'membership':
			return true
		case 'team':
			return await teamIsLive(db, orgId, target.teamId)
		case 'resource':
			return await packageIsLive(db, orgId, target.resourceId)
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

/** Membership and team links add people to the org; a personal org has none. */
export function targetNeedsTeamOrg(target: InviteLinkTarget) {
	return target.kind !== 'resource'
}

function targetColumns(target: InviteLinkTarget) {
	switch (target.kind) {
		case 'membership':
			return {
				kind: 'membership',
				role: target.role,
				teamId: null,
				resourceType: null,
				resourceId: null,
				preset: null,
			}
		case 'team':
			return {
				kind: 'team',
				role: 'member',
				teamId: target.teamId,
				resourceType: null,
				resourceId: null,
				preset: null,
			}
		case 'resource':
			return {
				kind: 'resource',
				role: null,
				teamId: null,
				resourceType: target.resourceType,
				resourceId: target.resourceId,
				preset: target.preset,
			}
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

function targetAuditDetails(target: InviteLinkTarget) {
	switch (target.kind) {
		case 'membership':
			return { role: target.role }
		case 'team':
			return { kind: 'team', role: 'member', teamId: target.teamId }
		case 'resource':
			return {
				kind: 'resource',
				resourceType: target.resourceType,
				resourceId: target.resourceId,
				preset: target.preset,
			}
		default: {
			const exhaustive: never = target
			throw new Error(`Unknown invite link target: ${String(exhaustive)}`)
		}
	}
}

export async function createOrgInviteLink(input: {
	db: D1Database
	orgId: string
	target: InviteLinkTarget
	createdByUserId: string
	tokenHash: string
	allowedEmailDomains?: ReadonlyArray<string> | null
	teamIds?: ReadonlyArray<string> | null
	label?: string | null
	maxUses?: number | null
	expiresAt?: string
	audit: OrgAuditWriter
}) {
	if (
		targetNeedsTeamOrg(input.target) &&
		(await isPersonalOrg(input.db, input.orgId))
	) {
		throw new Error(
			'Membership for your personal organization is managed with your account. Create a team organization to invite people.',
		)
	}
	if (!(await isOrgActive(input.db, input.orgId))) {
		throw new Error('This organization is not active.')
	}
	if (!(await targetIsLive(input.db, input.orgId, input.target))) {
		throw new Error(
			input.target.kind === 'team'
				? 'That team was not found in this organization.'
				: 'That package was not found in this organization.',
		)
	}
	const domains = normalizeDomainList(input.allowedEmailDomains)
	const label = normalizeInviteLinkLabel(input.label)
	const teamIds =
		input.target.kind === 'membership' ? normalizeTeamIds(input.teamIds) : []
	if (teamIds.length > 0) {
		await assertInviteLinkTeamsInOrg(input.db, input.orgId, teamIds)
	}
	const maxUses =
		input.maxUses == null || input.maxUses === undefined
			? null
			: Math.floor(input.maxUses)
	if (maxUses != null && maxUses < 1) {
		throw new Error('Max uses must be at least 1 when set.')
	}
	const id = crypto.randomUUID()
	const now = new Date().toISOString()
	const expiresAt =
		input.expiresAt ?? new Date(Date.now() + DEFAULT_EXPIRY_MS).toISOString()
	if (expiresAt <= now) {
		throw new Error('Expiry must be in the future.')
	}
	const columns = targetColumns(input.target)
	await input.db
		.prepare(
			`INSERT INTO org_invite_links (
				id, org_id, token_hash, kind, role, team_id, resource_type,
				resource_id, preset, team_ids_json, label,
				allowed_email_domains_json, max_uses, use_count, last_used_at,
				status, created_by_user_id, expires_at, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 'active', ?, ?, ?)`,
		)
		.bind(
			id,
			input.orgId,
			input.tokenHash,
			columns.kind,
			columns.role,
			columns.teamId,
			columns.resourceType,
			columns.resourceId,
			columns.preset,
			teamIds.length > 0 ? JSON.stringify(teamIds) : null,
			label,
			domains.length > 0 ? JSON.stringify(domains) : null,
			maxUses,
			input.createdByUserId,
			expiresAt,
			now,
		)
		.run()
	await recordOrgAuditEvent(input.audit, {
		orgId: input.orgId,
		action: 'invite_link.created',
		resourceType: 'invite_link',
		resourceId: id,
		details: {
			...targetAuditDetails(input.target),
			label,
			teamIds,
			maxUses,
			expiresAt,
			allowedEmailDomains: domains,
		},
	})
	return {
		id,
		expiresAt,
		allowedEmailDomains: domains,
		maxUses,
		label,
		teamIds,
	}
}

export async function getInviteLinkByTokenHash(
	db: D1Database,
	tokenHash: string,
): Promise<StoredInviteLink | null> {
	const row = await db
		.prepare(
			`SELECT ${linkColumns()}
			 FROM org_invite_links
			 WHERE token_hash = ?`,
		)
		.bind(tokenHash)
		.first<InviteLinkRow>()
	if (!row) return null
	if (rowDomainsBlocked(row) || !rowTarget(row)) return null
	return rowToStored(row)
}

export async function getInviteLinkById(input: {
	db: D1Database
	orgId: string
	linkId: string
}): Promise<StoredInviteLink | null> {
	const row = await input.db
		.prepare(
			`SELECT ${linkColumns()}
			 FROM org_invite_links
			 WHERE id = ? AND org_id = ?`,
		)
		.bind(input.linkId, input.orgId)
		.first<InviteLinkRow>()
	return row && rowTarget(row) ? rowToStored(row) : null
}

/**
 * Which links a management page lists and may revoke. The Members page sees
 * membership links only, so links made for a team or a package never show up
 * (or get revoked) there.
 */
export type InviteLinkScope =
	| { kind: 'membership' }
	| { kind: 'team'; teamId?: string }
	| { kind: 'resource'; resourceType: 'package'; resourceId: string }

function scopeSql(scope: InviteLinkScope, alias: string) {
	const prefix = alias ? `${alias}.` : ''
	switch (scope.kind) {
		case 'membership':
			return {
				sql: ` AND COALESCE(${prefix}kind, 'membership') = 'membership'`,
				binds: [] as Array<string>,
			}
		case 'team':
			return scope.teamId
				? {
						sql: ` AND ${prefix}kind = 'team' AND ${prefix}team_id = ?`,
						binds: [scope.teamId],
					}
				: { sql: ` AND ${prefix}kind = 'team'`, binds: [] as Array<string> }
		case 'resource':
			return {
				sql: ` AND ${prefix}kind = 'resource' AND ${prefix}resource_type = ? AND ${prefix}resource_id = ?`,
				binds: [scope.resourceType, scope.resourceId],
			}
		default: {
			const exhaustive: never = scope
			throw new Error(`Unknown invite link scope: ${String(exhaustive)}`)
		}
	}
}

/**
 * Active links that are still within expiry and under max uses. Revoked,
 * expired, and exhausted links drop off the management page lists.
 */
export async function listActiveOrgInviteLinks(
	db: D1Database,
	orgId: string,
	nowIso = new Date().toISOString(),
	scope: InviteLinkScope = { kind: 'membership' },
): Promise<Array<ListedInviteLink>> {
	const filter = scopeSql(scope, 'l')
	const rows = await db
		.prepare(
			`SELECT l.id AS id,
			        l.kind AS kind,
			        l.role AS role,
			        l.team_id AS team_id,
			        l.resource_type AS resource_type,
			        l.resource_id AS resource_id,
			        l.preset AS preset,
			        l.team_ids_json AS team_ids_json,
			        l.label AS label,
			        l.allowed_email_domains_json AS allowed_email_domains_json,
			        l.max_uses AS max_uses,
			        l.use_count AS use_count,
			        l.last_used_at AS last_used_at,
			        l.expires_at AS expires_at,
			        l.created_at AS created_at,
			        l.created_by_user_id AS created_by_user_id,
			        u.username AS created_by_username,
			        u.display_name AS created_by_display_name
			 FROM org_invite_links l
			 LEFT JOIN users u
			   ON u.stable_user_id = l.created_by_user_id
			  AND u.deleted_at IS NULL
			 WHERE l.org_id = ?
			   AND l.status = 'active'
			   AND l.expires_at > ?
			   AND (l.max_uses IS NULL OR l.use_count < l.max_uses)${filter.sql}
			 ORDER BY l.created_at DESC`,
		)
		.bind(orgId, nowIso, ...filter.binds)
		.all<
			Pick<
				InviteLinkRow,
				| 'id'
				| 'kind'
				| 'role'
				| 'team_id'
				| 'resource_type'
				| 'resource_id'
				| 'preset'
				| 'team_ids_json'
				| 'label'
				| 'allowed_email_domains_json'
				| 'max_uses'
				| 'use_count'
				| 'last_used_at'
				| 'expires_at'
				| 'created_at'
				| 'created_by_user_id'
			> & {
				created_by_username: string | null
				created_by_display_name: string | null
			}
		>()
	return (rows.results ?? []).flatMap((row) => {
		const target = rowTarget(row)
		if (!target) return []
		const domains = readAllowedDomainsOrBlock(row.allowed_email_domains_json)
		if (!domains.ok) return []
		const teams = readTeamIdsOrBlock(row.team_ids_json)
		if (!teams.ok) return []
		return [
			{
				id: row.id,
				target,
				teamIds: target.kind === 'membership' ? teams.teamIds : [],
				label: row.label?.trim() ? row.label.trim() : null,
				allowedEmailDomains: domains.domains,
				maxUses: row.max_uses,
				useCount: row.use_count,
				lastUsedAt: row.last_used_at,
				expiresAt: row.expires_at,
				createdAt: row.created_at,
				createdByUserId: row.created_by_user_id,
				createdByUsername: row.created_by_username,
				createdByDisplayName: row.created_by_display_name,
			},
		]
	})
}

export async function revokeOrgInviteLink(input: {
	db: D1Database
	orgId: string
	linkId: string
	audit: OrgAuditWriter
	scope?: InviteLinkScope
}) {
	const now = new Date().toISOString()
	const filter = scopeSql(input.scope ?? { kind: 'membership' }, '')
	const result = await input.db
		.prepare(
			`UPDATE org_invite_links
			 SET status = 'revoked', revoked_at = ?
			 WHERE id = ? AND org_id = ? AND status = 'active'${filter.sql}`,
		)
		.bind(now, input.linkId, input.orgId, ...filter.binds)
		.run()
	if ((result.meta?.changes ?? 0) === 0) {
		throw new Error('That invite link could not be revoked.')
	}
	await input.db
		.prepare(`DELETE FROM org_invite_link_pending WHERE link_id = ?`)
		.bind(input.linkId)
		.run()
	await recordOrgAuditEvent(input.audit, {
		orgId: input.orgId,
		action: 'invite_link.revoked',
		resourceType: 'invite_link',
		resourceId: input.linkId,
	})
}

export function inviteLinkBlockMessage(
	reason: InviteLinkRedeemBlockReason,
): string {
	switch (reason) {
		case 'invalid':
			return 'This invite link is invalid.'
		case 'revoked':
			return 'This invite link has been revoked.'
		case 'expired':
			return 'This invite link has expired.'
		case 'exhausted':
			return 'This invite link has reached its use limit.'
		case 'org_inactive':
			return 'This organization is no longer active.'
		case 'personal_org':
			return 'Personal organizations do not accept invite links.'
		case 'domain':
			return 'Your verified email domain is not allowed for this invite link.'
		case 'unverified_email':
			return 'Verify your email address before joining with this invite link.'
		case 'inviter_gone':
			return 'This invite link is no longer valid because the creator no longer has access.'
		case 'target_gone':
			return 'This invite link is no longer valid because what it shared was removed.'
		case 'already_used':
			return 'You already used this invite link. Ask for a new one if you need access again.'
		default: {
			const exhaustive: never = reason
			return exhaustive
		}
	}
}
