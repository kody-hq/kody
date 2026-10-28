/**
 * Admin fleet inventory of credential placeholders in published package
 * source, and the `provider` / `inject_json` backfill it drives (ADR 0068).
 *
 * The scan never changes a package or a credential. Each package's result is
 * attributed to credential ids and stored without credential names or
 * values. The backfill reads a complete run and fills a row only where it is
 * still unset: `provider` when every slot naming the credential agrees on one
 * provider slug, and `inject_json` when every placement of the credential is
 * the same header or the same query param.
 */
import { listSavedPackagesPage } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	type CredentialEndpoint,
	type CredentialOtherContext,
	type CredentialPlacement,
	type CredentialPlacementType,
	credentialOtherContexts,
	credentialPlacementTypes,
	emptyPlaceholderCounts,
	scanPackageCredentials,
} from './credential-inventory-scan.ts'
import { type PlaceholderMatchKind } from './module-placeholder-scan.ts'

export const credentialInventoryScanLimitDefault = 25
export const credentialInventoryScanLimitMax = 50

/** D1 caps bound parameters per statement; stay well under it. */
const idChunkSize = 50

const providerSlugPattern = /^[a-z0-9][a-z0-9-]{0,63}$/

export const defaultCredentialInject = {
	kind: 'header',
	name: 'Authorization',
	format: 'Bearer {value}',
} as const

export type CredentialInject =
	| { kind: 'header'; name: string; format: string }
	| { kind: 'query'; param: string }

/** Which table a credential id lives in. */
export type InventoryCredentialTable = 'secret' | 'integration'

export type InventoryReference = {
	table: InventoryCredentialTable
	/** Credential rows this placeholder can fill; empty when none exists. */
	credentialIds: Array<string>
	scope: string | null
	placement: CredentialPlacement
}

export type InventorySlot = {
	kind: 'secret' | 'oauth' | 'mcp'
	provider: string
	/** Credential rows the slot names (secret and oauth slots only). */
	credentialIds: Array<string>
}

export type InventoryItemResult = {
	placeholders: Record<PlaceholderMatchKind, number>
	unparsedModules: number
	references: Array<InventoryReference>
	/** Absent on items scanned before vault placements were recorded. */
	vaultPlacements?: Array<CredentialPlacement>
	/** Absent on items scanned before `secretJwtSign` calls were counted. */
	jwtSignCalls?: number
	slots: Array<InventorySlot>
}

export type InventoryItemStatus = 'scanned' | 'unpublished' | 'failed'

export type CredentialInventoryReport = {
	packages: Record<InventoryItemStatus, number> & {
		withPlaceholders: number
		withSlots: number
	}
	placeholders: Record<PlaceholderMatchKind, number>
	unparsedModules: number
	references: {
		total: number
		attributed: number
		unattributed: number
		byPlacement: Record<CredentialPlacementType, number>
		unattributedByPlacement: Record<CredentialPlacementType, number>
		otherByContext: Record<CredentialOtherContext, number>
		bodyByEndpoint: Record<CredentialEndpoint, number>
		/** Most common body fields a placeholder fills. */
		bodyFields: Array<InventoryTally>
		/** Most common `callee.key` options an SDK placeholder fills. */
		sdkOptions: Array<InventoryTally>
		/** Most common callees a placeholder is passed to directly. */
		argumentCallees: Array<InventoryTally>
	}
	vault: { byPlacement: Record<CredentialPlacementType, number> }
	signing: {
		/** Placeholders used as signing key material. */
		placeholderKeys: number
		jwtSignCalls: number
		packagesWithSigning: number
	}
	slots: {
		total: number
		attributed: number
		byKind: Record<InventorySlot['kind'], number>
	}
	credentialsReferenced: number
	/** The packages the run could not scan, first by package id. */
	failures: Array<InventoryFailure>
}

export type InventoryFailure = { packageId: string; error: string }

export type InventoryTally = { name: string; count: number }

/** How many entries each tally list in a report keeps. */
export const credentialInventoryTallyMax = 25

/** How many failed packages a report lists; `packages.failed` counts all. */
export const credentialInventoryFailureListMax = 50

type InventoryRunRow = {
	id: string
	status: 'scanning' | 'complete'
	cursor: string | null
}

function chunk<T>(values: ReadonlyArray<T>, size = idChunkSize) {
	const chunks: Array<Array<T>> = []
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size))
	}
	return chunks
}

function placeholders(count: number) {
	return Array.from({ length: count }, () => '?').join(', ')
}

async function getRun(db: D1Database, runId: string) {
	const run = await db
		.prepare(
			`SELECT id, status, cursor FROM credential_inventory_runs WHERE id = ?`,
		)
		.bind(runId)
		.first<InventoryRunRow>()
	if (!run) throw new Error(`Credential inventory run ${runId} not found.`)
	return run
}

type SecretRow = {
	id: string
	name: string
	scope: 'user' | 'package'
	user_id: string
}

/**
 * Live secrets a package's placeholders can fill: the package-scope rows saved for
 * this package (in any org that ran it) and the owner org's org-level row.
 */
async function loadSecretCandidates(
	db: D1Database,
	savedPackage: SavedPackageRecord,
	names: ReadonlyArray<string>,
) {
	const rows: Array<SecretRow> = []
	for (const batch of chunk(names)) {
		const result = await db
			.prepare(
				`SELECT e.id AS id, e.name AS name, b.scope AS scope, b.user_id AS user_id
				FROM secret_entries e
				JOIN secret_buckets b ON b.id = e.bucket_id
				WHERE e.id IS NOT NULL AND e.deleted_at IS NULL AND b.deleted_at IS NULL
					AND e.name IN (${placeholders(batch.length)})
					AND (
						(b.scope = 'user' AND b.binding_key = '' AND b.user_id = ?)
						OR (b.scope = 'package' AND b.binding_key = ?)
					)`,
			)
			.bind(...batch, savedPackage.userId, savedPackage.id)
			.all<SecretRow>()
		rows.push(...(result.results ?? []))
	}
	return rows
}

async function loadIntegrationIds(
	db: D1Database,
	ownerId: string,
	names: ReadonlyArray<string>,
) {
	const ids = new Map<string, string>()
	for (const batch of chunk(names)) {
		const result = await db
			.prepare(
				`SELECT id, name FROM user_integrations
				WHERE id IS NOT NULL AND deleted_at IS NULL AND user_id = ? AND name IN (${placeholders(batch.length)})`,
			)
			.bind(ownerId, ...batch)
			.all<{ id: string; name: string }>()
		for (const row of result.results ?? []) ids.set(row.name, row.id)
	}
	return ids
}

/**
 * The rows a secret placeholder resolves to. Lookup order is package scope,
 * then the org: the owner org's package row shadows its org row, and other
 * orgs' package rows for this package count on their own.
 */
function secretIdsFor(
	rows: ReadonlyArray<SecretRow>,
	name: string,
	scope: string | null,
	ownerId: string,
) {
	const named = rows.filter((row) => row.name === name)
	const packageRows = named.filter((row) => row.scope === 'package')
	const orgRow = named.find(
		(row) => row.scope === 'user' && row.user_id === ownerId,
	)
	switch (scope) {
		case 'session':
			return []
		case 'package':
			return packageRows.map((row) => row.id)
		case 'user':
			return orgRow ? [orgRow.id] : []
		default: {
			const ownerHasPackageRow = packageRows.some(
				(row) => row.user_id === ownerId,
			)
			return [
				...packageRows.map((row) => row.id),
				...(orgRow && !ownerHasPackageRow ? [orgRow.id] : []),
			]
		}
	}
}

export async function attributePackageCredentials(input: {
	db: D1Database
	savedPackage: SavedPackageRecord
	files: Record<string, string>
	slots: Parameters<typeof scanPackageCredentials>[0]['slots']
}): Promise<InventoryItemResult> {
	const scan = scanPackageCredentials({
		files: input.files,
		slots: input.slots,
	})
	const ownerId = input.savedPackage.userId
	const secretNames = new Set<string>()
	const integrationNames = new Set<string>()
	for (const reference of scan.references) {
		if (reference.nameKind === 'secret') secretNames.add(reference.name)
		else integrationNames.add(reference.name)
	}
	for (const slot of scan.slots) {
		if (slot.kind === 'secret') secretNames.add(slot.name)
		if (slot.kind === 'oauth') integrationNames.add(slot.name)
	}
	const secretRows = await loadSecretCandidates(input.db, input.savedPackage, [
		...secretNames,
	])
	const integrationIds = await loadIntegrationIds(input.db, ownerId, [
		...integrationNames,
	])
	const integrationIdsFor = (name: string) => {
		const id = integrationIds.get(name)
		return id ? [id] : []
	}
	return {
		placeholders: scan.placeholders,
		unparsedModules: scan.unparsedModules,
		vaultPlacements: scan.vaultPlacements,
		jwtSignCalls: scan.jwtSignCalls,
		references: scan.references.map((reference) => ({
			table: reference.nameKind,
			credentialIds:
				reference.nameKind === 'secret'
					? secretIdsFor(secretRows, reference.name, reference.scope, ownerId)
					: reference.scope === 'session'
						? []
						: integrationIdsFor(reference.name),
			scope: reference.scope,
			placement: reference.placement,
		})),
		// The inventory counts the kinds it was built for; later kinds are not
		// placeholder slots.
		slots: scan.slots.flatMap((slot) => {
			switch (slot.kind) {
				case 'secret':
				case 'oauth':
				case 'mcp':
					return [
						{
							kind: slot.kind,
							provider: slot.provider,
							credentialIds:
								slot.kind === 'secret'
									? secretIdsFor(secretRows, slot.name, null, ownerId)
									: slot.kind === 'oauth'
										? integrationIdsFor(slot.name)
										: [],
						},
					]
				case 'url':
				case 'login':
				case 'signing':
				case 'secret-provider':
				case undefined:
					return []
				default: {
					const exhaustive: never = slot.kind
					throw new Error(`Unhandled slot kind: ${String(exhaustive)}`)
				}
			}
		}),
	}
}

async function scanOnePackage(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
}): Promise<{
	status: InventoryItemStatus
	result: InventoryItemResult | null
	error?: string
}> {
	try {
		const loaded = await loadPackageSourceBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.savedPackage.userId,
			sourceId: input.savedPackage.sourceId,
		})
		if (loaded.source.published_commit == null) {
			return { status: 'unpublished', result: null }
		}
		return {
			status: 'scanned',
			result: await attributePackageCredentials({
				db: input.env.APP_DB,
				savedPackage: input.savedPackage,
				files: loaded.files,
				slots: loaded.manifest.kody?.credentials,
			}),
		}
	} catch (error) {
		return {
			status: 'failed',
			result: null,
			error: (error instanceof Error ? error.message : String(error)).slice(
				0,
				300,
			),
		}
	}
}

/**
 * Scans one page of saved packages into a run. Without `runId` it starts a
 * new run; with it, it continues from where the run's last page stopped.
 */
export async function runCredentialInventoryScanStep(input: {
	env: Env
	baseUrl: string
	initiatedByUserId: string
	runId?: string
	limit?: number
}) {
	const db = input.env.APP_DB
	const limit = Math.min(
		Math.max(1, input.limit ?? credentialInventoryScanLimitDefault),
		credentialInventoryScanLimitMax,
	)
	const now = new Date().toISOString()
	let run: InventoryRunRow
	if (input.runId) {
		run = await getRun(db, input.runId)
	} else {
		run = { id: crypto.randomUUID(), status: 'scanning', cursor: null }
		await db
			.prepare(
				`INSERT INTO credential_inventory_runs
					(id, initiated_by_user_id, status, cursor, created_at, updated_at)
				VALUES (?, ?, 'scanning', NULL, ?, ?)`,
			)
			.bind(run.id, input.initiatedByUserId, now, now)
			.run()
	}
	const statuses: Record<InventoryItemStatus, number> = {
		scanned: 0,
		unpublished: 0,
		failed: 0,
	}
	if (run.status === 'complete') {
		return { runId: run.id, complete: true, page: statuses }
	}
	const packages = await listSavedPackagesPage(db, {
		afterId: run.cursor,
		limit,
	})
	const statements: Array<D1PreparedStatement> = []
	for (const savedPackage of packages) {
		const item = await scanOnePackage({
			env: input.env,
			baseUrl: input.baseUrl,
			savedPackage,
		})
		statuses[item.status] += 1
		statements.push(
			db
				.prepare(
					`INSERT OR REPLACE INTO credential_inventory_items
						(run_id, package_id, user_id, status, result_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					run.id,
					savedPackage.id,
					savedPackage.userId,
					item.status,
					JSON.stringify(
						item.status === 'failed'
							? { error: item.error }
							: (item.result ?? {}),
					),
					now,
				),
		)
	}
	const complete = packages.length < limit
	statements.push(
		db
			.prepare(
				`UPDATE credential_inventory_runs
				SET status = ?, cursor = ?, updated_at = ?
				WHERE id = ?`,
			)
			.bind(
				complete ? 'complete' : 'scanning',
				packages.at(-1)?.id ?? run.cursor,
				now,
				run.id,
			),
	)
	await db.batch(statements)
	return { runId: run.id, complete, page: statuses }
}

type StoredItem = {
	packageId: string
	status: InventoryItemStatus
	result: InventoryItemResult | null
	/** Why a `failed` package could not be scanned. */
	error?: string
}

async function loadRunItems(db: D1Database, runId: string) {
	const rows = await db
		.prepare(
			`SELECT package_id, status, result_json FROM credential_inventory_items
			WHERE run_id = ? ORDER BY package_id`,
		)
		.bind(runId)
		.all<{
			package_id: string
			status: InventoryItemStatus
			result_json: string
		}>()
	return (rows.results ?? []).map((row): StoredItem => {
		const stored = JSON.parse(row.result_json) as unknown
		return {
			packageId: row.package_id,
			status: row.status,
			result: row.status === 'scanned' ? (stored as InventoryItemResult) : null,
			...(row.status === 'failed'
				? { error: (stored as { error?: string }).error ?? 'unknown error' }
				: {}),
		}
	})
}

function emptyPlacementCounts() {
	return Object.fromEntries(
		credentialPlacementTypes.map((type) => [type, 0]),
	) as Record<CredentialPlacementType, number>
}

function emptyOtherContextCounts() {
	return Object.fromEntries(
		credentialOtherContexts.map((context) => [context, 0]),
	) as Record<CredentialOtherContext, number>
}

function createTally() {
	const counts = new Map<string, number>()
	return {
		add(name: string | null | undefined) {
			if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
		},
		top(): Array<InventoryTally> {
			return [...counts]
				.map(([name, count]) => ({ name, count }))
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
				.slice(0, credentialInventoryTallyMax)
		},
	}
}

export function summarizeCredentialInventory(
	items: ReadonlyArray<StoredItem>,
): CredentialInventoryReport {
	const report: CredentialInventoryReport = {
		packages: {
			scanned: 0,
			unpublished: 0,
			failed: 0,
			withPlaceholders: 0,
			withSlots: 0,
		},
		placeholders: emptyPlaceholderCounts(),
		unparsedModules: 0,
		references: {
			total: 0,
			attributed: 0,
			unattributed: 0,
			byPlacement: emptyPlacementCounts(),
			unattributedByPlacement: emptyPlacementCounts(),
			otherByContext: emptyOtherContextCounts(),
			bodyByEndpoint: { login: 0, other: 0, unknown: 0 },
			bodyFields: [],
			sdkOptions: [],
			argumentCallees: [],
		},
		vault: { byPlacement: emptyPlacementCounts() },
		signing: { placeholderKeys: 0, jwtSignCalls: 0, packagesWithSigning: 0 },
		slots: { total: 0, attributed: 0, byKind: { secret: 0, oauth: 0, mcp: 0 } },
		credentialsReferenced: 0,
		failures: [],
	}
	const referenced = new Set<string>()
	const bodyFields = createTally()
	const sdkOptions = createTally()
	const argumentCallees = createTally()
	for (const item of items) {
		report.packages[item.status] += 1
		if (
			item.status === 'failed' &&
			report.failures.length < credentialInventoryFailureListMax
		) {
			report.failures.push({
				packageId: item.packageId,
				error: item.error ?? 'unknown error',
			})
		}
		const result = item.result
		if (!result) continue
		const placeholderTotal = Object.values(result.placeholders).reduce(
			(sum, count) => sum + count,
			0,
		)
		if (placeholderTotal > 0) report.packages.withPlaceholders += 1
		if (result.slots.length > 0) report.packages.withSlots += 1
		for (const [kind, count] of Object.entries(result.placeholders)) {
			report.placeholders[kind as PlaceholderMatchKind] += count
		}
		report.unparsedModules += result.unparsedModules
		let signs = (result.jwtSignCalls ?? 0) > 0
		report.signing.jwtSignCalls += result.jwtSignCalls ?? 0
		for (const reference of result.references) {
			const { placement } = reference
			report.references.total += 1
			report.references.byPlacement[placement.type] += 1
			if (reference.credentialIds.length > 0) {
				report.references.attributed += 1
			} else {
				report.references.unattributed += 1
				report.references.unattributedByPlacement[placement.type] += 1
			}
			for (const id of reference.credentialIds) referenced.add(id)
			switch (placement.type) {
				case 'body':
					// Items scanned before body detail have neither field.
					report.references.bodyByEndpoint[placement.endpoint ?? 'unknown'] += 1
					bodyFields.add(placement.field)
					break
				case 'other': {
					const context = placement.context ?? 'other'
					report.references.otherByContext[context] += 1
					if (context === 'sdk-option') {
						sdkOptions.add(`${placement.callee ?? '?'}.${placement.key ?? '?'}`)
					}
					if (context === 'argument') argumentCallees.add(placement.callee)
					break
				}
				case 'signing':
					report.signing.placeholderKeys += 1
					signs = true
					break
				case 'header':
				case 'query':
				case 'header-custom':
				case 'basic':
				case 'path':
				case 'url':
				case 'binding':
					break
				default: {
					const exhaustive: never = placement
					throw new Error(`Unknown placement: ${JSON.stringify(exhaustive)}`)
				}
			}
		}
		for (const placement of result.vaultPlacements ?? []) {
			report.vault.byPlacement[placement.type] += 1
		}
		if (signs) report.signing.packagesWithSigning += 1
		for (const slot of result.slots) {
			report.slots.total += 1
			report.slots.byKind[slot.kind] += 1
			if (slot.credentialIds.length > 0) report.slots.attributed += 1
		}
	}
	report.credentialsReferenced = referenced.size
	report.references.bodyFields = bodyFields.top()
	report.references.sdkOptions = sdkOptions.top()
	report.references.argumentCallees = argumentCallees.top()
	return report
}

export async function getCredentialInventoryReport(
	db: D1Database,
	runId: string,
) {
	const run = await getRun(db, runId)
	return {
		runId: run.id,
		complete: run.status === 'complete',
		report: summarizeCredentialInventory(await loadRunItems(db, runId)),
	}
}

type CredentialUsage = {
	table: InventoryCredentialTable
	providers: Set<string>
	placements: Set<string>
}

/** Only header and query detail decides an inject; other detail is noise. */
function placementKey(placement: CredentialPlacement) {
	switch (placement.type) {
		case 'header':
		case 'query':
			return JSON.stringify(placement)
		default:
			return JSON.stringify({ type: placement.type })
	}
}

function collectUsage(items: ReadonlyArray<StoredItem>) {
	const usage = new Map<string, CredentialUsage>()
	const entry = (id: string, table: InventoryCredentialTable) => {
		let found = usage.get(id)
		if (!found) {
			found = { table, providers: new Set(), placements: new Set() }
			usage.set(id, found)
		}
		return found
	}
	for (const item of items) {
		if (!item.result) continue
		for (const reference of item.result.references) {
			for (const id of reference.credentialIds) {
				const usage = entry(id, reference.table)
				// Each read of a binding carries the placement the value lands in.
				if (reference.placement.type === 'binding') continue
				usage.placements.add(placementKey(reference.placement))
			}
		}
		for (const slot of item.result.slots) {
			const table = slot.kind === 'oauth' ? 'integration' : 'secret'
			for (const id of slot.credentialIds) {
				entry(id, table).providers.add(slot.provider)
			}
		}
	}
	return usage
}

export type InjectDecision =
	| { outcome: 'set'; inject: CredentialInject }
	| { outcome: 'default' | 'mixed' | 'unsupported' | 'unused' }

export function decideInject(placements: ReadonlySet<string>): InjectDecision {
	if (placements.size === 0) return { outcome: 'unused' }
	if (placements.size > 1) return { outcome: 'mixed' }
	const placement = JSON.parse([...placements][0]!) as CredentialPlacement
	switch (placement.type) {
		case 'header': {
			if (
				placement.name === defaultCredentialInject.name.toLowerCase() &&
				placement.format === defaultCredentialInject.format
			) {
				return { outcome: 'default' }
			}
			return {
				outcome: 'set',
				inject: {
					kind: 'header',
					name: placement.name,
					format: placement.format,
				},
			}
		}
		case 'query':
			return {
				outcome: 'set',
				inject: { kind: 'query', param: placement.param },
			}
		case 'header-custom':
		case 'basic':
		case 'path':
		case 'url':
		case 'body':
		case 'signing':
		case 'binding':
		case 'other':
			return { outcome: 'unsupported' }
		default: {
			const exhaustive: never = placement
			throw new Error(`Unknown placement: ${JSON.stringify(exhaustive)}`)
		}
	}
}

export type ProviderDecision =
	| { outcome: 'set'; provider: string }
	| { outcome: 'none' | 'conflicting' | 'invalid' }

export function decideProvider(
	providers: ReadonlySet<string>,
): ProviderDecision {
	if (providers.size === 0) return { outcome: 'none' }
	if (providers.size > 1) return { outcome: 'conflicting' }
	const provider = [...providers][0]!
	return providerSlugPattern.test(provider)
		? { outcome: 'set', provider }
		: { outcome: 'invalid' }
}

const credentialTables: Record<InventoryCredentialTable, string> = {
	secret: 'secret_entries',
	integration: 'user_integrations',
}

type CredentialRowState = { provider: string | null; injectIsDefault: boolean }

async function loadRowStates(
	db: D1Database,
	table: InventoryCredentialTable,
	ids: ReadonlyArray<string>,
) {
	const states = new Map<string, CredentialRowState>()
	for (const batch of chunk(ids)) {
		const result = await db
			.prepare(
				`SELECT id, provider, json(inject_json) = json(?) AS inject_is_default
				FROM ${credentialTables[table]}
				WHERE deleted_at IS NULL AND id IN (${placeholders(batch.length)})`,
			)
			.bind(JSON.stringify(defaultCredentialInject), ...batch)
			.all<{
				id: string
				provider: string | null
				inject_is_default: number
			}>()
		for (const row of result.results ?? []) {
			states.set(row.id, {
				provider: row.provider,
				injectIsDefault: row.inject_is_default === 1,
			})
		}
	}
	return states
}

export type CredentialBackfillCounts = {
	/** Packages the run could not scan; an apply refuses while any remain. */
	failedPackages: number
	credentials: number
	missingRows: number
	provider: {
		write: number
		alreadySet: number
		none: number
		conflicting: number
		invalid: number
	}
	inject: {
		write: number
		header: number
		query: number
		alreadySet: number
		default: number
		mixed: number
		unsupported: number
		unused: number
	}
}

/**
 * Fills `provider` and `inject_json` from a complete inventory run. With
 * `dryRun` it only counts. A package the run failed to scan may use any
 * credential in a way the run never saw, so an apply refuses a run with
 * failed packages unless `acknowledgedFailedPackageIds` names exactly those
 * packages. Each write re-checks that the column is still unset, so a value
 * set by anyone since the scan is never overwritten.
 */
export async function runCredentialBackfill(input: {
	env: Env
	runId: string
	dryRun: boolean
	acknowledgedFailedPackageIds?: ReadonlyArray<string>
}) {
	const db = input.env.APP_DB
	const run = await getRun(db, input.runId)
	if (run.status !== 'complete') {
		throw new Error(
			`Credential inventory run ${run.id} is still scanning; finish the scan before the backfill.`,
		)
	}
	const items = await loadRunItems(db, run.id)
	const failedIds = new Set(
		items
			.filter((item) => item.status === 'failed')
			.map((item) => item.packageId),
	)
	const failedPackages = failedIds.size
	const acknowledged = new Set(input.acknowledgedFailedPackageIds ?? [])
	const acknowledgesExactly =
		acknowledged.size === failedIds.size &&
		[...failedIds].every((id) => acknowledged.has(id))
	if (!input.dryRun && failedPackages > 0 && !acknowledgesExactly) {
		throw new Error(
			`Credential inventory run ${run.id} failed to scan ${failedPackages} package(s); fix them and scan again, or pass their ids in acknowledgedFailedPackageIds, before applying the backfill.`,
		)
	}
	const usage = collectUsage(items)
	const counts: CredentialBackfillCounts = {
		failedPackages,
		credentials: usage.size,
		missingRows: 0,
		provider: { write: 0, alreadySet: 0, none: 0, conflicting: 0, invalid: 0 },
		inject: {
			write: 0,
			header: 0,
			query: 0,
			alreadySet: 0,
			default: 0,
			mixed: 0,
			unsupported: 0,
			unused: 0,
		},
	}
	const statements: Array<D1PreparedStatement> = []
	for (const table of ['secret', 'integration'] as const) {
		const ids = [...usage]
			.filter(([, entry]) => entry.table === table)
			.map(([id]) => id)
		const states = await loadRowStates(db, table, ids)
		for (const id of ids) {
			const state = states.get(id)
			if (!state) {
				counts.missingRows += 1
				continue
			}
			const entry = usage.get(id)!
			const provider = decideProvider(entry.providers)
			if (provider.outcome === 'set') {
				if (state.provider != null) {
					counts.provider.alreadySet += 1
				} else {
					counts.provider.write += 1
					statements.push(
						db
							.prepare(
								`UPDATE ${credentialTables[table]} SET provider = ?
								WHERE id = ? AND provider IS NULL`,
							)
							.bind(provider.provider, id),
					)
				}
			} else {
				counts.provider[provider.outcome] += 1
			}
			const inject = decideInject(entry.placements)
			if (inject.outcome === 'set') {
				if (!state.injectIsDefault) {
					counts.inject.alreadySet += 1
				} else {
					counts.inject.write += 1
					counts.inject[inject.inject.kind] += 1
					statements.push(
						db
							.prepare(
								`UPDATE ${credentialTables[table]} SET inject_json = ?
								WHERE id = ? AND json(inject_json) = json(?)`,
							)
							.bind(
								JSON.stringify(inject.inject),
								id,
								JSON.stringify(defaultCredentialInject),
							),
					)
				}
			} else {
				counts.inject[inject.outcome] += 1
			}
		}
	}
	let writtenRows = 0
	if (!input.dryRun) {
		for (const batch of chunk(statements)) {
			const results = await db.batch(batch)
			for (const result of results) writtenRows += result.meta?.changes ?? 0
		}
		const now = new Date().toISOString()
		await db
			.prepare(
				`UPDATE credential_inventory_runs SET backfilled_at = ?, updated_at = ?
				WHERE id = ?`,
			)
			.bind(now, now, run.id)
			.run()
	}
	return { runId: run.id, dryRun: input.dryRun, counts, writtenRows }
}
