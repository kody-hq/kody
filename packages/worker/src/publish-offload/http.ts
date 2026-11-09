import { ApiError, invalidRequest } from '#worker/open-api/errors.ts'
import { sha256Hex } from './module-hashes.ts'
import { publishOffloadLimits } from './policy.ts'
import {
	authenticatePublishBuildTicket,
	publishBuildBlobKey,
	publishBuildBlobPrefix,
	sealPublishBuild,
	type PublishBuildRow,
} from './store.ts'
import { publishBuilderVersion, type PublishBuildDocument } from './types.ts'

/**
 * Ticket-authenticated publish build upload routes. The ticket from
 * `packagePublishBuildCreate` is the only credential: it can add chunks to,
 * read the status of, and seal one build. Publishing the build still goes
 * through `packagePublishExternalPush` with the publisher's own login.
 *
 *   GET  /v1/publish-builds/{id}                 status + uploaded chunks
 *   PUT  /v1/publish-builds/{id}/blobs/{sha256}  one <= 4 MiB chunk
 *   POST /v1/publish-builds/{id}/seal            the build document
 */
const basePath = '/v1/publish-builds/'
const sha256Pattern = /^[0-9a-f]{64}$/
const buildIdPattern = /^pb_[0-9a-f]{24}$/

type ParsedRoute =
	| { kind: 'status'; buildId: string }
	| { kind: 'blob'; buildId: string; sha256: string }
	| { kind: 'seal'; buildId: string }

function parseRoute(method: string, pathname: string): ParsedRoute | null {
	if (!pathname.startsWith(basePath)) return null
	const parts = pathname.slice(basePath.length).split('/')
	const buildId = parts[0] ?? ''
	if (!buildIdPattern.test(buildId)) return null
	if (parts.length === 1 && method === 'GET') return { kind: 'status', buildId }
	if (parts.length === 2 && parts[1] === 'seal' && method === 'POST') {
		return { kind: 'seal', buildId }
	}
	if (
		parts.length === 3 &&
		parts[1] === 'blobs' &&
		sha256Pattern.test(parts[2] ?? '') &&
		method === 'PUT'
	) {
		return { kind: 'blob', buildId, sha256: parts[2]! }
	}
	return null
}

export function isPublishBuildRoute(method: string, pathname: string) {
	return parseRoute(method, pathname) !== null
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function bearer(request: Request) {
	const header = request.headers.get('Authorization') ?? ''
	return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
}

async function listUploadedChunks(bucket: R2Bucket, buildId: string) {
	const prefix = publishBuildBlobPrefix(buildId)
	const chunks: Array<string> = []
	let cursor: string | undefined
	do {
		const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
		for (const object of page.objects)
			chunks.push(object.key.slice(prefix.length))
		cursor = page.truncated ? page.cursor : undefined
	} while (cursor)
	return chunks
}

function referencedChunks(document: PublishBuildDocument) {
	const chunks = new Set<string>()
	for (const target of document.targets) {
		for (const module of Object.values(target.modules)) {
			for (const chunk of module.chunks) chunks.add(chunk)
		}
	}
	return chunks
}

/** Shape-only checks; the real verification runs at publish time. */
export function parseSealedDocument(
	raw: unknown,
	row: Pick<PublishBuildRow, 'commit_sha'>,
): PublishBuildDocument {
	const document = raw as Partial<PublishBuildDocument> | null
	if (
		!document ||
		typeof document !== 'object' ||
		!Array.isArray(document.files) ||
		!Array.isArray(document.targets)
	) {
		throw invalidRequest('The build document needs files and targets.')
	}
	if (document.builderVersion !== publishBuilderVersion) {
		throw invalidRequest(
			`This server accepts builder version ${publishBuilderVersion}; update the Kody CLI.`,
		)
	}
	if (document.commit !== row.commit_sha) {
		throw invalidRequest(
			`The build document is for ${String(document.commit)}, but this build is for ${row.commit_sha}.`,
		)
	}
	return document as PublishBuildDocument
}

export async function handlePublishBuildRoute(input: {
	request: Request
	env: Env
	url: URL
}): Promise<Response> {
	const route = parseRoute(input.request.method, input.url.pathname)
	if (!route)
		throw new ApiError({
			status: 404,
			code: 'not_found',
			message: 'Not found.',
		})
	const row = await authenticatePublishBuildTicket({
		db: input.env.APP_DB,
		buildId: route.buildId,
		ticket: bearer(input.request),
	})
	if (!row) {
		throw new ApiError({
			status: 401,
			code: 'unauthorized',
			message:
				'This publish build ticket is invalid or expired. Start a new build with `kody package publish --build local`.',
		})
	}
	const bucket = input.env.REPO_SESSION_BLOBS
	if (route.kind === 'status') {
		return json({
			build_id: row.id,
			commit: row.commit_sha,
			status: row.status,
			message: row.message,
			expires_at: row.expires_at,
			uploaded_chunks: await listUploadedChunks(bucket, row.id),
		})
	}
	if (row.status !== 'uploading') {
		throw new ApiError({
			status: 409,
			code: 'invalid_request',
			message: `This publish build is already ${row.status}.`,
		})
	}
	if (route.kind === 'blob') {
		const key = publishBuildBlobKey(row.id, route.sha256)
		// Content-addressed: a retried chunk is already there.
		if (await bucket.head(key)) return json({ ok: true, sha256: route.sha256 })
		const bytes = new Uint8Array(await input.request.arrayBuffer())
		if (bytes.byteLength > publishOffloadLimits.chunkBytes) {
			throw invalidRequest(
				`Chunks are at most ${publishOffloadLimits.chunkBytes} bytes.`,
			)
		}
		if ((await sha256Hex(bytes)) !== route.sha256) {
			throw invalidRequest('The chunk bytes do not match its sha256.')
		}
		const uploaded = await listUploadedChunks(bucket, row.id)
		if (uploaded.length >= publishOffloadLimits.maxBlobsPerBuild) {
			throw invalidRequest(
				`A build may upload at most ${publishOffloadLimits.maxBlobsPerBuild} chunks.`,
			)
		}
		await bucket.put(key, bytes)
		return json({ ok: true, sha256: route.sha256 })
	}
	const document = parseSealedDocument(await input.request.json(), row)
	const uploaded = new Set(await listUploadedChunks(bucket, row.id))
	const missing = [...referencedChunks(document)].filter(
		(chunk) => !uploaded.has(chunk),
	)
	if (missing.length > 0) {
		return json({ ok: false, missing_chunks: missing }, 409)
	}
	await sealPublishBuild({ db: input.env.APP_DB, buildId: row.id, document })
	return json({ ok: true, build_id: row.id, status: 'sealed' })
}
