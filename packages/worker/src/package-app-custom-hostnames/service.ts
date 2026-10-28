import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { parseStoredPlanName } from '#universal/plans.ts'
import { resolvePlanOverlay } from '#universal/second-agent-standard-gift.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	CloudflareCustomHostnamesClient,
	isCloudflareCustomHostnameGone,
	type CloudflareCustomHostnameResult,
	type CustomHostnameDnsRecord,
	type CustomHostnameSslMethod,
} from '#worker/package-app-custom-hostnames/cloudflare-custom-hostnames-client.ts'
import { checkRateLimit, releaseRateLimit } from '#worker/app/rate-limit.ts'
import {
	countOrgCustomHostnames,
	listOrgCustomHostnameRows,
	orgOwnsPackageIncludingDeleted,
} from '#worker/package-app-custom-hostnames/count-org.ts'
import {
	packageAppCustomHostnameAddRateLimit,
	packageAppCustomHostnameAddRateLimitKey,
	packageAppCustomHostnameMaxPerOrg,
} from '#worker/package-app-custom-hostnames/limits.ts'
import { packageAppCustomDomainsCnameTargetFromBaseUrl } from '#worker/package-app-custom-hostnames/cname-target.ts'
import { invalidateCachedPackageAppCustomHostname } from '#worker/package-app-custom-hostnames/lookup-cache.ts'
import { buildPackageAppCustomHostnameSetup } from '#worker/package-app-custom-hostnames/setup-instructions.ts'
import {
	isKodyReservedCustomHostname,
	listKodyRegistrableDomains,
} from '#worker/app-base-url.ts'
import {
	describePackageAppCustomDomainStatus,
	isPackageAppCustomDomainFailedStatus,
	type PackageAppCustomDomainRecordView,
	type PackageAppCustomDomainStatus,
	type PackageAppCustomDomainView,
} from '#universal/package-app-custom-domain-status.ts'
import { notifyOwnersOfCustomHostnameStatus } from '#worker/package-app-custom-hostnames/status-notice.ts'
import {
	isPackageAppCustomHostnameVerified,
	normalizeCustomHostname,
} from '#worker/package-app-custom-hostnames/lookup.ts'
import {
	type PackageAppCustomHostnameBindingKind,
	type PackageAppCustomHostnameDnsRecord,
	type PackageAppCustomHostnameRow,
} from '#worker/package-app-custom-hostnames/types.ts'

export class PackageAppCustomHostnameError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PackageAppCustomHostnameError'
	}
}

export type PackageAppCustomHostnameVerification = {
	ownership_verification: CustomHostnameDnsRecord | null
	ssl_validation_records: Array<CustomHostnameDnsRecord>
}

export type PackageAppCustomHostnamePublic = {
	id: string
	hostname: string
	binding_kind: PackageAppCustomHostnameBindingKind
	package_id: string | null
	org_id: string | null
	hostname_status: string
	ssl_status: string
	verified_at: string | null
	dns_missing_since: string | null
	verification: PackageAppCustomHostnameVerification
	/** pending / active / needs_attention with a plain-language reason. */
	status: PackageAppCustomDomainStatus
	needs_attention_at: string | null
	created_at: string
	updated_at: string
}

export type PackageAppCustomHostnameDnsHint = {
	type: 'CNAME'
	name: string
	target: string | null
}

type CustomHostnameRowSql = {
	id: string
	hostname: string
	binding_kind: string
	package_id: string | null
	org_id: string | null
	cloudflare_hostname_id: string | null
	cloudflare_zone_id: string | null
	hostname_status: string
	ssl_status: string
	verified_at: string | null
	dns_missing_since: string | null
	ownership_verification_json: string | null
	ssl_validation_records_json: string | null
	verification_errors_json?: string | null
	check_window_started_at?: string | null
	needs_attention_at?: string | null
	created_by_user_id: string | null
	created_at: string
	updated_at: string
}

function parseDnsRecord(
	value: unknown,
): PackageAppCustomHostnameDnsRecord | null {
	if (!value || typeof value !== 'object') return null
	const record = value as {
		type?: unknown
		name?: unknown
		value?: unknown
	}
	if (
		typeof record.type !== 'string' ||
		typeof record.name !== 'string' ||
		typeof record.value !== 'string'
	) {
		return null
	}
	return { type: record.type, name: record.name, value: record.value }
}

function parseOwnershipVerificationJson(
	raw: string | null,
): PackageAppCustomHostnameDnsRecord | null {
	if (!raw?.trim()) return null
	try {
		return parseDnsRecord(JSON.parse(raw) as unknown)
	} catch {
		return null
	}
}

function parseSslValidationRecordsJson(
	raw: string | null,
): Array<PackageAppCustomHostnameDnsRecord> {
	if (!raw?.trim()) return []
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed
			.map((entry) => parseDnsRecord(entry))
			.filter((entry): entry is PackageAppCustomHostnameDnsRecord =>
				Boolean(entry),
			)
	} catch {
		return []
	}
}

function parseVerificationErrorsJson(raw: string | null | undefined) {
	if (!raw?.trim()) return []
	try {
		const parsed = JSON.parse(raw) as unknown
		if (!Array.isArray(parsed)) return []
		return parsed.filter(
			(entry): entry is string =>
				typeof entry === 'string' && entry.trim().length > 0,
		)
	} catch {
		return []
	}
}

export function serializeVerificationErrors(errors: ReadonlyArray<string>) {
	return errors.length ? JSON.stringify(errors) : null
}

function serializeOwnershipVerification(
	record: PackageAppCustomHostnameDnsRecord | null,
): string | null {
	return record ? JSON.stringify(record) : null
}

function serializeSslValidationRecords(
	records: Array<PackageAppCustomHostnameDnsRecord>,
): string {
	return JSON.stringify(records)
}

function rowFromSql(row: CustomHostnameRowSql): PackageAppCustomHostnameRow {
	return {
		id: row.id,
		hostname: row.hostname,
		bindingKind: row.binding_kind as PackageAppCustomHostnameBindingKind,
		packageId: row.package_id,
		orgId: row.org_id,
		cloudflareHostnameId: row.cloudflare_hostname_id,
		cloudflareZoneId: row.cloudflare_zone_id,
		hostnameStatus: row.hostname_status,
		sslStatus: row.ssl_status,
		verifiedAt: row.verified_at,
		dnsMissingSince: row.dns_missing_since,
		ownershipVerification: parseOwnershipVerificationJson(
			row.ownership_verification_json,
		),
		sslValidationRecords: parseSslValidationRecordsJson(
			row.ssl_validation_records_json,
		),
		verificationErrors: parseVerificationErrorsJson(
			row.verification_errors_json,
		),
		checkWindowStartedAt: row.check_window_started_at ?? null,
		needsAttentionAt: row.needs_attention_at ?? null,
		createdByUserId: row.created_by_user_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function verificationFromRow(
	row: PackageAppCustomHostnameRow,
): PackageAppCustomHostnameVerification {
	return {
		ownership_verification: row.ownershipVerification,
		ssl_validation_records: row.sslValidationRecords,
	}
}

function publicRow(
	row: PackageAppCustomHostnameRow,
): PackageAppCustomHostnamePublic {
	return {
		id: row.id,
		hostname: row.hostname,
		binding_kind: row.bindingKind,
		package_id: row.packageId,
		org_id: row.orgId,
		hostname_status: row.hostnameStatus,
		ssl_status: row.sslStatus,
		verified_at: row.verifiedAt,
		dns_missing_since: row.dnsMissingSince,
		verification: verificationFromRow(row),
		status: describePackageAppCustomDomainStatus(row),
		needs_attention_at: row.needsAttentionAt,
		created_at: row.createdAt,
		updated_at: row.updatedAt,
	}
}

function verificationFromCloudflare(
	cf: CloudflareCustomHostnameResult,
): PackageAppCustomHostnameVerification {
	return {
		ownership_verification: cf.ownershipVerification,
		ssl_validation_records: cf.sslValidationRecords,
	}
}

function createCloudflareClient(env: Env & { fetcher?: Fetcher }) {
	return new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN:
			env.CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN,
		PACKAGE_APP_ZONE_ID: env.PACKAGE_APP_ZONE_ID,
		fetcher: env.fetcher,
	})
}

/**
 * Refuse hostnames the package-app runtime will never serve (Kody-owned
 * parent domains and `*.workers.dev`). Same predicate as
 * `resolveVerifiedCustomHostnameIfEnabled`, so registration and serving
 * cannot drift.
 */
export function assertCustomHostnameNotKodyReserved(
	env: Env,
	hostname: string,
) {
	if (!isKodyReservedCustomHostname({ env, hostname })) return
	const domains = listKodyRegistrableDomains(env).join(', ')
	throw new PackageAppCustomHostnameError(
		`${hostname} cannot be a custom domain. Kody never serves package apps on its own domains (${domains}) or on workers.dev, which keeps app code separate from Kody sign-in cookies. Use a hostname on a domain you own, such as apps.example.com.`,
	)
}

function setupFor(
	env: Env,
	row: { hostname: string; bindingKind: PackageAppCustomHostnameBindingKind },
	verification: PackageAppCustomHostnameVerification,
	options: { gone?: boolean } = {},
) {
	return buildPackageAppCustomHostnameSetup({
		hostname: row.hostname,
		bindingKind: row.bindingKind,
		gone: options.gone,
		cnameTarget: packageAppCustomDomainsCnameTargetFromBaseUrl(
			env.PACKAGE_APP_BASE_URL,
		),
		ownershipVerification: verification.ownership_verification,
		sslValidationRecords: verification.ssl_validation_records,
	})
}

/** Records in the camelCase shape the package page and org settings render. */
export function packageAppCustomDomainRecordViews(
	env: Env,
	row: {
		hostname: string
		ownershipVerification: PackageAppCustomHostnameDnsRecord | null
		sslValidationRecords: Array<PackageAppCustomHostnameDnsRecord>
	},
): Array<PackageAppCustomDomainRecordView> {
	// Only the records are used here, and they do not depend on the binding kind.
	return setupFor(
		env,
		{ hostname: row.hostname, bindingKind: 'app' },
		{
			ownership_verification: row.ownershipVerification,
			ssl_validation_records: row.sslValidationRecords,
		},
	).records.map((record) => ({
		type: record.type,
		name: record.name,
		relativeName: record.relative_name,
		value: record.value,
		purpose: record.purpose,
	}))
}

/**
 * App-level custom hostnames bound to one package, for the owner's package
 * page. Read-only; never calls Cloudflare.
 */
export async function listPackageAppCustomDomainViewsForPackage(input: {
	env: Env
	packageId: string
}): Promise<Array<PackageAppCustomDomainView>> {
	const rows = await input.env.APP_DB.prepare(
		`SELECT * FROM package_app_custom_hostnames
		 WHERE package_id = ? AND binding_kind = 'app'
		 ORDER BY created_at ASC`,
	)
		.bind(input.packageId)
		.all<CustomHostnameRowSql>()
	return (rows.results ?? []).map((sql) => {
		const row = rowFromSql(sql)
		return {
			id: row.id,
			hostname: row.hostname,
			bindingKind: row.bindingKind,
			status: describePackageAppCustomDomainStatus(row),
			records: packageAppCustomDomainRecordViews(input.env, row),
			verifiedAt: row.verifiedAt,
			lastCheckedAt: row.updatedAt,
		}
	})
}

function dnsHint(env: Env, hostname: string): PackageAppCustomHostnameDnsHint {
	return {
		type: 'CNAME',
		name: hostname,
		target: packageAppCustomDomainsCnameTargetFromBaseUrl(
			env.PACKAGE_APP_BASE_URL,
		),
	}
}

/**
 * ADR 0071: paying orgs only. Free plans cannot claim custom domains.
 * Uses the same manual `plan` + `stripe_plan` overlay as entitlements (no
 * second-agent/referral gift overlays — those are personal-org only).
 * Stripe $0.10 metering for extras is still deferred; extras get a note.
 */
async function readOrgPlanForCustomDomains(db: D1Database, orgId: string) {
	const org = await db
		.prepare(
			`SELECT plan, stripe_plan FROM orgs WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<{ plan: string | null; stripe_plan: string | null }>()
	if (!org) {
		throw new PackageAppCustomHostnameError('Organization not found.')
	}
	return resolvePlanOverlay(
		parseStoredPlanName(org.plan ?? 'free'),
		org.stripe_plan,
		null,
	).plan
}

/** Whether the org's plan allows adding custom domains (ADR 0071). */
export async function orgPlanAllowsCustomDomains(
	db: D1Database,
	orgId: string,
) {
	return (await readOrgPlanForCustomDomains(db, orgId)) !== 'free'
}

async function requirePaidOrgForCustomDomains(db: D1Database, orgId: string) {
	const plan = await readOrgPlanForCustomDomains(db, orgId)
	if (plan === 'free') {
		throw new PackageAppCustomHostnameError(
			'Custom domains require a paid organization plan. Paying orgs include one domain at no extra charge (ADR 0071).',
		)
	}
	return plan
}

async function billingNoteForAdd(db: D1Database, orgId: string) {
	const count = await countOrgCustomHostnames(db, orgId)
	if (count <= 1) return null
	return 'Paying orgs include one custom domain at no extra charge. Additional domains are $0.10/month each once billing is wired (ADR 0071); this environment does not charge yet.'
}

async function loadOwnedCustomHostnameRow(input: {
	env: Env
	orgId: string
	hostname?: string
	id?: string
}): Promise<PackageAppCustomHostnameRow> {
	const hostname = input.hostname
		? normalizeCustomHostname(input.hostname)
		: null
	const id = input.id?.trim() || null
	if (!hostname && !id) {
		throw new PackageAppCustomHostnameError('Pass hostname or id.')
	}
	// Prefer id when present so Open API path params cannot be overridden by a
	// conflicting body hostname. Hostname-only remains for MCP.
	const row = id
		? await input.env.APP_DB.prepare(
				`SELECT * FROM package_app_custom_hostnames WHERE id = ?`,
			)
				.bind(id)
				.first<CustomHostnameRowSql>()
		: await input.env.APP_DB.prepare(
				`SELECT * FROM package_app_custom_hostnames WHERE hostname = ?`,
			)
				.bind(hostname)
				.first<CustomHostnameRowSql>()
	if (!row) {
		throw new PackageAppCustomHostnameError('Custom hostname not found.')
	}
	if (id && hostname && row.hostname !== hostname) {
		throw new PackageAppCustomHostnameError(
			'hostname does not match the custom hostname id.',
		)
	}
	const owned =
		row.org_id === input.orgId ||
		(row.package_id != null &&
			(await orgOwnsPackageIncludingDeleted(input.env.APP_DB, {
				orgId: input.orgId,
				packageId: row.package_id,
			})))
	if (!owned) {
		throw new PackageAppCustomHostnameError(
			'This custom hostname does not belong to the bound organization.',
		)
	}
	return rowFromSql(row)
}

function deletedCloudflareHostnameResult(
	row: PackageAppCustomHostnameRow,
): CloudflareCustomHostnameResult {
	return {
		id: row.cloudflareHostnameId ?? row.id,
		hostname: row.hostname,
		hostnameStatus: 'deleted',
		sslStatus: row.sslStatus,
		ownershipVerification: null,
		sslValidationRecords: [],
		verificationErrors: [],
	}
}

async function insertCustomHostnameRow(input: {
	env: Env
	id: string
	hostname: string
	bindingKind: PackageAppCustomHostnameBindingKind
	packageId: string | null
	orgId: string | null
	cloudflareHostnameId: string
	cloudflareZoneId: string | null
	hostnameStatus: string
	sslStatus: string
	ownershipVerification: PackageAppCustomHostnameDnsRecord | null
	sslValidationRecords: Array<PackageAppCustomHostnameDnsRecord>
	createdByUserId: string
	now: string
}) {
	const ownershipJson = serializeOwnershipVerification(
		input.ownershipVerification,
	)
	const sslRecordsJson = serializeSslValidationRecords(
		input.sslValidationRecords,
	)
	// One explicit-column INSERT for both bindings. Split app/org VALUES
	// clauses previously drifted (app omitted a placeholder for
	// check_window_started_at after migration 0175).
	switch (input.bindingKind) {
		case 'app':
		case 'org':
			break
		default: {
			input.bindingKind satisfies never
			throw new PackageAppCustomHostnameError('binding_kind is invalid.')
		}
	}
	await input.env.APP_DB.prepare(
		`INSERT INTO package_app_custom_hostnames (
				id, hostname, binding_kind, package_id, org_id,
				cloudflare_hostname_id, cloudflare_zone_id,
				hostname_status, ssl_status,
				ownership_verification_json, ssl_validation_records_json,
				created_by_user_id, created_at, updated_at,
				check_window_started_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.id,
			input.hostname,
			input.bindingKind,
			input.packageId,
			input.orgId,
			input.cloudflareHostnameId,
			input.cloudflareZoneId,
			input.hostnameStatus,
			input.sslStatus,
			ownershipJson,
			sslRecordsJson,
			input.createdByUserId,
			input.now,
			input.now,
			input.now,
		)
		.run()
}

async function compensateCloudflareDelete(input: {
	client: CloudflareCustomHostnamesClient
	cloudflareHostnameId: string
	hostname: string
}) {
	try {
		await input.client.deleteCustomHostname({
			id: input.cloudflareHostnameId,
		})
	} catch (error) {
		console.error(
			'package_app_custom_hostnames compensating Cloudflare delete failed:',
			input.hostname,
			input.cloudflareHostnameId,
			getErrorMessage(error),
		)
	}
}

function shouldStartDnsMissingGrace(input: {
	verifiedAt: string | null
	hostnameStatus: string
	sslStatus: string
}) {
	if (
		isPackageAppCustomHostnameVerified({
			hostnameStatus: input.hostnameStatus,
			sslStatus: input.sslStatus,
		})
	) {
		return false
	}
	if (input.verifiedAt) return true
	return input.hostnameStatus === 'moved' || input.hostnameStatus === 'deleted'
}

/**
 * Claim the first time a hostname goes active. Run it in the same
 * `db.batch()` as the status update so the claim and the row write commit
 * together; the statement changes one row for exactly one caller (sync or
 * the reconcile cron), which then owns the owner notice.
 */
export function prepareClaimPackageAppCustomHostnameActivation(input: {
	db: D1Database
	id: string
	nowIso: string
}): D1PreparedStatement {
	return input.db
		.prepare(
			`UPDATE package_app_custom_hostnames
			 SET verified_at = ?, needs_attention_at = NULL
			 WHERE id = ? AND verified_at IS NULL`,
		)
		.bind(input.nowIso, input.id)
}

/** Whether a claim statement from a `db.batch()` result changed its row. */
export function claimedInBatch(result: D1Result | undefined): boolean {
	return (result?.meta.changes ?? 0) > 0
}

async function applyCloudflareStatus(input: {
	env: Env
	row: PackageAppCustomHostnameRow
	cf: CloudflareCustomHostnameResult
	nowIso: string
}): Promise<PackageAppCustomHostnameRow> {
	const verified = isPackageAppCustomHostnameVerified({
		hostnameStatus: input.cf.hostnameStatus,
		sslStatus: input.cf.sslStatus ?? input.row.sslStatus,
	})
	let dnsMissingSince = input.row.dnsMissingSince
	if (verified) {
		dnsMissingSince = null
	} else if (
		shouldStartDnsMissingGrace({
			verifiedAt: input.row.verifiedAt,
			hostnameStatus: input.cf.hostnameStatus,
			sslStatus: input.cf.sslStatus ?? input.row.sslStatus,
		})
	) {
		dnsMissingSince = dnsMissingSince ?? input.nowIso
	}
	const claimActivation = verified && !input.row.verifiedAt
	const verifiedAt =
		verified && !input.row.verifiedAt ? input.nowIso : input.row.verifiedAt
	const hostnameStatus = input.cf.hostnameStatus
	const sslStatus = input.cf.sslStatus ?? input.row.sslStatus
	const ownershipVerification = input.cf.ownershipVerification
	const sslValidationRecords = input.cf.sslValidationRecords
	const verificationErrors = input.cf.verificationErrors
	// A manual sync on a hostname that is still not active means the person
	// just changed DNS: clear needs-attention and restart the re-check window.
	// A terminal Cloudflare failure will not clear by waiting, so it keeps
	// (or gains) needs-attention instead; the person is already looking.
	const neverVerified = !verified && !input.row.verifiedAt
	const failed =
		neverVerified &&
		isPackageAppCustomDomainFailedStatus({ hostnameStatus, sslStatus })
	const restartWindow = neverVerified && !failed
	const checkWindowStartedAt = restartWindow
		? input.nowIso
		: input.row.checkWindowStartedAt
	const needsAttentionAt =
		verified || restartWindow
			? null
			: failed
				? (input.row.needsAttentionAt ?? input.nowIso)
				: input.row.needsAttentionAt
	const db = input.env.APP_DB
	const update = db
		.prepare(
			`UPDATE package_app_custom_hostnames
			 SET hostname_status = ?,
			     ssl_status = ?,
			     verified_at = COALESCE(verified_at, ?),
			     dns_missing_since = ?,
			     ownership_verification_json = ?,
			     ssl_validation_records_json = ?,
			     verification_errors_json = ?,
			     check_window_started_at = ?,
			     needs_attention_at = ?,
			     updated_at = ?
			 WHERE id = ?`,
		)
		.bind(
			hostnameStatus,
			sslStatus,
			verifiedAt,
			dnsMissingSince,
			serializeOwnershipVerification(ownershipVerification),
			serializeSslValidationRecords(sslValidationRecords),
			serializeVerificationErrors(verificationErrors),
			checkWindowStartedAt,
			needsAttentionAt,
			input.nowIso,
			input.row.id,
		)
	const results = claimActivation
		? await db.batch([
				prepareClaimPackageAppCustomHostnameActivation({
					db,
					id: input.row.id,
					nowIso: input.nowIso,
				}),
				update,
			])
		: [await update.run()]
	const firstActivation = claimActivation && claimedInBatch(results[0])
	const updated: PackageAppCustomHostnameRow = {
		...input.row,
		hostnameStatus,
		sslStatus,
		verifiedAt,
		dnsMissingSince,
		ownershipVerification,
		sslValidationRecords,
		verificationErrors,
		checkWindowStartedAt,
		needsAttentionAt,
		updatedAt: input.nowIso,
	}
	if (firstActivation) {
		await notifyOwnersOfCustomHostnameStatus({
			env: input.env,
			row: updated,
			event: 'active',
		})
	}
	return updated
}

export async function addPackageAppCustomHostname(input: {
	env: Env
	orgId: string
	createdByUserId: string
	bindingKind: PackageAppCustomHostnameBindingKind
	hostname: string
	packageId?: string
	sslMethod?: CustomHostnameSslMethod
}) {
	await requirePaidOrgForCustomDomains(input.env.APP_DB, input.orgId)
	const hostname = normalizeCustomHostname(input.hostname)
	if (!hostname) {
		throw new PackageAppCustomHostnameError('hostname is not a valid DNS name.')
	}
	assertCustomHostnameNotKodyReserved(input.env, hostname)
	const existingCount = await countOrgCustomHostnames(
		input.env.APP_DB,
		input.orgId,
	)
	if (existingCount >= packageAppCustomHostnameMaxPerOrg) {
		throw new PackageAppCustomHostnameError(
			`This organization already has ${packageAppCustomHostnameMaxPerOrg} custom domains (abuse limit). Remove one before adding another.`,
		)
	}
	const now = new Date().toISOString()
	const id = crypto.randomUUID()
	const sslMethod = input.sslMethod ?? 'http'
	let packageId: string | null = null
	let orgId: string | null = null

	// Validate binding before consuming the add rate-limit slot so bad
	// package_id attempts cannot exhaust the org's claim budget.
	switch (input.bindingKind) {
		case 'app': {
			const resolvedPackageId = input.packageId?.trim()
			if (!resolvedPackageId) {
				throw new PackageAppCustomHostnameError(
					'package_id is required for an app-level custom hostname.',
				)
			}
			const saved = await getSavedPackageById(input.env.APP_DB, {
				userId: input.orgId,
				packageId: resolvedPackageId,
			})
			if (!saved) {
				throw new PackageAppCustomHostnameError(
					'Package not found in this organization.',
				)
			}
			if (!saved.isInternetVisible) {
				throw new PackageAppCustomHostnameError(
					'App-level custom hostnames are only for internet-visible (public) package apps. Use an org-level domain for private apps.',
				)
			}
			packageId = resolvedPackageId
			orgId = null
			break
		}
		case 'org': {
			packageId = null
			orgId = input.orgId
			break
		}
		default: {
			input.bindingKind satisfies never
			throw new PackageAppCustomHostnameError('binding_kind is invalid.')
		}
	}

	const rateLimitKey = packageAppCustomHostnameAddRateLimitKey(input.orgId)
	const rateLimit = await checkRateLimit(
		input.env.APP_DB,
		rateLimitKey,
		packageAppCustomHostnameAddRateLimit,
	)
	if (!rateLimit.allowed) {
		throw new PackageAppCustomHostnameError(
			`Too many custom domain claims. Try again in about ${rateLimit.retryAfterSeconds ?? packageAppCustomHostnameAddRateLimit.windowSeconds} seconds.`,
		)
	}
	const client = createCloudflareClient(input.env)
	let cf: CloudflareCustomHostnameResult
	try {
		cf = await client.addCustomHostname({ hostname, sslMethod })
	} catch (error) {
		await releaseRateLimit(input.env.APP_DB, rateLimitKey).catch(
			() => undefined,
		)
		throw error
	}
	const cloudflareZoneId = input.env.PACKAGE_APP_ZONE_ID?.trim() ?? null
	try {
		await insertCustomHostnameRow({
			env: input.env,
			id,
			hostname,
			bindingKind: input.bindingKind,
			packageId,
			orgId,
			cloudflareHostnameId: cf.id,
			cloudflareZoneId,
			hostnameStatus: cf.hostnameStatus,
			sslStatus: cf.sslStatus ?? 'pending',
			ownershipVerification: cf.ownershipVerification,
			sslValidationRecords: cf.sslValidationRecords,
			createdByUserId: input.createdByUserId,
			now,
		})
	} catch (error) {
		await compensateCloudflareDelete({
			client,
			cloudflareHostnameId: cf.id,
			hostname,
		})
		await releaseRateLimit(input.env.APP_DB, rateLimitKey).catch(
			() => undefined,
		)
		if (error instanceof PackageAppCustomHostnameError) throw error
		throw new PackageAppCustomHostnameError(
			`Custom hostname could not be stored (${getErrorMessage(error)}).`,
		)
	}

	// Re-check after insert so concurrent adds cannot permanently exceed the
	// hard cap. Losers roll back CF + the row and refund the rate-limit slot.
	// If the recount itself fails, compensate both writes so we never leave a
	// claimed hostname without returning it to the caller.
	let postInsertCount: number
	try {
		postInsertCount = await countOrgCustomHostnames(
			input.env.APP_DB,
			input.orgId,
		)
	} catch (error) {
		await input.env.APP_DB.prepare(
			`DELETE FROM package_app_custom_hostnames WHERE id = ?`,
		)
			.bind(id)
			.run()
		invalidateCachedPackageAppCustomHostname(input.env.APP_DB, hostname)
		await compensateCloudflareDelete({
			client,
			cloudflareHostnameId: cf.id,
			hostname,
		})
		await releaseRateLimit(input.env.APP_DB, rateLimitKey).catch(
			() => undefined,
		)
		throw new PackageAppCustomHostnameError(
			`Custom hostname could not be confirmed after store (${getErrorMessage(error)}).`,
		)
	}
	if (postInsertCount > packageAppCustomHostnameMaxPerOrg) {
		await input.env.APP_DB.prepare(
			`DELETE FROM package_app_custom_hostnames WHERE id = ?`,
		)
			.bind(id)
			.run()
		invalidateCachedPackageAppCustomHostname(input.env.APP_DB, hostname)
		await compensateCloudflareDelete({
			client,
			cloudflareHostnameId: cf.id,
			hostname,
		})
		await releaseRateLimit(input.env.APP_DB, rateLimitKey).catch(
			() => undefined,
		)
		throw new PackageAppCustomHostnameError(
			`This organization already has ${packageAppCustomHostnameMaxPerOrg} custom domains (abuse limit). Remove one before adding another.`,
		)
	}

	const row = await input.env.APP_DB.prepare(
		`SELECT * FROM package_app_custom_hostnames WHERE id = ?`,
	)
		.bind(id)
		.first<CustomHostnameRowSql>()
	if (!row) {
		await compensateCloudflareDelete({
			client,
			cloudflareHostnameId: cf.id,
			hostname,
		})
		await releaseRateLimit(input.env.APP_DB, rateLimitKey).catch(
			() => undefined,
		)
		throw new PackageAppCustomHostnameError(
			'Custom hostname row was not stored.',
		)
	}
	invalidateCachedPackageAppCustomHostname(input.env.APP_DB, hostname)
	const billingNote = await billingNoteForAdd(input.env.APP_DB, input.orgId)
	const verification = verificationFromCloudflare(cf)
	return {
		hostname: publicRow(rowFromSql(row)),
		dns: dnsHint(input.env, hostname),
		verification,
		setup: setupFor(
			input.env,
			{ hostname, bindingKind: input.bindingKind },
			verification,
		),
		billing_note: billingNote,
	}
}

export async function listPackageAppCustomHostnames(input: {
	env: Env
	orgId: string
}) {
	const rows = await listOrgCustomHostnameRows<CustomHostnameRowSql>(
		input.env.APP_DB,
		input.orgId,
	)
	return {
		hostnames: rows.map((row) => publicRow(rowFromSql(row))),
	}
}

export async function syncPackageAppCustomHostname(input: {
	env: Env
	orgId: string
	hostname?: string
	id?: string
	now?: Date
}) {
	const row = await loadOwnedCustomHostnameRow(input)
	const cfId = row.cloudflareHostnameId?.trim()
	if (!cfId) {
		throw new PackageAppCustomHostnameError(
			'This custom hostname has no Cloudflare hostname id to sync.',
		)
	}
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const client = createCloudflareClient(input.env)
	const cfOrGone = await client.getCustomHostname({ id: cfId })
	const cf = isCloudflareCustomHostnameGone(cfOrGone)
		? deletedCloudflareHostnameResult(row)
		: cfOrGone
	const updated = await applyCloudflareStatus({
		env: input.env,
		row,
		cf,
		nowIso,
	})
	invalidateCachedPackageAppCustomHostname(input.env.APP_DB, updated.hostname)
	const verification: PackageAppCustomHostnameVerification =
		isCloudflareCustomHostnameGone(cfOrGone)
			? {
					ownership_verification: null,
					ssl_validation_records: [],
				}
			: verificationFromCloudflare(cf)
	return {
		hostname: publicRow(updated),
		dns: dnsHint(input.env, updated.hostname),
		verification,
		setup: setupFor(input.env, updated, verification, {
			gone: isCloudflareCustomHostnameGone(cfOrGone),
		}),
	}
}

export async function removePackageAppCustomHostnameRow(input: {
	env: Env
	row: PackageAppCustomHostnameRow
}) {
	if (input.row.cloudflareHostnameId?.trim()) {
		const client = createCloudflareClient(input.env)
		await client.deleteCustomHostname({ id: input.row.cloudflareHostnameId })
	}
	await input.env.APP_DB.prepare(
		`DELETE FROM package_app_custom_hostnames WHERE id = ?`,
	)
		.bind(input.row.id)
		.run()
	invalidateCachedPackageAppCustomHostname(input.env.APP_DB, input.row.hostname)
}

/**
 * Operator takedown (abuse, phishing): remove a custom hostname from
 * Cloudflare for SaaS and the DB regardless of which org owns it. Callers
 * must be site admins and record an audit reason.
 */
export async function adminRemovePackageAppCustomHostname(input: {
	env: Env
	hostname: string
}) {
	const hostname = normalizeCustomHostname(input.hostname)
	if (!hostname) {
		throw new PackageAppCustomHostnameError('hostname is invalid.')
	}
	const sqlRow = await input.env.APP_DB.prepare(
		`SELECT * FROM package_app_custom_hostnames WHERE hostname = ?`,
	)
		.bind(hostname)
		.first<CustomHostnameRowSql>()
	if (!sqlRow) {
		throw new PackageAppCustomHostnameError('Custom hostname not found.')
	}
	const row = rowFromSql(sqlRow)
	await removePackageAppCustomHostnameRow({ env: input.env, row })
	return {
		ok: true as const,
		id: row.id,
		hostname: row.hostname,
		binding_kind: row.bindingKind,
		org_id: row.orgId,
		package_id: row.packageId,
		hostname_status: row.hostnameStatus,
	}
}

export async function deletePackageAppCustomHostname(input: {
	env: Env
	orgId: string
	hostname?: string
	id?: string
}) {
	const row = await loadOwnedCustomHostnameRow(input)
	await removePackageAppCustomHostnameRow({
		env: input.env,
		row,
	})
	return { ok: true as const, id: row.id, hostname: row.hostname }
}

export async function listPackageAppCustomHostnamesForReconcile(
	db: D1Database,
	input: { limit: number; afterId?: string },
) {
	const after = input.afterId ?? ''
	const rows = await db
		.prepare(
			`SELECT * FROM package_app_custom_hostnames
			 WHERE id > ?
			 ORDER BY id ASC
			 LIMIT ?`,
		)
		.bind(after, input.limit)
		.all<CustomHostnameRowSql>()
	return (rows.results ?? []).map(rowFromSql)
}
