import { isPackageCredentialSuppliersEnabled } from '#worker/credentials/credential-suppliers-flag.ts'
import { loadPublishedCredentialNeeds } from '#worker/credentials/credential-needs-closure.ts'
import { loadCapabilityApprovalSummary } from '#worker/package-capabilities/capability-approval-service.ts'
import type { CapabilitySetEntry } from '#worker/package-capabilities/capability-set.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { loadPackageSourceRowForUser } from '#worker/package-registry/source.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { loadPublishedEntityManifest } from '#worker/repo/published-source.ts'
import type {
	AccountPackageAnonymousVisitorExposure,
	AccountPackageAnonymousVisitorExposureItem,
} from '#universal/loader-data.ts'

/**
 * What an anonymous visitor would use as the owner once the app is
 * internet-visible: the published capability set's credentials (each runs
 * as the publisher unless its need is executor-supplied, which anonymous
 * visitors cannot fill) and the `mcp:` connector tools in
 * `kody.app.capabilities`. Names and hosts only, never secret values.
 */
export async function loadAnonymousVisitorExposure(input: {
	env: Env
	requestUrl: string
	record: SavedPackageRecord
}): Promise<AccountPackageAnonymousVisitorExposure> {
	try {
		const [summary, executorNeedKeys, connectors] = await Promise.all([
			loadCapabilityApprovalSummary({
				env: input.env,
				ownerUserId: input.record.userId,
				savedPackage: input.record,
				requestUrl: input.requestUrl,
			}),
			loadExecutorNeedKeys(input),
			loadAppConnectorCapabilities(input),
		])
		return {
			known: true,
			items: [
				...ownerCredentialItems(
					summary.capabilitySet.entries,
					executorNeedKeys,
				),
				...connectors.map(
					(name): AccountPackageAnonymousVisitorExposureItem => ({
						kind: 'connector',
						name,
						detail: null,
					}),
				),
			],
		}
	} catch (error) {
		console.warn('package-anonymous-visitor-exposure-failed', error)
		return { known: false }
	}
}

export function ownerCredentialItems(
	entries: ReadonlyArray<CapabilitySetEntry>,
	executorNeedKeys: ReadonlySet<string>,
): Array<AccountPackageAnonymousVisitorExposureItem> {
	const items = new Map<string, AccountPackageAnonymousVisitorExposureItem>()
	for (const entry of entries) {
		if (entry.kind !== 'credential') continue
		if (entry.needKey && executorNeedKeys.has(entry.needKey)) continue
		const name = entry.name?.trim() || entry.credentialId || entry.needKey
		if (!name) continue
		const key = entry.credentialId ?? `${entry.needKey ?? ''}:${name}`
		if (items.has(key)) continue
		items.set(key, {
			kind: 'credential',
			name,
			detail: entry.needKey
				? `credential("${entry.needKey}")`
				: entry.hosts.length > 0
					? entry.hosts.join(', ')
					: null,
		})
	}
	return [...items.values()]
}

async function loadExecutorNeedKeys(input: {
	env: Env
	record: SavedPackageRecord
}) {
	const suppliersEnabled = await isPackageCredentialSuppliersEnabled({
		db: input.env.APP_DB,
		orgId: input.record.userId,
	})
	if (!suppliersEnabled) return new Set<string>()
	const needs = await loadPublishedCredentialNeeds({
		env: input.env,
		userId: input.record.userId,
		sourceId: input.record.sourceId,
		supplierSemanticsEnabled: true,
	})
	return new Set(
		needs.flatMap((need) =>
			need.supplier === 'executor' && need.ownerCredentialForVisitors !== true
				? [need.key]
				: [],
		),
	)
}

async function loadAppConnectorCapabilities(input: {
	env: Env
	record: SavedPackageRecord
}) {
	const source = await loadPackageSourceRowForUser({
		env: input.env,
		userId: input.record.userId,
		sourceId: input.record.sourceId,
	})
	const published = await loadPublishedEntityManifest({
		env: input.env,
		userId: input.record.userId,
		sourceId: input.record.sourceId,
		source,
	})
	const manifest = parseAuthoredPackageJson({
		content: published.content,
		manifestPath: source.manifest_path,
		mode: 'published',
	})
	return [
		...new Set(
			(manifest.kody.app?.capabilities ?? []).filter((name) =>
				name.startsWith('mcp:'),
			),
		),
	]
}
