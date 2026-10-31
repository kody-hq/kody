/**
 * Hard-rejection log for package apps (ADR 0068 amendment 2026-10-24).
 *
 * Apps run as their runs-as person. A call refused because the app does not
 * declare it leaves a row: app, call name, kind, and a hashed visitor id.
 * Never a handle, name, email, or value.
 *
 * Hot path cost: the scheduler never awaits D1. Repeats inside one isolate
 * coalesce into one upsert through `waitUntil`.
 */
import { waitUntil } from 'cloudflare:workers'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'

/** A Kody capability the app does not list in `kody.app.capabilities`. */
export type PackageAppAuthorityRejectionKind = 'capability_not_declared'

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
	const credentialNamed = capabilityName === credentialNamedCallName
	const parts = [
		credentialNamed
			? `Package app call "${capabilityName}" cannot open the runs-as person's credentials by name${app ? ` in the app "${app}"` : ''}.`
			: `Package app capability "${capabilityName}" is not listed in kody.app.capabilities${app ? ` of the app "${app}"` : ''}.`,
	]
	if (callingPackage) {
		parts.push(
			`The call came from "${callingPackage}", a package the app imports.`,
		)
	}
	parts.push(
		credentialNamed
			? 'Apps open only the credentials they declare, including from packages they import.'
			: 'Apps run as their runs-as person (the publisher unless an Owner chose someone else) and may call only the Kody capabilities they declare, including calls made by packages they import.',
	)
	const manifest = appName
		? `the package.json of "${appName}"`
		: "the app's package.json"
	parts.push(
		credentialNamed
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
const rejectionsTable = 'package_app_authority_rejections'

export type PackageAppAuthorityRejectionEvent = {
	ownerId: string
	packageId: string
	callName: string
	kind: PackageAppAuthorityRejectionKind
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

export async function recordPackageAppAuthorityRejection(input: {
	db: D1Database
	event: PackageAppAuthorityRejectionEvent
	firstSeenAt: string
	lastSeenAt?: string
	observations?: number
}) {
	const ownerId = input.event.ownerId.trim()
	const packageId = input.event.packageId.trim()
	if (!ownerId || !packageId) return
	const table = rejectionsTable
	await input.db
		.prepare(
			`INSERT INTO ${table} (
				day, owner_id, package_id, call_name, difference_kind, visitor_hash,
				first_seen_at, last_seen_at, observations
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(day, package_id, call_name, difference_kind, visitor_hash) DO UPDATE SET
				first_seen_at = min(${table}.first_seen_at, excluded.first_seen_at),
				last_seen_at = max(${table}.last_seen_at, excluded.last_seen_at),
				observations = ${table}.observations + excluded.observations`,
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

type PendingEvent = PackageAppAuthorityRejectionEvent & {
	firstSeenAt: string
	lastSeenAt: string
	observations: number
}

const pendingByDb = new WeakMap<D1Database, Map<string, PendingEvent>>()

export const packageAppAuthorityRejectionFlushDelayMs = 1_000

async function flushPending(db: D1Database, key: string, delayMs: number) {
	await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)))
	const pending = pendingByDb.get(db)
	const event = pending?.get(key)
	if (!pending || !event) return
	pending.delete(key)
	try {
		await recordPackageAppAuthorityRejection({
			db,
			event,
			firstSeenAt: event.firstSeenAt,
			lastSeenAt: event.lastSeenAt,
			observations: event.observations,
		})
	} catch (error) {
		console.error('package-app-authority-rejection-record-failed', {
			packageId: event.packageId,
			error: error instanceof Error ? error.message : String(error),
		})
	}
}

type ScheduleAuthorityEventInput = {
	env: Pick<Env, 'APP_DB'>
	event: PackageAppAuthorityRejectionEvent
	now?: string
	flushDelayMs?: number
	waitUntil?: (promise: Promise<unknown>) => void
}

/**
 * Log a hard rejection and record it after the response path. Synchronous;
 * never throws and never awaits D1 on the caller's path.
 */
export function schedulePackageAppAuthorityRejection(
	input: ScheduleAuthorityEventInput,
): void {
	try {
		const db = input.env.APP_DB
		const { event } = input
		if (!db || !event.ownerId.trim() || !event.packageId.trim()) return
		const now = input.now ?? new Date().toISOString()
		const callName = normalizeCallName(event.callName)
		console.warn(
			JSON.stringify({
				event: 'package_app_authority_rejection',
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
				input.flushDelayMs ?? packageAppAuthorityRejectionFlushDelayMs,
			),
		)
	} catch (error) {
		console.error('package-app-authority-rejection-schedule-failed', {
			error: error instanceof Error ? error.message : String(error),
		})
	}
}
