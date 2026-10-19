import { formatScheduleSummary } from '@kody-internal/shared/jobs/schedule.ts'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'
import { requirePackageIdFromJobId } from '#worker/jobs/package-job-id.ts'
import { buildWebhookEndpointPathPrefix } from '#worker/webhooks/public-url.ts'
import { type OrgTransferFinding } from './findings.ts'
import { type OrgTransferPlan, transferredPackageName } from './plan.ts'
import { type OrgTransferRow } from './snapshot.ts'

const text = (row: OrgTransferRow, column: string) => String(row[column] ?? '')

export const orgTransferMemoriesStayNote =
	'Memories are personal and stay with their owner; they are not moved.' as const

/**
 * What a transfer moves, as counts and names. Built from plan rows by naming
 * columns explicitly, so ciphertext and other row values never reach output.
 */
export type OrgTransferSummary = {
	from: { id: string; slug: string }
	to: { id: string; slug: string }
	counts: Record<string, number>
	packages: Array<{ id: string; from_name: string; to_name: string }>
	repos: Array<string>
	secrets: Array<{ scope: string; binding: string; name: string }>
	integrations: Array<string>
	oauth_apps: Array<string>
	mcp_servers: Array<{ id: string; name: string }>
	/**
	 * Public webhook URLs embed the owner slug, so every moved endpoint gets a
	 * new URL: the old one with `old_path_prefix` swapped for
	 * `new_path_prefix`. The URL secret segment is never included.
	 */
	webhooks: Array<{
		package: string
		name: string
		url_changed: true
		old_path_prefix: string
		new_path_prefix: string
		manage_path: string
	}>
	enablements: Array<{
		package: string
		trigger_kind: string
		trigger_name: string
		state: string
		enabler_user_id: string
		enabler_is_target_member: boolean
	}>
	jobs: Array<{ id: string; name: string; package: string; schedule: string }>
	storages: Array<{ storage_id: string; kind: string }>
	orphans: Array<{ table: string; key: string; reason: string }>
	clashes: Array<OrgTransferFinding>
	blockers: Array<OrgTransferFinding>
	warnings: Array<OrgTransferFinding>
	/** Always present, including when the source owns no live memories. */
	kept: {
		memories: {
			count: number
			note: typeof orgTransferMemoriesStayNote
		}
	}
}

export function summarizeOrgTransferPlan(
	plan: OrgTransferPlan,
): OrgTransferSummary {
	const packageKodyIds = new Map(
		plan.moves.saved_packages.map((row) => [
			text(row, 'id'),
			text(row, 'kody_id'),
		]),
	)
	const packageLabel = (packageId: string) =>
		packageKodyIds.get(packageId) ?? packageId
	const bindingLabel = (scope: string, bindingKey: string) =>
		scope === 'user' ? '' : packageLabel(bindingKey)
	const entryNames = (entryTable: 'secret_entries') =>
		plan.moves[entryTable].map((row) => {
			const bucket = plan.bucketBindings.get(text(row, 'bucket_id'))
			const scope = bucket?.scope ?? ''
			return {
				scope,
				binding: bucket ? bindingLabel(scope, bucket.bindingKey) : '',
				name: text(row, 'name'),
			}
		})
	return {
		from: plan.from,
		to: plan.to,
		counts: Object.fromEntries(
			Object.entries(plan.moves)
				.map(([table, rows]) => [table, rows.length] as const)
				.filter(([, count]) => count > 0),
		),
		packages: plan.moves.saved_packages.map((row) => ({
			id: text(row, 'id'),
			from_name: text(row, 'name'),
			to_name: transferredPackageName(row, plan.to.slug),
		})),
		repos: plan.moves.user_repos.map((row) => text(row, 'name')),
		secrets: entryNames('secret_entries'),
		integrations: plan.moves.user_integrations.map((row) => text(row, 'name')),
		oauth_apps: plan.moves.user_oauth_apps.map((row) => text(row, 'slug')),
		mcp_servers: plan.moves.mcp_server_settings.map((row) => ({
			id: text(row, 'id'),
			name: text(row, 'name'),
		})),
		webhooks: plan.moves.webhook_endpoints.map((row) => {
			const packageKodyId = packageLabel(text(row, 'package_id'))
			const webhookName = text(row, 'webhook_name')
			return {
				package: packageKodyId,
				name: webhookName,
				url_changed: true as const,
				old_path_prefix: buildWebhookEndpointPathPrefix({
					username: plan.from.slug,
					packageKodyId,
					webhookName,
				}),
				new_path_prefix: buildWebhookEndpointPathPrefix({
					username: plan.to.slug,
					packageKodyId,
					webhookName,
				}),
				manage_path: orgSectionRestPath(plan.to.slug, 'webhooks'),
			}
		}),
		enablements: plan.moves.enablements.map((row) => ({
			package: packageLabel(text(row, 'package_id')),
			trigger_kind: text(row, 'trigger_kind'),
			trigger_name: text(row, 'trigger_name'),
			state: text(row, 'state'),
			enabler_user_id: text(row, 'enabler_user_id'),
			enabler_is_target_member: plan.targetMemberIds.has(
				text(row, 'enabler_user_id'),
			),
		})),
		jobs: plan.jobs.map((job) => ({
			id: job.id,
			name: job.record.name,
			package: packageLabel(requirePackageIdFromJobId(job.id)),
			schedule: formatScheduleSummary({
				schedule: job.record.schedule,
				timezone: job.record.timezone,
			}),
		})),
		storages: plan.storageCopies.map((copy) => ({
			storage_id: copy.storageId,
			kind: copy.kind,
		})),
		orphans: plan.orphans.map((orphan) => ({
			table: orphan.table,
			key: orphan.key,
			reason: orphan.reason,
		})),
		clashes: plan.clashes,
		blockers: plan.blockers,
		warnings: plan.warnings,
		kept: {
			memories: {
				count: plan.kept.memories.count,
				note: orgTransferMemoriesStayNote,
			},
		},
	}
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).toSorted().join(',')}]`
	}
	if (value && typeof value === 'object') {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

/**
 * SHA-256 (hex) of the summary with keys and list entries sorted, so the
 * same plan always hashes the same regardless of row read order.
 */
export async function fingerprintOrgTransferSummary(
	summary: OrgTransferSummary,
) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonicalJson(summary)),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}
