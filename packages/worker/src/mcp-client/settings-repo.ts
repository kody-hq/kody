import {
	parseAllowedPackages,
	stringifyAllowedPackages,
} from '#mcp/secrets/allowed-packages.ts'
import type {
	McpServerLogoSource,
	McpServerSettingRow,
} from './settings-types.ts'
import {
	normalizeMcpServerUsageMode,
	type McpServerUsageMode,
} from './usage-mode.ts'

import { credentialGrantCleanupStatements } from '#worker/credentials/credential-grant-cleanup.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
const selectColumns =
	'id, user_id, name, url, enabled, created_at, updated_at, logo_key, logo_content_type, logo_source, favicon_source_host, usage_mode, allowed_packages_json, last_error'

export async function listMcpServerSettingRows(input: {
	db: D1Database
	userId: string
}): Promise<Array<McpServerSettingRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT ${selectColumns}
			FROM mcp_server_settings
			WHERE user_id = ?${andLiveDeletedAtSql()}
			ORDER BY name ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapMcpServerSettingRow)
}

export async function listEnabledMcpServerSettingRows(input: {
	db: D1Database
	userId: string
}): Promise<Array<McpServerSettingRow>> {
	const { results } = await input.db
		.prepare(
			`SELECT ${selectColumns}
			FROM mcp_server_settings
			WHERE user_id = ? AND enabled = 1${andLiveDeletedAtSql()}
			ORDER BY name ASC`,
		)
		.bind(input.userId)
		.all<Record<string, unknown>>()
	return (results ?? []).map(mapMcpServerSettingRow)
}

export async function getMcpServerSettingRowById(input: {
	db: D1Database
	userId: string
	id: string
}): Promise<McpServerSettingRow | null> {
	const row = await input.db
		.prepare(
			`SELECT ${selectColumns}
			FROM mcp_server_settings
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}
			LIMIT 1`,
		)
		.bind(input.userId, input.id)
		.first<Record<string, unknown>>()
	return row ? mapMcpServerSettingRow(row) : null
}

/**
 * The org that owns a live MCP server, by its globally unique id. Callers
 * still authorize the person in that org before acting on it.
 */
export async function getMcpServerOwnerId(input: {
	db: D1Database
	id: string
}): Promise<string | null> {
	const row = await input.db
		.prepare(
			`SELECT user_id FROM mcp_server_settings
			WHERE id = ?${andLiveDeletedAtSql()}
			LIMIT 1`,
		)
		.bind(input.id)
		.first<{ user_id: string }>()
	return row?.user_id ?? null
}

export async function getMcpServerSettingRowByName(input: {
	db: D1Database
	userId: string
	name: string
}): Promise<McpServerSettingRow | null> {
	const row = await input.db
		.prepare(
			`SELECT ${selectColumns}
			FROM mcp_server_settings
			WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()}
			LIMIT 1`,
		)
		.bind(input.userId, input.name)
		.first<Record<string, unknown>>()
	return row ? mapMcpServerSettingRow(row) : null
}

export async function insertMcpServerSettingRow(input: {
	db: D1Database
	row: Omit<McpServerSettingRow, 'created_at' | 'updated_at'> & {
		created_at?: string
		updated_at?: string
	}
}): Promise<void> {
	const now = new Date().toISOString()
	await input.db
		.prepare(
			`INSERT INTO mcp_server_settings (
				id, user_id, name, url, enabled, created_at, updated_at,
				usage_mode, allowed_packages_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.row.id,
			input.row.user_id,
			input.row.name,
			input.row.url,
			input.row.enabled ? 1 : 0,
			input.row.created_at ?? now,
			input.row.updated_at ?? now,
			input.row.usage_mode,
			stringifyAllowedPackages(input.row.allowedPackageIds),
		)
		.run()
}

export async function updateMcpServerSettingRow(input: {
	db: D1Database
	row: Omit<McpServerSettingRow, 'created_at' | 'updated_at'> & {
		updated_at?: string
	}
}): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE mcp_server_settings
			SET name = ?,
				url = ?,
				enabled = ?,
				updated_at = ?
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.row.name,
			input.row.url,
			input.row.enabled ? 1 : 0,
			input.row.updated_at ?? now,
			input.row.user_id,
			input.row.id,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function updateMcpServerSettingUsageRow(input: {
	db: D1Database
	userId: string
	id: string
	usageMode: McpServerUsageMode
	allowedPackageIds: Array<string>
	updatedAt?: string
}): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE mcp_server_settings
			SET usage_mode = ?,
				allowed_packages_json = ?,
				updated_at = ?
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(
			input.usageMode,
			stringifyAllowedPackages(input.allowedPackageIds),
			input.updatedAt ?? now,
			input.userId,
			input.id,
		)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function updateMcpServerSettingLastErrorRow(input: {
	db: D1Database
	userId: string
	id: string
	lastError: string | null
	updatedAt?: string
}): Promise<boolean> {
	const now = new Date().toISOString()
	const result = await input.db
		.prepare(
			`UPDATE mcp_server_settings
			SET last_error = ?,
				updated_at = ?
			WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.lastError, input.updatedAt ?? now, input.userId, input.id)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function deleteMcpServerSettingRow(input: {
	db: D1Database
	userId: string
	id: string
}): Promise<boolean> {
	const liveRowSql = `FROM mcp_server_settings WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`
	const results = await input.db.batch([
		...credentialGrantCleanupStatements(input.db, {
			ownerId: input.userId,
			credentialIdSql: `SELECT id ${liveRowSql}`,
			credentialIdBindings: [input.userId, input.id],
		}),
		input.db.prepare(`DELETE ${liveRowSql}`).bind(input.userId, input.id),
	])
	return (results.at(-1)?.meta.changes ?? 0) > 0
}

function mapLogoSource(value: unknown): McpServerLogoSource | null {
	return value === 'favicon' ? 'favicon' : null
}

function mapMcpServerSettingRow(
	row: Record<string, unknown>,
): McpServerSettingRow {
	return {
		id: String(row['id']),
		user_id: String(row['user_id']),
		name: String(row['name']),
		url: String(row['url']),
		enabled: Boolean(Number(row['enabled'])),
		created_at: String(row['created_at']),
		updated_at: String(row['updated_at']),
		logo_key: row['logo_key'] == null ? null : String(row['logo_key']),
		logo_content_type:
			row['logo_content_type'] == null
				? null
				: String(row['logo_content_type']),
		logo_source: mapLogoSource(row['logo_source']),
		favicon_source_host:
			row['favicon_source_host'] == null
				? null
				: String(row['favicon_source_host']),
		usage_mode: normalizeMcpServerUsageMode(
			row['usage_mode'] == null ? null : String(row['usage_mode']),
		),
		allowedPackageIds: parseAllowedPackages(
			row['allowed_packages_json'] == null
				? null
				: String(row['allowed_packages_json']),
		),
		last_error: row['last_error'] == null ? null : String(row['last_error']),
	}
}
