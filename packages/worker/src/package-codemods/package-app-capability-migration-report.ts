import {
	declarePackageAppCapabilitiesCodemodId,
	isDeclarePackageAppCapabilitiesOwnerDetail,
	type DeclarePackageAppCapabilitiesUnresolved,
} from './codemods/0018-declare-package-app-capabilities.ts'
import { getPackageCodemodRunById } from './ledger.ts'

export type PackageAppCapabilityMigrationReport = {
	runId: string
	codemodId: string
	mode: string
	status: string
	items: { total: number; byStatus: Record<string, number> }
	appsAffected: number
	ownersAffected: number
	capabilitiesAdded: { total: number; byCapability: Record<string, number> }
	unresolvedApps: {
		count: number
		apps: Array<{ packageId: string } & DeclarePackageAppCapabilitiesUnresolved>
	}
	/** Only with `packageId`: that one app's private list, for its owner. */
	app: { packageId: string; addedCapabilities: Array<string> } | null
}

/**
 * Counts for a `0018-declare-package-app-capabilities` run, built from the
 * owner-private run item detail. Totals carry platform capability names
 * only; nothing here names an owner or a package beyond its id.
 */
export async function buildPackageAppCapabilityMigrationReport(input: {
	db: D1Database
	runId: string
	packageId?: string
}): Promise<PackageAppCapabilityMigrationReport | null> {
	const run = await getPackageCodemodRunById(input.db, input.runId)
	if (
		!run ||
		run.codemodId !== declarePackageAppCapabilitiesCodemodId ||
		(run.mode !== 'dry-run' && run.mode !== 'apply')
	) {
		return null
	}
	const rows = await input.db
		.prepare(
			`SELECT user_id, package_id, status, owner_detail_json
			FROM package_codemod_run_items WHERE run_id = ?
			ORDER BY created_at, id`,
		)
		.bind(input.runId)
		.all<{
			user_id: string
			package_id: string
			status: string
			owner_detail_json: string | null
		}>()
	const byStatus: Record<string, number> = {}
	const owners = new Set<string>()
	const byCapability: Record<string, number> = {}
	const unresolvedApps: PackageAppCapabilityMigrationReport['unresolvedApps']['apps'] =
		[]
	let appsAffected = 0
	let total = 0
	let app: PackageAppCapabilityMigrationReport['app'] = null
	// A retried page can leave repeat rows for one package; the latest wins,
	// except that an applied row is kept over a later retry's row (which
	// sees the already-published change and comes back clean).
	const latestByPackage = new Map<string, (typeof rows.results)[number]>()
	for (const row of rows.results ?? []) {
		const packageId = String(row.package_id)
		const previous = latestByPackage.get(packageId)
		if (previous?.status === 'applied' && row.status !== 'applied') continue
		latestByPackage.set(packageId, row)
	}
	const items = [...latestByPackage.values()]
	for (const row of items) {
		const status = String(row.status)
		byStatus[status] = (byStatus[status] ?? 0) + 1
		let detail: unknown = null
		try {
			detail = row.owner_detail_json ? JSON.parse(row.owner_detail_json) : null
		} catch {
			detail = null
		}
		if (!isDeclarePackageAppCapabilitiesOwnerDetail(detail)) continue
		const packageId = String(row.package_id)
		const added = detail.addedCapabilities.filter(
			(name): name is string => typeof name === 'string',
		)
		if (input.packageId === packageId) {
			app = { packageId, addedCapabilities: added }
		}
		if (added.length > 0) {
			appsAffected += 1
			owners.add(String(row.user_id))
			total += added.length
			for (const name of added)
				byCapability[name] = (byCapability[name] ?? 0) + 1
		}
		const unresolved = detail.unresolved
		if (Object.values(unresolved).some((count) => Number(count) > 0)) {
			unresolvedApps.push({
				packageId,
				computedCalls: Number(unresolved.computedCalls) || 0,
				mcpCalls: Number(unresolved.mcpCalls) || 0,
				unresolvedImports: Number(unresolved.unresolvedImports) || 0,
				unknownCapabilityNames: Number(unresolved.unknownCapabilityNames) || 0,
				credentialNamedCalls: Number(unresolved.credentialNamedCalls) || 0,
			})
		}
	}
	unresolvedApps.sort((a, b) => a.packageId.localeCompare(b.packageId))
	return {
		runId: run.id,
		codemodId: run.codemodId,
		mode: run.mode,
		status: run.status,
		items: { total: items.length, byStatus },
		appsAffected,
		ownersAffected: owners.size,
		capabilitiesAdded: {
			total,
			byCapability: Object.fromEntries(
				Object.entries(byCapability).sort(([a], [b]) => a.localeCompare(b)),
			),
		},
		unresolvedApps: { count: unresolvedApps.length, apps: unresolvedApps },
		app,
	}
}
