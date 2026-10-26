import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { listPackageWebhooks } from '#worker/package-registry/manifest.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { webhookEndpointNotOffSql } from './repo.ts'
import {
	mapWithConcurrency,
	readWebhookDeliveries,
	webhookOwnerScanConcurrency,
} from './delivery-outcomes.ts'

const endpointPageSize = 1_000

/**
 * `implicit_url_secret`: the manifest declares the webhook without
 * `verification`, so ingress treats it as `url-secret` (supported).
 * `url_secret`: it declares `verification: { type: 'url-secret' }`.
 * `signature`: it declares an HMAC scheme. `undeclared`: the manifest no longer
 * declares it, so ingress refuses deliveries. `manifest_unavailable`: the
 * package or its manifest could not be read.
 */
export type WebhookVerificationStatus =
	| 'implicit_url_secret'
	| 'url_secret'
	| 'signature'
	| 'undeclared'
	| 'manifest_unavailable'

export type WebhookVerificationScanEndpoint = {
	ownerId: OwnerId
	ownerSlug: string | null
	endpointId: string
	packageId: string
	packageKodyId: string | null
	webhookName: string
	enabled: boolean
	status: WebhookVerificationStatus
	verification: {
		type: string
		header: string | null
		secretName: string | null
	} | null
	delivered: number
	lastDeliveredAt: string | null
}

export type WebhookVerificationScan = {
	since: string
	endpointsScanned: number
	ownersFailed: Array<OwnerId>
	truncated: boolean
	totals: Record<WebhookVerificationStatus, number> & {
		implicitUrlSecretOwners: number
		implicitUrlSecretDelivered: number
	}
	endpoints: Array<WebhookVerificationScanEndpoint>
}

type EndpointRow = {
	id: string
	enabled: number
	user_id: string
	package_id: string
	webhook_name: string
	owner_slug: string | null
	kody_id: string | null
	source_id: string | null
}

async function listWebhookEndpoints(db: D1Database, includeDisabled: boolean) {
	const enabledSql = includeDisabled
		? ''
		: ` AND ${webhookEndpointNotOffSql('e')}`
	const rows: Array<EndpointRow> = []
	let after = ''
	for (;;) {
		const page =
			(
				await db
					.prepare(
						`SELECT e.id, ${webhookEndpointNotOffSql('e')} AS enabled,
							e.user_id, e.package_id, e.webhook_name,
							o.slug AS owner_slug, p.kody_id, p.source_id
						 FROM webhook_endpoints e
						 LEFT JOIN orgs o ON o.id = e.user_id
						 LEFT JOIN saved_packages p
							ON p.id = e.package_id AND p.user_id = e.user_id${andLiveDeletedAtSql('p')}
						 WHERE e.id > ?${andLiveDeletedAtSql('e')}${enabledSql}
						 ORDER BY e.id
						 LIMIT ?`,
					)
					.bind(after, endpointPageSize)
					.all<EndpointRow>()
			).results ?? []
		rows.push(...page)
		if (page.length < endpointPageSize) return rows
		after = page[page.length - 1]!.id
	}
}

/**
 * Which live webhook URLs rely on URL-secret-only auth, judged from each
 * package's current manifest the same way ingress reads it, with successful
 * deliveries since `since` from each owner's RunLog. Reporting only; nothing
 * here changes how a webhook authenticates.
 */
export async function scanWebhookVerification(input: {
	env: Env
	since: string
	includeSignature: boolean
	includeDisabled?: boolean
}): Promise<WebhookVerificationScan> {
	const since = new Date(input.since).toISOString()
	const rows = await listWebhookEndpoints(
		input.env.APP_DB,
		input.includeDisabled === true,
	)
	const baseUrl = getAppBaseUrl({ env: input.env })

	const manifestKeys = new Map<string, { userId: string; sourceId: string }>()
	for (const row of rows) {
		if (row.source_id) {
			manifestKeys.set(`${row.user_id}:${row.source_id}`, {
				userId: row.user_id,
				sourceId: row.source_id,
			})
		}
	}
	const manifests = new Map<
		string,
		ReturnType<typeof listPackageWebhooks> | null
	>()
	await mapWithConcurrency(
		[...manifestKeys.entries()],
		webhookOwnerScanConcurrency,
		async ([key, source]) => {
			try {
				const loaded = await loadPackageManifestBySourceId({
					env: input.env,
					baseUrl,
					userId: source.userId,
					sourceId: source.sourceId,
				})
				manifests.set(key, listPackageWebhooks(loaded.manifest))
			} catch (cause) {
				console.warn('webhook-verification-scan-manifest-failed', {
					ownerId: source.userId,
					sourceId: source.sourceId,
					error: cause,
				})
				manifests.set(key, null)
			}
		},
	)

	const endpoints: Array<WebhookVerificationScanEndpoint> = rows.map((row) => {
		const webhooks = row.source_id
			? manifests.get(`${row.user_id}:${row.source_id}`)
			: null
		const declared = webhooks?.find(
			(webhook) => webhook.name === row.webhook_name,
		)
		const status: WebhookVerificationStatus = !webhooks
			? 'manifest_unavailable'
			: !declared
				? 'undeclared'
				: !declared.verification
					? 'implicit_url_secret'
					: declared.verification.type === 'url-secret'
						? 'url_secret'
						: 'signature'
		return {
			ownerId: row.user_id as OwnerId,
			ownerSlug: row.owner_slug,
			endpointId: row.id,
			packageId: row.package_id,
			packageKodyId: row.kody_id,
			webhookName: row.webhook_name,
			enabled: row.enabled === 1,
			status,
			verification: !declared?.verification
				? null
				: declared.verification.type === 'url-secret'
					? { type: 'url-secret', header: null, secretName: null }
					: {
							type: declared.verification.type,
							header: declared.verification.header,
							secretName: declared.verification.secretName ?? null,
						},
			delivered: 0,
			lastDeliveredAt: null,
		}
	})

	const reported = endpoints.filter(
		(endpoint) => input.includeSignature || endpoint.status !== 'signature',
	)
	const byOwner = new Map<OwnerId, Array<WebhookVerificationScanEndpoint>>()
	for (const endpoint of reported) {
		const owned = byOwner.get(endpoint.ownerId) ?? []
		owned.push(endpoint)
		byOwner.set(endpoint.ownerId, owned)
	}
	const deliveryScans = await mapWithConcurrency(
		[...byOwner.entries()],
		webhookOwnerScanConcurrency,
		async ([ownerId, owned]) => {
			try {
				const result = await readWebhookDeliveries({
					env: input.env,
					ownerId,
					filter: { since },
				})
				const byEndpointId = new Map(
					owned.map((endpoint) => [endpoint.endpointId, endpoint]),
				)
				for (const delivery of result.deliveries) {
					const endpoint = delivery.endpointId
						? byEndpointId.get(delivery.endpointId)
						: undefined
					if (!endpoint || !delivery.delivered) continue
					endpoint.delivered += 1
					if (
						endpoint.lastDeliveredAt === null ||
						delivery.startedAt > endpoint.lastDeliveredAt
					) {
						endpoint.lastDeliveredAt = delivery.startedAt
					}
				}
				return { ownerId, truncated: result.truncated, failed: false }
			} catch (cause) {
				console.warn('webhook-verification-scan-owner-failed', {
					ownerId,
					error: cause,
				})
				return { ownerId, truncated: false, failed: true }
			}
		},
	)

	const implicitUrlSecret = endpoints.filter(
		(endpoint) => endpoint.status === 'implicit_url_secret',
	)
	const countStatus = (status: WebhookVerificationStatus) =>
		endpoints.filter((endpoint) => endpoint.status === status).length
	reported.sort(
		(left, right) =>
			(left.ownerSlug ?? left.ownerId).localeCompare(
				right.ownerSlug ?? right.ownerId,
			) ||
			(left.packageKodyId ?? '').localeCompare(right.packageKodyId ?? '') ||
			left.webhookName.localeCompare(right.webhookName),
	)
	return {
		since,
		endpointsScanned: endpoints.length,
		ownersFailed: deliveryScans
			.filter((scan) => scan.failed)
			.map((scan) => scan.ownerId),
		truncated: deliveryScans.some((scan) => scan.truncated),
		totals: {
			implicit_url_secret: implicitUrlSecret.length,
			url_secret: countStatus('url_secret'),
			signature: countStatus('signature'),
			undeclared: countStatus('undeclared'),
			manifest_unavailable: countStatus('manifest_unavailable'),
			implicitUrlSecretOwners: new Set(
				implicitUrlSecret.map((row) => row.ownerId),
			).size,
			implicitUrlSecretDelivered: implicitUrlSecret.reduce(
				(sum, row) => sum + row.delivered,
				0,
			),
		},
		endpoints: reported,
	}
}
