/**
 * Machine access: one power a machine offers (the shell, a named command, a
 * set of local network destinations, a host folder) as a named capability on
 * its execution context. The machine defines it; Kody stores who may use it
 * (`grants` rows with resource_type `machine_capability`) and from which
 * packages (`allowed_packages_json`).
 */
export const machineCapabilityKinds = ['shell', 'command', 'lan', 'fs'] as const

export type MachineCapabilityKind = (typeof machineCapabilityKinds)[number]

export type MachineCapabilityRow = {
	id: string
	context_id: string
	org_id: string
	operator_user_id: string
	kind: MachineCapabilityKind
	name: string
	description: string
	summary_json: string
	allowed_packages_json: string
	created_at: string
	updated_at: string
	removed_at: string | null
}

export async function getMachineCapability(db: D1Database, id: string) {
	return await db
		.prepare(`SELECT * FROM machine_capabilities WHERE id = ?`)
		.bind(id)
		.first<MachineCapabilityRow>()
}

/** Orgs holding a live grant on one of a context's capabilities. */
export async function listMachineCapabilityGrantOrgIds(
	db: D1Database,
	contextId: string,
) {
	const result = await db
		.prepare(
			`SELECT DISTINCT org_id FROM grants
			 WHERE resource_type = 'machine_capability'
			   AND deleted_at IS NULL
			   AND resource_id IN (
				SELECT id FROM machine_capabilities WHERE context_id = ?
			   )`,
		)
		.bind(contextId)
		.all<{ org_id: string }>()
	return result.results.map((row) => row.org_id)
}
