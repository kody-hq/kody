import { createHash } from 'node:crypto'
export type JsonRecord = Record<string, unknown>
export function rolloutAccount() {
	const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? ''
	if (!/^[a-f0-9]{32}$/.test(account) || !process.env.CLOUDFLARE_API_TOKEN)
		throw new Error('Cloudflare rollout credentials required')
	return account
}
export async function rolloutApi(
	endpoint: string,
	method: 'GET' | 'POST' | 'DELETE' = 'GET',
	body?: JsonRecord,
): Promise<unknown> {
	rolloutAccount()
	const response = await fetch(
		`https://api.cloudflare.com/client/v4${endpoint}`,
		{
			method,
			headers: {
				Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
				'Content-Type': 'application/json',
			},
			...(body ? { body: JSON.stringify(body) } : {}),
		},
	)
	const result = (await response.json()) as {
		success?: boolean
		result?: unknown
	}
	if (!response.ok || result.success !== true)
		throw new Error(
			`Cloudflare rollout verification failed (${response.status})`,
		)
	return result.result
}
function normalize(value: unknown, key = ''): unknown {
	if (Array.isArray(value)) {
		const values = value.map((child) => normalize(child))
		return ['bindings', 'compatibility_flags'].includes(key)
			? values.sort((a, b) =>
					JSON.stringify(a).localeCompare(JSON.stringify(b)),
				)
			: values
	}
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, child]) => child !== undefined)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([name, child]) => [name, normalize(child, name)]),
		)
	return value
}
export function settingsDigest(settings: JsonRecord) {
	return createHash('sha256')
		.update(JSON.stringify(normalize(settings)))
		.digest('hex')
}
export function activeWorkerVersion(result: JsonRecord) {
	const deployment = (
		result.deployments as
			| Array<{
					id?: string
					versions?: Array<{ version_id?: string; percentage?: number }>
			  }>
			| undefined
	)?.[0]
	if (
		!deployment ||
		typeof deployment.id !== 'string' ||
		deployment.versions?.length !== 1 ||
		deployment.versions[0]?.percentage !== 100 ||
		!/^[a-f0-9-]{36}$/.test(deployment.versions[0].version_id ?? '')
	)
		throw new Error('A single immutable active worker version is required')
	return {
		deploymentId: deployment.id,
		versionId: deployment.versions[0].version_id!,
	}
}
export async function workerEvidence(name: string) {
	if (
		!/^kody-(?:production|start-router-[a-f0-9]{40}|start-[a-f0-9]{40})$/.test(
			name,
		)
	)
		throw new Error('Unexpected rollout worker name')
	const prefix = `/accounts/${rolloutAccount()}/workers/scripts/${name}`
	const settings = (await rolloutApi(`${prefix}/settings`)) as JsonRecord
	const version = activeWorkerVersion(
		(await rolloutApi(`${prefix}/deployments`)) as JsonRecord,
	)
	return { ...version, settingsDigest: settingsDigest(settings) }
}
