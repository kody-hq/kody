/**
 * Legacy visitor-authority fallback for package apps (ADR 0068 amendment
 * 2026-10-24).
 *
 * Apps run as their runs-as person now. When a visitor's call fails under
 * that authority where it would have worked under the old rule (the app
 * acting as its visitor), the call runs the old way and leaves a would-break
 * row: app, call name, kind of difference, and a hashed visitor id. Never a
 * handle, name, email, or value. The legacy path is deleted only after these
 * stay at zero.
 *
 * Hot path cost: `schedulePackageAppAuthorityFallback` never awaits D1.
 * Repeats inside one isolate coalesce into one upsert through `waitUntil`.
 */
import { waitUntil } from 'cloudflare:workers'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { CredentialClientError } from '#worker/credentials/credential-client.ts'
import { CredentialClientHandleError } from '#worker/credentials/credential-client-handle.ts'
import { CredentialNeedUndeclaredError } from '#worker/credentials/credential-need-enforcement.ts'
import {
	CredentialNotFoundError,
	CredentialRequestRefusedError,
} from '#worker/credentials/credential-request.ts'
import {
	PackageSecretAccessDeniedError,
	PackageSecretMissingError,
	PackageSecretMountError,
} from '#mcp/secrets/package-access.ts'
import { PackageAppRunsAsUnavailableError } from './package-app-authority.ts'

export const packageAppAuthorityDifferenceKinds = [
	/** Nobody to run as (not set, or that person left the org). */
	'runs_as_unavailable',
	/** A Kody capability the app does not list in `kody.app.capabilities`. */
	'capability_not_declared',
	/** The runs-as person's role does not allow it; the visitor's did. */
	'permission_denied',
	/** Not offered to the runs-as person (feature flag, plan, or server). */
	'capability_unavailable',
	/** A credential the runs-as person cannot resolve; the visitor could. */
	'credential_unavailable',
	/** `metaGetCurrentUser` would drop an email shared without consent. */
	'identity_email',
] as const

export type PackageAppAuthorityDifferenceKind =
	(typeof packageAppAuthorityDifferenceKinds)[number]

/**
 * Where a not-declared call came from. Package names and versions only:
 * never a visitor, handle, or credential value.
 */
export type PackageAppCapabilityCallSite = {
	/** The app whose `kody.app.capabilities` was checked (its package.json). */
	app?: { name: string; version?: string | null } | null
	/** The imported package whose code made the call, when not the app. */
	callingPackage?: string | null
}

const credentialNamedCallName = 'credential.named'

function describeApp(app: PackageAppCapabilityCallSite['app']) {
	const name = app?.name.trim()
	if (!name) return null
	const version = app?.version?.trim()
	return version ? `${name}@${version}` : name
}

function capabilityNotDeclaredMessage(
	capabilityName: string,
	site: PackageAppCapabilityCallSite,
) {
	const app = describeApp(site.app)
	const appName = site.app?.name.trim() || null
	const callingPackage = site.callingPackage?.trim() || null
	const parts = [
		`Package app capability "${capabilityName}" is not listed in kody.app.capabilities${app ? ` of the app "${app}"` : ''}.`,
	]
	if (callingPackage) {
		parts.push(
			`The call came from "${callingPackage}", a package the app imports.`,
		)
	}
	parts.push(
		'Apps run as their publisher and may call only the Kody capabilities they declare, including calls made by packages they import.',
	)
	const manifest = appName
		? `the package.json of "${appName}"`
		: "the app's package.json"
	parts.push(
		capabilityName === credentialNamedCallName
			? `Fix: declare the credential as a need in kody.credentials in ${manifest} and open it with credential(key), then republish the app.`
			: `Fix: add "${capabilityName}" to kody.app.capabilities in ${manifest}, then republish the app.`,
	)
	return parts.join(' ')
}

export class PackageAppCapabilityNotDeclaredError extends Error {
	readonly capabilityName: string

	constructor(capabilityName: string, site: PackageAppCapabilityCallSite = {}) {
		super(capabilityNotDeclaredMessage(capabilityName, site))
		this.name = 'PackageAppCapabilityNotDeclaredError'
		this.capabilityName = capabilityName
	}
}

export class PackageAppCapabilityUnavailableError extends Error {
	constructor(capabilityName: string) {
		super(`Package app capability "${capabilityName}" is not available.`)
		this.name = 'PackageAppCapabilityUnavailableError'
	}
}

const credentialFallbackCodes = new Set([
	'credential_unbound',
	'credential_ambiguous',
	'credential_not_found',
	'credential_denied',
	'credential_need_unknown',
	'credential_need_undeclared',
])

/**
 * The kind of difference when `error` came from running as the runs-as
 * person rather than from the call itself, so the legacy path may retry it.
 * Null for any other failure: those throw as they always did.
 */
export function packageAppAuthorityFallbackKindOf(
	error: unknown,
): PackageAppAuthorityDifferenceKind | null {
	if (error instanceof PackageAppRunsAsUnavailableError) {
		return 'runs_as_unavailable'
	}
	if (error instanceof PackageAppCapabilityNotDeclaredError) {
		return 'capability_not_declared'
	}
	if (error instanceof PackageAppCapabilityUnavailableError) {
		return 'capability_unavailable'
	}
	if (error instanceof AuthorizationError) return 'permission_denied'
	if (error instanceof CredentialClientError) {
		return credentialFallbackCodes.has(error.body.code)
			? 'credential_unavailable'
			: null
	}
	if (
		error instanceof CredentialClientHandleError ||
		error instanceof CredentialNeedUndeclaredError ||
		error instanceof CredentialNotFoundError ||
		error instanceof CredentialRequestRefusedError ||
		error instanceof PackageSecretMountError ||
		error instanceof PackageSecretMissingError ||
		error instanceof PackageSecretAccessDeniedError
	) {
		return 'credential_unavailable'
	}
	return null
}

/** A credential client result that refused for an authority reason. */
export function packageAppAuthorityFallbackKindOfResult(
	result: unknown,
): PackageAppAuthorityDifferenceKind | null {
	if (!result || typeof result !== 'object') return null
	const record = result as { ok?: unknown; error?: { code?: unknown } }
	if (record.ok !== false) return null
	const code = record.error?.code
	return typeof code === 'string' && credentialFallbackCodes.has(code)
		? 'credential_unavailable'
		: null
}

export type PackageAppAuthorityFallbackEvent = {
	ownerId: string
	packageId: string
	callName: string
	kind: PackageAppAuthorityDifferenceKind
	/** Visitor person id, or null for an anonymous visitor. Hashed before use. */
	visitorId: string | null
}

const maxCallNameLength = 100

/** One-way and salted per purpose; never reversible to a handle or name. */
export async function hashPackageAppVisitorId(visitorId: string | null) {
	if (!visitorId) return 'anonymous'
	const digest = await sha256Hex(`package-app-authority-fallback:${visitorId}`)
	return digest.slice(0, 24)
}

function utcDay(iso: string) {
	return iso.slice(0, 10)
}

function normalizeCallName(callName: string) {
	const trimmed = callName.trim().slice(0, maxCallNameLength)
	return trimmed || 'unknown'
}

export async function recordPackageAppAuthorityFallback(input: {
	db: D1Database
	event: PackageAppAuthorityFallbackEvent
	firstSeenAt: string
	lastSeenAt?: string
	observations?: number
}) {
	const ownerId = input.event.ownerId.trim()
	const packageId = input.event.packageId.trim()
	if (!ownerId || !packageId) return
	await input.db
		.prepare(
			`INSERT INTO package_app_authority_fallbacks (
				day, owner_id, package_id, call_name, difference_kind, visitor_hash,
				first_seen_at, last_seen_at, observations
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(day, package_id, call_name, difference_kind, visitor_hash) DO UPDATE SET
				first_seen_at = min(package_app_authority_fallbacks.first_seen_at, excluded.first_seen_at),
				last_seen_at = max(package_app_authority_fallbacks.last_seen_at, excluded.last_seen_at),
				observations = package_app_authority_fallbacks.observations + excluded.observations`,
		)
		.bind(
			utcDay(input.firstSeenAt),
			ownerId,
			packageId,
			normalizeCallName(input.event.callName),
			input.event.kind,
			await hashPackageAppVisitorId(input.event.visitorId),
			input.firstSeenAt,
			input.lastSeenAt ?? input.firstSeenAt,
			Math.max(1, Math.trunc(input.observations ?? 1)),
		)
		.run()
}

type PendingEvent = PackageAppAuthorityFallbackEvent & {
	firstSeenAt: string
	lastSeenAt: string
	observations: number
}

const pendingByDb = new WeakMap<D1Database, Map<string, PendingEvent>>()

export const packageAppAuthorityFallbackFlushDelayMs = 1_000

async function flushPending(db: D1Database, key: string, delayMs: number) {
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)))
	const pending = pendingByDb.get(db)
	const event = pending?.get(key)
	if (!pending || !event) return
	pending.delete(key)
	try {
		await recordPackageAppAuthorityFallback({
			db,
			event,
			firstSeenAt: event.firstSeenAt,
			lastSeenAt: event.lastSeenAt,
			observations: event.observations,
		})
	} catch (error) {
		console.error('package-app-authority-fallback-record-failed', {
			packageId: event.packageId,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

/**
 * Log a would-break event and record it after the response path.
 * Synchronous; never throws and never awaits D1 on the caller's path.
 */
export function schedulePackageAppAuthorityFallback(input: {
	env: Pick<Env, 'APP_DB'>
	event: PackageAppAuthorityFallbackEvent
	now?: string
	flushDelayMs?: number
	waitUntil?: (promise: Promise<unknown>) => void
}): void {
	try {
		const db = input.env.APP_DB
		const { event } = input
		if (!db || !event.ownerId.trim() || !event.packageId.trim()) return
		const now = input.now ?? new Date().toISOString()
		const callName = normalizeCallName(event.callName)
		console.warn(
			JSON.stringify({
				event: 'package_app_authority_fallback',
				packageId: event.packageId,
				callName,
				kind: event.kind,
				visitor: event.visitorId ? 'person' : 'anonymous',
			}),
		)
		const key = [
			utcDay(now),
			event.packageId,
			callName,
			event.kind,
			event.visitorId ?? '',
		].join('\0')
		let pending = pendingByDb.get(db)
		if (!pending) {
			pending = new Map()
			pendingByDb.set(db, pending)
		}
		const existing = pending.get(key)
		if (existing) {
			existing.observations += 1
			if (now > existing.lastSeenAt) existing.lastSeenAt = now
			return
		}
		pending.set(key, {
			...event,
			callName,
			firstSeenAt: now,
			lastSeenAt: now,
			observations: 1,
		})
		const sink = input.waitUntil ?? waitUntil
		sink(
			flushPending(
				db,
				key,
				input.flushDelayMs ?? packageAppAuthorityFallbackFlushDelayMs,
			),
		)
	} catch (error) {
		console.error('package-app-authority-fallback-schedule-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

export const packageAppAuthorityFallbackReportPackageLimitMax = 500

export type PackageAppAuthorityFallbackReport = {
	since: string
	until: string | null
	totals: {
		apps: number
		owners: number
		visitors: number
		observations: number
	}
	packagesTruncated: boolean
	packages: Array<{
		packageId: string
		ownerId: string
		packageKodyId: string | null
		observations: number
		visitors: number
		days: number
		firstSeenAt: string
		lastSeenAt: string
		calls: Array<{
			callName: string
			kind: PackageAppAuthorityDifferenceKind
			observations: number
		}>
	}>
}

/**
 * Fallback counts per app. `since`/`until` are UTC days (YYYY-MM-DD),
 * inclusive / exclusive. The legacy path can go once totals stay at zero.
 */
export async function buildPackageAppAuthorityFallbackReport(input: {
	db: D1Database
	since: string
	until?: string | null
	packageLimit?: number
	packageId?: string | null
}): Promise<PackageAppAuthorityFallbackReport> {
	const until = input.until ?? null
	const clauses = ['f.day >= ?']
	const binds: Array<string> = [input.since]
	if (until) {
		clauses.push('f.day < ?')
		binds.push(until)
	}
	if (input.packageId) {
		clauses.push('f.package_id = ?')
		binds.push(input.packageId)
	}
	const where = clauses.join(' AND ')
	const totals = await input.db
		.prepare(
			`SELECT
				COUNT(DISTINCT f.package_id) AS apps,
				COUNT(DISTINCT f.owner_id) AS owners,
				COUNT(DISTINCT f.visitor_hash) AS visitors,
				COALESCE(SUM(f.observations), 0) AS observations
			 FROM package_app_authority_fallbacks f
			 WHERE ${where}`,
		)
		.bind(...binds)
		.first<{
			apps: number
			owners: number
			visitors: number
			observations: number
		}>()
	const packageLimit = Math.min(
		Math.max(1, Math.trunc(input.packageLimit ?? 100)),
		packageAppAuthorityFallbackReportPackageLimitMax,
	)
	const packageRows = await input.db
		.prepare(
			`SELECT
				f.package_id AS package_id,
				MAX(f.owner_id) AS owner_id,
				p.kody_id AS package_kody_id,
				SUM(f.observations) AS observations,
				COUNT(DISTINCT f.visitor_hash) AS visitors,
				COUNT(DISTINCT f.day) AS days,
				MIN(f.first_seen_at) AS first_seen_at,
				MAX(f.last_seen_at) AS last_seen_at
			 FROM package_app_authority_fallbacks f
			 LEFT JOIN saved_packages p ON p.id = f.package_id AND p.deleted_at IS NULL
			 WHERE ${where}
			 GROUP BY f.package_id
			 ORDER BY observations DESC, f.package_id ASC
			 LIMIT ?`,
		)
		.bind(...binds, packageLimit + 1)
		.all<{
			package_id: string
			owner_id: string
			package_kody_id: string | null
			observations: number
			visitors: number
			days: number
			first_seen_at: string
			last_seen_at: string
		}>()
	const rows = packageRows.results ?? []
	const packagesTruncated = rows.length > packageLimit
	const packages: PackageAppAuthorityFallbackReport['packages'] = []
	for (const row of rows.slice(0, packageLimit)) {
		const calls = await input.db
			.prepare(
				`SELECT call_name, difference_kind AS kind,
					SUM(observations) AS observations
				 FROM package_app_authority_fallbacks f
				 WHERE f.package_id = ? AND ${where}
				 GROUP BY call_name, difference_kind
				 ORDER BY observations DESC, call_name ASC`,
			)
			.bind(row.package_id, ...binds)
			.all<{
				call_name: string
				kind: PackageAppAuthorityDifferenceKind
				observations: number
			}>()
		packages.push({
			packageId: row.package_id,
			ownerId: row.owner_id,
			packageKodyId: row.package_kody_id ?? null,
			observations: Number(row.observations),
			visitors: Number(row.visitors),
			days: Number(row.days),
			firstSeenAt: row.first_seen_at,
			lastSeenAt: row.last_seen_at,
			calls: (calls.results ?? []).map((call) => ({
				callName: call.call_name,
				kind: call.kind,
				observations: Number(call.observations),
			})),
		})
	}
	return {
		since: input.since,
		until,
		totals: {
			apps: Number(totals?.apps ?? 0),
			owners: Number(totals?.owners ?? 0),
			visitors: Number(totals?.visitors ?? 0),
			observations: Number(totals?.observations ?? 0),
		},
		packagesTruncated,
		packages,
	}
}
