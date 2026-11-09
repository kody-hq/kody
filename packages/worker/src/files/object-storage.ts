import { AwsClient } from 'aws4fetch'
import { z } from 'zod'
import { resolveCredential } from '#worker/credentials/resolve-credential.ts'
import { getOrgCredential } from '#worker/credentials/credential-ids.ts'
import { loadLiveOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import {
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type FileStorageConfig } from '#universal/file-storage.ts'
import { fileStoreRpc } from './client.ts'

export type FileBlobObject = Pick<
	R2ObjectBody,
	'body' | 'arrayBuffer' | 'size' | 'httpEtag' | 'httpMetadata'
>
export type FileObjectStore = {
	get(
		key: string,
		options?: { range?: { offset: number; length: number } },
	): Promise<FileBlobObject | null>
	head(key: string): Promise<Pick<FileBlobObject, 'size' | 'httpEtag'> | null>
	put(
		key: string,
		bytes: Uint8Array,
		options?: { httpMetadata?: { contentType?: string } },
	): Promise<unknown>
	delete(key: string | string[]): Promise<void>
}
/** Accept R2 and AWS S3 endpoints. Arbitrary hosts never receive storage credentials. */
export function storageEndpoint(value: string) {
	const url = new URL(value)
	if (
		url.protocol !== 'https:' ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== '/' ||
		!(
			/^[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com$/.test(
				url.hostname,
			) || /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
		)
	)
		throw new Error('Use an R2 or Amazon S3 HTTPS endpoint without a path.')
	return url
}
export async function providerObjectStore(
	env: Env,
	ownerId: OwnerId,
	config?: FileStorageConfig | null,
): Promise<FileObjectStore> {
	if (!config) {
		if (!env.FILE_BLOBS) throw new Error('File blob storage is not configured.')
		return env.FILE_BLOBS
	}
	const endpoint = storageEndpoint(config.endpoint)
	const credential = config.credentialId
		? await getOrgCredential(env.APP_DB, ownerId, config.credentialId)
		: null
	const person = config.authorizedBy
		? await env.APP_DB.prepare(
				'SELECT stable_user_id,username,personal_org_id FROM users WHERE stable_user_id=? AND deleted_at IS NULL AND suspended_at IS NULL',
			)
				.bind(config.authorizedBy)
				.first<{
					stable_user_id: string
					username: string
					personal_org_id: string
				}>()
		: null
	const binding = person
		? await loadLiveOrgBindingForOrg(env.APP_DB, person.stable_user_id, ownerId)
		: null
	if (
		!person ||
		binding?.role !== 'owner' ||
		!credential?.live ||
		credential.kind !== 'secret'
	)
		throw new Error(
			'The storage credential or authorizing owner is unavailable. A workspace owner must reconnect it.',
		)
	const actor = deriveRequestContext({
		user: {
			userId: personIdFromStored(person.stable_user_id),
			username: person.username,
			personalOrgId: ownerId,
		},
		orgBinding: binding,
		source: { kind: 'file-storage', connectionId: config.id },
		scopes: ['secret:use'],
	})
	const resolved = await resolveCredential({
		env,
		orgId: ownerId,
		actor,
		baseUrl: 'https://kody.codes',
		auditDetails: { storageConnectionId: config.id },
		credential: {
			use: 'secret',
			orgOnly: true,
			name: credential.name,
			scope: 'user',
			storageContext: { sessionId: null, appId: null },
			requestHost: endpoint.host,
		},
	})
	if (
		!resolved.found ||
		resolved.credentialId !== config.credentialId ||
		resolved.allowedPackages.length
	)
		throw new Error(
			'The storage credential is unavailable or restricted to a package.',
		)

	const keys = z
		.object({
			accessKeyId: z.string().min(1),
			secretAccessKey: z.string().min(1),
		})
		.parse(JSON.parse(resolved.value ?? ''))
	const client = new AwsClient({
		...keys,
		region: config.region,
		service: 's3',
		retries: 1,
	})
	async function request(
		key: string,
		method: string,
		bytes?: Uint8Array,
		headers?: HeadersInit,
	) {
		const url = new URL(endpoint)
		url.pathname = `/${encodeURIComponent(config!.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
		const response = await client.fetch(url, {
			method,
			body: bytes ? new Uint8Array(bytes).buffer : undefined,
			headers,
			redirect: 'manual',
			signal: AbortSignal.timeout(30000),
		})
		if ((method === 'GET' || method === 'HEAD') && response.status === 404)
			return null
		if (!response.ok)
			throw new Error(
				'External storage is unavailable. Check its connection and retry.',
			)
		return response
	}
	return {
		async get(key, options) {
			const range = options?.range
			const response = await request(
				key,
				'GET',
				undefined,
				range
					? {
							Range: `bytes=${range.offset}-${range.offset + range.length - 1}`,
						}
					: {},
			)
			if (!response) return null
			const total = response.headers.get('content-range')?.split('/').at(-1)
			const size = Number(total ?? response.headers.get('content-length'))
			if (
				!Number.isSafeInteger(size) ||
				size < 0 ||
				!response.headers.get('etag') ||
				!response.body
			)
				throw new Error('Storage returned invalid object metadata.')
			if (range && response.status !== 206)
				throw new Error('Storage did not honor the requested range.')
			return {
				body: response.body,
				arrayBuffer: () => response.arrayBuffer(),
				size,
				httpEtag: response.headers.get('etag')!,
				httpMetadata: {
					contentType: response.headers.get('content-type') ?? undefined,
				},
			}
		},
		async head(key) {
			const response = await request(key, 'HEAD')
			return response
				? {
						size: Number(response.headers.get('content-length')),
						httpEtag: response.headers.get('etag') ?? '',
					}
				: null
		},
		async put(key, bytes, options) {
			return request(key, 'PUT', bytes, {
				'Content-Type':
					options?.httpMetadata?.contentType ?? 'application/octet-stream',
			})
		},
		async delete(keys) {
			for (const key of typeof keys === 'string' ? [keys] : keys)
				await request(key, 'DELETE')
		},
	}
}
/** Asset routes and account exports use the same server-only locator as FileStore. */
export function fileObjectReader(env: Env, ownerId: OwnerId) {
	async function store(key: string) {
		return providerObjectStore(
			env,
			ownerId,
			await fileStoreRpc(env, ownerId).objectProvider(ownerId, key),
		)
	}
	return {
		async get(
			key: string,
			options?: { range?: { offset: number; length: number } },
		) {
			return (await store(key)).get(key, options)
		},
		async head(key: string) {
			return (await store(key)).head(key)
		},
	}
}
