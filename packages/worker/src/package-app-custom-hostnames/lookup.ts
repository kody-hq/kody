import {
	getPackageNameLeaf,
	getPackageNameScope,
} from '#worker/package-registry/package-name.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import {
	andActiveOrgSql,
	andLiveDeletedAtSql,
} from '#worker/soft-delete/live-sql.ts'
import {
	type PackageAppCustomHostnameBindingKind,
	type PackageAppCustomHostnameLookup,
	type VerifiedAppCustomHostname,
	type VerifiedOrgCustomHostname,
} from '#worker/package-app-custom-hostnames/types.ts'

/**
 * Lowercase a customer hostname from a Host header or request URL.
 * Returns null when the value is not a dotted hostname we can store or look up.
 */
export function normalizeCustomHostname(host: string): string | null {
	let value = host.trim().toLowerCase()
	if (!value || value.startsWith('[')) return null
	const portSeparator = value.lastIndexOf(':')
	if (portSeparator > -1 && /^\d+$/.test(value.slice(portSeparator + 1))) {
		value = value.slice(0, portSeparator)
	}
	value = value.replace(/\.+$/, '')
	if (!value || value.length > 253) return null
	if (!value.includes('.') || value.includes('..')) return null
	if (!/^[a-z0-9.-]+$/.test(value)) return null
	const labels = value.split('.')
	if (
		labels.some(
			(label) => !label || label.startsWith('-') || label.endsWith('-'),
		)
	) {
		return null
	}
	return value
}

/** Serve only when Cloudflare reports both the hostname and its certificate active. */
export function isPackageAppCustomHostnameVerified(row: {
	hostnameStatus: string
	sslStatus: string
}): boolean {
	return row.hostnameStatus === 'active' && row.sslStatus === 'active'
}

export type PackageAppCustomHostnameCandidate = {
	hostname: string
	hostnameStatus: string
	sslStatus: string
}

/**
 * Primary custom hostname for Open app / public hosted URLs.
 *
 * Only fully verified rows (hostname and certificate both `active`). Pending
 * and needs-attention hostnames never win. When more than one verified
 * hostname exists, pick the lexicographically smallest hostname so the choice
 * is stable across syncs.
 */
export function pickPrimaryVerifiedAppCustomHostname(
	candidates: ReadonlyArray<PackageAppCustomHostnameCandidate>,
): string | null {
	const verified = candidates
		.filter((row) => isPackageAppCustomHostnameVerified(row))
		.map((row) => row.hostname.trim().toLowerCase())
		.filter(Boolean)
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
	return verified[0] ?? null
}

export function isVerifiedAppCustomHostname(
	row: PackageAppCustomHostnameLookup,
): row is VerifiedAppCustomHostname {
	return (
		row.bindingKind === 'app' &&
		row.verified &&
		row.packageId !== null &&
		row.username !== null &&
		row.kodyId !== null
	)
}

export function isVerifiedOrgCustomHostname(
	row: PackageAppCustomHostnameLookup,
): row is VerifiedOrgCustomHostname {
	return (
		row.bindingKind === 'org' &&
		row.verified &&
		row.orgId !== null &&
		row.username !== null
	)
}

type HostnameLookupSqlRow = {
	hostname: string
	binding_kind: string
	package_id: string | null
	org_id: string | null
	hostname_status: string
	ssl_status: string
	package_name: string | null
	owner_handle: string | null
	live_owner_org_id: string | null
	org_slug: string | null
}

function parseBindingKind(
	value: string,
): PackageAppCustomHostnameBindingKind | null {
	switch (value) {
		case 'app':
		case 'org':
			return value
		default:
			return null
	}
}

function lookupFromRow(
	row: HostnameLookupSqlRow,
): PackageAppCustomHostnameLookup | null {
	const bindingKind = parseBindingKind(row.binding_kind)
	if (!bindingKind) return null
	const verified = isPackageAppCustomHostnameVerified({
		hostnameStatus: row.hostname_status,
		sslStatus: row.ssl_status,
	})
	switch (bindingKind) {
		case 'app': {
			if (!row.package_id || !row.package_name || !row.live_owner_org_id) {
				return null
			}
			const username =
				row.owner_handle?.trim().toLowerCase() ||
				getPackageNameScope(row.package_name)?.toLowerCase() ||
				null
			if (!username) return null
			return {
				hostname: row.hostname,
				bindingKind,
				packageId: row.package_id,
				orgId: null,
				username,
				// Lowercase to match lookupVerifiedAppCustomHostnameForPackage
				// and handoff path binding.
				kodyId: getPackageNameLeaf(row.package_name).toLowerCase(),
				hostnameStatus: row.hostname_status,
				sslStatus: row.ssl_status,
				verified,
			}
		}
		case 'org': {
			if (!row.org_id) return null
			const username = row.org_slug?.trim().toLowerCase() || null
			if (!username) return null
			return {
				hostname: row.hostname,
				bindingKind,
				packageId: null,
				orgId: row.org_id,
				username,
				kodyId: null,
				hostnameStatus: row.hostname_status,
				sslStatus: row.ssl_status,
				verified,
			}
		}
		default: {
			bindingKind satisfies never
			return null
		}
	}
}

const hostnameLookupSql = `SELECT
	ch.hostname AS hostname,
	ch.binding_kind AS binding_kind,
	ch.package_id AS package_id,
	ch.org_id AS org_id,
	ch.hostname_status AS hostname_status,
	ch.ssl_status AS ssl_status,
	sp.name AS package_name,
	live_owner.slug AS owner_handle,
	live_owner.id AS live_owner_org_id,
	live_org.slug AS org_slug
FROM package_app_custom_hostnames ch
LEFT JOIN saved_packages sp
	ON ch.binding_kind = 'app'
	AND sp.id = ch.package_id${andLiveDeletedAtSql('sp')}
LEFT JOIN orgs live_owner
	ON live_owner.id = sp.user_id${andActiveOrgSql('live_owner')}
LEFT JOIN orgs live_org
	ON ch.binding_kind = 'org'
	AND live_org.id = ch.org_id${andActiveOrgSql('live_org')}
WHERE ch.hostname = ?
LIMIT 1`

/**
 * Resolve one stored hostname. App bindings join the live package and the
 * owner org slug (`orgs.id` = `saved_packages.user_id`). Returns null when
 * the hostname is unknown or an app binding has no live package owner.
 */
export async function lookupPackageAppCustomHostname(input: {
	db: D1Database
	hostname: string
}): Promise<PackageAppCustomHostnameLookup | null> {
	const hostname = normalizeCustomHostname(input.hostname)
	if (!hostname) return null
	const row = await input.db
		.prepare(hostnameLookupSql)
		.bind(hostname)
		.first<HostnameLookupSqlRow>()
	if (!row) return null
	return lookupFromRow(row)
}

const verifiedPackageLookupSql = `SELECT
	ch.hostname AS hostname,
	ch.binding_kind AS binding_kind,
	ch.package_id AS package_id,
	ch.org_id AS org_id,
	ch.hostname_status AS hostname_status,
	ch.ssl_status AS ssl_status,
	sp.name AS package_name,
	live_owner.slug AS owner_handle,
	live_owner.id AS live_owner_org_id,
	NULL AS org_slug
FROM package_app_custom_hostnames ch
INNER JOIN saved_packages sp
	ON sp.id = ch.package_id${andLiveDeletedAtSql('sp')}
INNER JOIN orgs live_owner
	ON live_owner.id = sp.user_id
	AND live_owner.slug = ?${andActiveOrgSql('live_owner')}
WHERE ch.binding_kind = 'app'
	AND ch.hostname_status = 'active'
	AND ch.ssl_status = 'active'
	AND lower(substr(sp.name, instr(sp.name, '/') + 1)) = ?
ORDER BY ch.hostname ASC
LIMIT 1`

/**
 * Verified app-level custom hostname for the package an app-origin URL names
 * (`/@username/packages/{kodyId}`). Org-level rows are ignored. When several
 * verified app hostnames exist, the lexicographically smallest hostname wins
 * ({@link pickPrimaryVerifiedAppCustomHostname}).
 */
export async function lookupVerifiedAppCustomHostnameForPackage(input: {
	db: D1Database
	username: string
	kodyId: string
}): Promise<VerifiedAppCustomHostname | null> {
	const username = normalizeUsername(input.username)
	const kodyId = input.kodyId.trim().toLowerCase()
	if (!username || getUsernameFormatValidationError(username) || !kodyId) {
		return null
	}
	const row = await input.db
		.prepare(verifiedPackageLookupSql)
		.bind(username, kodyId)
		.first<HostnameLookupSqlRow>()
	if (!row) return null
	const lookup = lookupFromRow(row)
	if (!lookup || !isVerifiedAppCustomHostname(lookup)) return null
	return lookup
}

const verifiedOrgLookupSql = `SELECT
	ch.hostname AS hostname,
	ch.binding_kind AS binding_kind,
	ch.package_id AS package_id,
	ch.org_id AS org_id,
	ch.hostname_status AS hostname_status,
	ch.ssl_status AS ssl_status,
	NULL AS package_name,
	NULL AS owner_handle,
	NULL AS live_owner_org_id,
	live_org.slug AS org_slug
FROM package_app_custom_hostnames ch
INNER JOIN orgs live_org
	ON live_org.id = ch.org_id
	AND live_org.slug = ?${andActiveOrgSql('live_org')}
INNER JOIN saved_packages sp
	ON sp.user_id = ch.org_id${andLiveDeletedAtSql('sp')}
	AND lower(substr(sp.name, instr(sp.name, '/') + 1)) = ?
WHERE ch.binding_kind = 'org'
	AND ch.hostname_status = 'active'
	AND ch.ssl_status = 'active'
ORDER BY ch.hostname ASC
LIMIT 1`

/**
 * Verified org-level custom hostname for a package owned by the org named in
 * the URL (`/@username/packages/{kodyId}` or `{username}.kody.run/...`).
 * App-level rows take precedence at serve time; this backs handoff when only
 * an org domain is configured.
 */
export async function lookupVerifiedOrgCustomHostnameForPackage(input: {
	db: D1Database
	username: string
	kodyId: string
}): Promise<VerifiedOrgCustomHostname | null> {
	const username = normalizeUsername(input.username)
	const kodyId = input.kodyId.trim().toLowerCase()
	if (!username || getUsernameFormatValidationError(username) || !kodyId) {
		return null
	}
	const row = await input.db
		.prepare(verifiedOrgLookupSql)
		.bind(username, kodyId)
		.first<HostnameLookupSqlRow>()
	if (!row) return null
	const lookup = lookupFromRow(row)
	if (!lookup || !isVerifiedOrgCustomHostname(lookup)) return null
	return lookup
}
