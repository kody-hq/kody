import { AwsClient } from 'aws4fetch'
import { checksum, type FileRecord, type Revision } from './contracts.ts'
import { DocumentFailure } from './document.ts'

export type ObjectStore = {
	put(key: string, content: string): Promise<void>
	get(key: string): Promise<string | null>
	delete(key: string): Promise<void>
}
export type ExternalStorage = {
	endpoint: string
	bucket: string
	accessKeyId: string
	secretAccessKey: string
	region: string
}

export function boundObjectStore(bucket: R2Bucket): ObjectStore {
	return {
		async put(key, content) {
			await bucket.put(key, content, {
				httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
			})
		},
		async get(key) {
			const object = await bucket.get(key)
			return object ? object.text() : null
		},
		async delete(key) {
			await bucket.delete(key)
		},
	}
}

/** The spike accepts a local S3 test server or an HTTPS provider endpoint. */
export function s3ObjectStore(configuration: ExternalStorage): ObjectStore {
	const endpoint = new URL(configuration.endpoint)
	if (
		endpoint.protocol !== 'https:' &&
		!(
			endpoint.protocol === 'http:' &&
			['localhost', '127.0.0.1'].includes(endpoint.hostname)
		)
	)
		throw new DocumentFailure(
			'invalid_storage',
			'Storage requires an HTTPS endpoint.',
		)
	if (
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	)
		throw new DocumentFailure(
			'invalid_storage',
			'Storage endpoint must not contain credentials or query parameters.',
		)
	const client = new AwsClient({ ...configuration, service: 's3', retries: 1 })
	async function request(key: string, method: string, body?: string) {
		const url = new URL(endpoint)
		url.pathname = `${endpoint.pathname.replace(/\/$/, '')}/${encodeURIComponent(configuration.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`
		const response = await client.fetch(url, {
			method,
			body,
			redirect: 'manual',
			signal: AbortSignal.timeout(5_000),
		})
		if (method === 'GET' && response.status === 404) return null
		if (!response.ok)
			throw new DocumentFailure(
				'storage_unavailable',
				'Storage is unavailable. Check the connection before saving more changes.',
				503,
			)
		return response
	}
	return {
		async put(key, content) {
			await request(key, 'PUT', content)
		},
		async get(key) {
			const response = await request(key, 'GET')
			return response ? response.text() : null
		},
		async delete(key) {
			await request(key, 'DELETE')
		},
	}
}

export function revisionKey(
	file: Pick<FileRecord, 'orgId' | 'id'>,
	revisionId: string,
) {
	return `files:v1/${file.orgId}/${file.id}/${revisionId}.md`
}

export async function verifyRevision(
	store: ObjectStore,
	file: FileRecord,
	revision: Revision,
) {
	const content = await store.get(revisionKey(file, revision.id))
	if (content === null || (await checksum(content)) !== revision.sha256)
		throw new DocumentFailure(
			'storage_unavailable',
			'The saved revision is missing or has changed in storage.',
			503,
		)
	return content
}
