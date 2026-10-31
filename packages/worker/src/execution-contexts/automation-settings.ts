/**
 * Effective execution setting for one automation: the override set from the
 * API, CLI or UI, else the `execution` its package manifest declares.
 */
import {
	type AutomationExecution,
	parseAutomationExecution,
} from './automation-execution-schema.ts'
import { type AutomationRouting } from './automation-execution.ts'

export const automationExecutionKinds = [
	'job',
	'webhook',
	'subscription',
] as const
export type AutomationExecutionKind = (typeof automationExecutionKinds)[number]

/** Which declared automation a package run is, to look up its setting. */
export type AutomationExecutionTarget =
	| { kind: 'job'; name: string; jobId: string }
	| { kind: 'webhook' | 'subscription'; name: string }
	/** Package workflows carry their setting from `workflows.create`. */
	| { kind: 'workflow'; exportName: string; execution: AutomationExecution }

export type AutomationExecutionOverride = {
	execution: AutomationExecution
	updatedAt: string
	updatedByUserId: string
}

/** Webhooks and subscriptions are keyed by package id and their name. */
export function automationTargetId(input: {
	kind: AutomationExecutionKind
	jobId?: string
	packageId?: string
	name?: string
}) {
	if (input.kind === 'job') return input.jobId ?? ''
	return `${input.packageId ?? ''}:${input.name ?? ''}`
}

export async function getAutomationExecutionOverride(
	db: D1Database,
	input: { orgId: string; kind: AutomationExecutionKind; targetId: string },
): Promise<AutomationExecutionOverride | null> {
	const row = await db
		.prepare(
			`SELECT execution_json, updated_at, updated_by_user_id
			 FROM automation_execution_settings
			 WHERE org_id = ? AND kind = ? AND target_id = ?`,
		)
		.bind(input.orgId, input.kind, input.targetId)
		.first<{
			execution_json: string
			updated_at: string
			updated_by_user_id: string
		}>()
	const execution = row ? parseAutomationExecution(row.execution_json) : null
	if (!row || !execution) return null
	return {
		execution,
		updatedAt: row.updated_at,
		updatedByUserId: row.updated_by_user_id,
	}
}

export async function setAutomationExecutionOverride(
	db: D1Database,
	input: {
		orgId: string
		kind: AutomationExecutionKind
		targetId: string
		execution: AutomationExecution | null
		userId: string
	},
) {
	if (!input.execution) {
		await db
			.prepare(
				`DELETE FROM automation_execution_settings
				 WHERE org_id = ? AND kind = ? AND target_id = ?`,
			)
			.bind(input.orgId, input.kind, input.targetId)
			.run()
		return
	}
	await db
		.prepare(
			`INSERT INTO automation_execution_settings
			   (org_id, kind, target_id, execution_json, updated_at, updated_by_user_id)
			 VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT (org_id, kind, target_id) DO UPDATE SET
			   execution_json = excluded.execution_json,
			   updated_at = excluded.updated_at,
			   updated_by_user_id = excluded.updated_by_user_id`,
		)
		.bind(
			input.orgId,
			input.kind,
			input.targetId,
			JSON.stringify(input.execution),
			new Date().toISOString(),
			input.userId,
		)
		.run()
}

/** `kody:@scope/pkg/<export>`; the root export is the bare package. */
/** Module a context runs for a package-export automation: call the export with the run's params. */
export function buildExecuteInvokePassthroughSource(specifier: string): string {
	return `import action from ${JSON.stringify(specifier)}

export default async function main(params) {
	return await action(params)
}`
}

export function packageExportSpecifier(packageName: string, exportKey: string) {
	const key = exportKey.replace(/^\.\/?/, '')
	return `kody:${packageName}${key ? `/${key}` : ''}`
}

type ManifestExports = Record<string, unknown>

/**
 * The export whose runtime target is `path`. A context runs package code by
 * importing it, so a job or subscription handler on a context must also be
 * an export.
 */
export function exportKeyForPath(exports: ManifestExports, path: string) {
	const wanted = normalizePath(path)
	for (const [key, target] of Object.entries(exports)) {
		const runtime =
			typeof target === 'string'
				? target
				: target && typeof target === 'object'
					? ((target as { import?: unknown; default?: unknown }).import ??
						(target as { default?: unknown }).default)
					: null
		if (typeof runtime === 'string' && normalizePath(runtime) === wanted) {
			return key
		}
	}
	return null
}

function normalizePath(path: string) {
	return path.trim().replace(/^\.\//, '')
}

/**
 * Routing for one automation run, or null to run on Kody cloud. A setting
 * whose code cannot be imported still routes, so the run fails with a clear
 * reason instead of silently running on Kody cloud.
 */
export async function resolveAutomationRouting(input: {
	db: D1Database
	orgId: string
	kind: AutomationExecutionKind
	targetId: string
	declared: unknown
	packageName: string | null
	exportKey: string | null
}): Promise<AutomationRouting | null> {
	const override = await getAutomationExecutionOverride(input.db, input)
	const setting =
		override?.execution ?? parseAutomationExecution(input.declared)
	if (!setting) return null
	// An explicit cloud override runs on Kody cloud exactly as before.
	if (setting.context === 'cloud' && !setting.requires?.length) return null
	return {
		setting,
		contextCode:
			input.packageName && input.exportKey !== null
				? buildExecuteInvokePassthroughSource(
						packageExportSpecifier(input.packageName, input.exportKey),
					)
				: null,
	}
}
