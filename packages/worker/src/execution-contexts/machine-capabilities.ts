import { bumpAccessEpochStatement } from '#worker/authorization/access-compile.ts'

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

/** The kinds a machine defines in its local policy and reports to Kody. */
export const machineDefinedCapabilityKinds = ['command', 'lan'] as const

export type MachineDefinedCapability = {
	kind: (typeof machineDefinedCapabilityKinds)[number]
	name: string
	description: string
	/** What the machine advertises (argument shapes, hosts and ports). Never executable paths. */
	summary: Record<string, unknown>
}

const capabilityNamePattern = /^[a-z0-9][a-z0-9_-]{0,62}$/
const maxMachineDefinedCapabilities = 100
const maxDescriptionLength = 200
const maxSummaryJsonLength = 4096

/** Parses the full set a machine reports. Returns a message when it is not valid. */
export function parseMachineDefinedCapabilities(
	value: unknown,
): Array<MachineDefinedCapability> | string {
	if (!Array.isArray(value)) return '"capabilities" must be a list.'
	if (value.length > maxMachineDefinedCapabilities) {
		return `A machine can define at most ${maxMachineDefinedCapabilities} named commands and local network destinations.`
	}
	const seen = new Set<string>()
	const parsed: Array<MachineDefinedCapability> = []
	for (const entry of value) {
		const record =
			entry && typeof entry === 'object' && !Array.isArray(entry)
				? (entry as Record<string, unknown>)
				: {}
		const { kind, name, description = '', summary = {} } = record
		if (kind !== 'command' && kind !== 'lan') {
			return 'Each capability "kind" must be "command" or "lan".'
		}
		if (typeof name !== 'string' || !capabilityNamePattern.test(name)) {
			return `Capability name ${JSON.stringify(name)} must be lowercase letters, digits, "-" or "_" (at most 63 characters).`
		}
		if (
			typeof description !== 'string' ||
			description.length > maxDescriptionLength
		) {
			return `The description of ${kind} "${name}" must be text of at most ${maxDescriptionLength} characters.`
		}
		if (
			!summary ||
			typeof summary !== 'object' ||
			Array.isArray(summary) ||
			JSON.stringify(summary).length > maxSummaryJsonLength
		) {
			return `The summary of ${kind} "${name}" must be an object of at most ${maxSummaryJsonLength} characters as JSON.`
		}
		const key = `${kind}:${name}`
		if (seen.has(key)) return `${kind} "${name}" is listed twice.`
		seen.add(key)
		parsed.push({
			kind,
			name,
			description,
			summary: summary as Record<string, unknown>,
		})
	}
	return parsed
}

export async function listMachineDefinedCapabilities(
	db: D1Database,
	contextId: string,
) {
	const result = await db
		.prepare(
			`SELECT * FROM machine_capabilities
			 WHERE context_id = ? AND removed_at IS NULL AND kind IN ('command', 'lan')
			 ORDER BY kind, name`,
		)
		.bind(contextId)
		.all<MachineCapabilityRow>()
	return result.results
}

/**
 * Makes Kody's rows match what the machine defines now. A capability the
 * machine dropped is marked removed, and its grants and package list go with
 * it, so defining the same name again later starts with nobody allowed.
 */
export async function syncMachineDefinedCapabilities(
	db: D1Database,
	context: { id: string; org_id: string; operator_user_id: string },
	defined: ReadonlyArray<MachineDefinedCapability>,
) {
	const current = await listMachineDefinedCapabilities(db, context.id)
	const keyOf = (entry: { kind: string; name: string }) =>
		`${entry.kind}:${entry.name}`
	const currentByKey = new Map(current.map((row) => [keyOf(row), row]))
	const definedKeys = new Set(defined.map(keyOf))
	const added = defined.filter((entry) => !currentByKey.has(keyOf(entry)))
	const changed = defined.filter((entry) => {
		const row = currentByKey.get(keyOf(entry))
		return (
			row !== undefined &&
			(row.description !== entry.description ||
				row.summary_json !== JSON.stringify(entry.summary))
		)
	})
	const removed = current.filter((row) => !definedKeys.has(keyOf(row)))
	const names = (entries: ReadonlyArray<{ kind: string; name: string }>) =>
		entries.map(keyOf)
	const result = {
		added: names(added),
		changed: names(changed),
		removed: names(removed),
	}
	if (added.length + changed.length + removed.length === 0) return result

	const now = new Date().toISOString()
	const removedIds = removed.map((row) => row.id)
	const placeholders = removedIds.map(() => '?').join(', ')
	const grantOrgs =
		removedIds.length === 0
			? []
			: (
					await db
						.prepare(
							`SELECT DISTINCT org_id FROM grants
							 WHERE resource_type = 'machine_capability'
							   AND deleted_at IS NULL
							   AND resource_id IN (${placeholders})`,
						)
						.bind(...removedIds)
						.all<{ org_id: string }>()
				).results.map((row) => row.org_id)
	await db.batch([
		...[...added, ...changed].map((entry) =>
			db
				.prepare(
					`INSERT INTO machine_capabilities (
						id, context_id, org_id, operator_user_id, kind, name,
						description, summary_json, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (context_id, kind, name) DO UPDATE SET
						description = excluded.description,
						summary_json = excluded.summary_json,
						updated_at = excluded.updated_at,
						removed_at = NULL`,
				)
				.bind(
					`mcap_${crypto.randomUUID()}`,
					context.id,
					context.org_id,
					context.operator_user_id,
					entry.kind,
					entry.name,
					entry.description,
					JSON.stringify(entry.summary),
					now,
					now,
				),
		),
		...(removedIds.length === 0
			? []
			: [
					db
						.prepare(
							`UPDATE grants SET deleted_at = ?, updated_at = ?
							 WHERE resource_type = 'machine_capability'
							   AND deleted_at IS NULL
							   AND resource_id IN (${placeholders})`,
						)
						.bind(now, now, ...removedIds),
					...grantOrgs.map((orgId) => bumpAccessEpochStatement(db, orgId)),
					db
						.prepare(
							`UPDATE machine_capabilities
							 SET removed_at = ?, updated_at = ?, allowed_packages_json = '[]'
							 WHERE id IN (${placeholders})`,
						)
						.bind(now, now, ...removedIds),
				]),
	])
	return result
}
