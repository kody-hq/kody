import { ApiError, invalidRequest } from '#worker/open-api/errors.ts'
import { decodeJsonRequestBody } from '#worker/decode-request-body.ts'
import {
	assertNever,
	deadlineFailure,
	type DeadlineFailure,
} from '#worker/outbound/typed-failure.ts'
import {
	type DeadlineClock,
	outboundTimeoutMs,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { readRequestBodyUpTo } from '#worker/read-request-body-up-to.ts'
import { publishBuildDocumentSchema } from './document-schema.ts'
import { sha256Hex } from './module-hashes.ts'
import { publishOffloadLimits } from './policy.ts'
import {
	authenticatePublishBuildTicket,
	getPublishBuild,
	publishBuildBlobKey,
	publishBuildBlobPrefix,
	publishBuildDocumentSha256,
	reservePublishBuildChunk,
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

/** Every way an upload route refuses a request; mapped once at the edge. */
export type PublishBuildRouteFailure =
	| { kind: 'route_not_found' }
	| { kind: 'invalid_ticket' }
	| { kind: 'not_uploading'; status: string }
	| { kind: 'chunk_too_large' }
	| { kind: 'chunk_hash_mismatch' }
	| { kind: 'too_many_chunks' }
	| { kind: 'upload_too_large' }
	| { kind: 'document_too_large' }
	| { kind: 'invalid_json' }
	| { kind: 'invalid_document'; message: string }
	| { kind: 'missing_chunks'; missing: Array<string> }
	| { kind: 'seal_lost_race' }
	| { kind: 'sealed_with_other_document' }
	| DeadlineFailure

/** The ApiError (or the 409 missing-chunks body) for a route failure. */
export function mapPublishBuildRouteFailure(
	failure: PublishBuildRouteFailure,
): ApiError | Response {
	switch (failure.kind) {
		case 'route_not_found':
			return new ApiError({
				status: 404,
				code: 'not_found',
				message: 'Not found.',
			})
		case 'invalid_ticket':
			return new ApiError({
				status: 401,
				code: 'unauthorized',
				message:
					'This publish build ticket is invalid or expired. Start a new build with `kody package publish --build local`.',
			})
		case 'not_uploading':
			return new ApiError({
				status: 409,
				code: 'invalid_request',
				message: `This publish build is already ${failure.status}.`,
			})
		case 'chunk_too_large':
			return invalidRequest(
				`Chunks are at most ${publishOffloadLimits.chunkBytes} bytes.`,
			)
		case 'chunk_hash_mismatch':
			return invalidRequest('The chunk bytes do not match its sha256.')
		case 'too_many_chunks':
			return invalidRequest(
				`A build may upload at most ${publishOffloadLimits.maxBlobsPerBuild} chunks.`,
			)
		case 'upload_too_large':
			return invalidRequest(
				`A build may upload at most ${publishOffloadLimits.maxUploadBytes} bytes.`,
			)
		case 'document_too_large':
			return invalidRequest(
				`The build document is at most ${publishOffloadLimits.maxSealDocumentBytes} bytes.`,
			)
		case 'invalid_json':
			return invalidRequest('Request body must be valid JSON.')
		case 'invalid_document':
			return invalidRequest(failure.message)
		case 'missing_chunks':
			return json({ ok: false, missing_chunks: failure.missing }, 409)
		case 'seal_lost_race':
			return new ApiError({
				status: 409,
				code: 'invalid_request',
				message:
					'This publish build was sealed or finished by another request.',
			})
		case 'sealed_with_other_document':
			return new ApiError({
				status: 409,
				code: 'invalid_request',
				message:
					'This publish build is already sealed with a different build document. Start a new build with `kody package publish --build local`.',
			})
		case 'deadline_exceeded':
			return new ApiError({
				status: 503,
				code: 'internal_error',
				message: `Publish build storage did not answer in time (${failure.label}). Retry the request.`,
				headers: { 'Retry-After': '5' },
			})
		default:
			return assertNever(failure, 'publish build route failure')
	}
}

async function listUploadedChunks(
	bucket: R2Bucket,
	buildId: string,
	clock?: DeadlineClock,
) {
	const prefix = publishBuildBlobPrefix(buildId)
	const chunks: Array<string> = []
	let cursor: string | undefined
	do {
		const page = await withDeadline(
			{
				label: 'publish_build_blobs.list',
				timeoutMs: outboundTimeoutMs.r2,
				clock,
			},
			() => bucket.list({ prefix, ...(cursor ? { cursor } : {}) }),
		)
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

/** Version and commit checks; the shape is decoded at the edge and verified at publish time. */
export function checkSealedDocument(
	document: PublishBuildDocument,
	row: Pick<PublishBuildRow, 'commit_sha'>,
): { kind: 'invalid_document'; message: string } | null {
	if (document.builderVersion !== publishBuilderVersion) {
		return {
			kind: 'invalid_document',
			message: `This server accepts builder version ${publishBuilderVersion}; update the Kody CLI.`,
		}
	}
	if (document.commit !== row.commit_sha) {
		return {
			kind: 'invalid_document',
			message: `The build document is for ${document.commit}, but this build is for ${row.commit_sha}.`,
		}
	}
	return null
}

export async function handlePublishBuildRoute(input: {
	request: Request
	env: Env
	url: URL
	clock?: DeadlineClock
}): Promise<Response> {
	let outcome: Response | PublishBuildRouteFailure
	try {
		outcome = await runPublishBuildRoute(input)
	} catch (error) {
		const expired = deadlineFailure(error)
		if (!expired) throw error
		outcome = expired
	}
	if (outcome instanceof Response) return outcome
	const mapped = mapPublishBuildRouteFailure(outcome)
	if (mapped instanceof Response) return mapped
	throw mapped
}

async function runPublishBuildRoute(input: {
	request: Request
	env: Env
	url: URL
	clock?: DeadlineClock
}): Promise<Response | PublishBuildRouteFailure> {
	const route = parseRoute(input.request.method, input.url.pathname)
	if (!route) return { kind: 'route_not_found' }
	const clock = input.clock
	const row = await authenticatePublishBuildTicket({
		db: input.env.APP_DB,
		buildId: route.buildId,
		ticket: bearer(input.request),
		clock,
	})
	if (!row) return { kind: 'invalid_ticket' }
	const bucket = input.env.REPO_SESSION_BLOBS
	if (route.kind === 'status') {
		return json({
			build_id: row.id,
			commit: row.commit_sha,
			status: row.status,
			message: row.message,
			expires_at: row.expires_at,
			uploaded_chunks: await listUploadedChunks(bucket, row.id, clock),
		})
	}
	if (route.kind === 'seal') {
		return await sealRoute({
			request: input.request,
			env: input.env,
			row,
			clock,
		})
	}
	if (row.status !== 'uploading') {
		return { kind: 'not_uploading', status: row.status }
	}
	const key = publishBuildBlobKey(row.id, route.sha256)
	// Content-addressed: a retried chunk is already there.
	const existing = await withDeadline(
		{
			label: 'publish_build_blob.head',
			timeoutMs: outboundTimeoutMs.r2,
			clock,
		},
		() => bucket.head(key),
	)
	if (existing) return json({ ok: true, sha256: route.sha256 })
	const read = await readRequestBodyUpTo(
		input.request,
		publishOffloadLimits.chunkBytes,
	)
	if (!read.ok) return { kind: 'chunk_too_large' }
	const bytes = read.bytes
	if ((await sha256Hex(bytes)) !== route.sha256) {
		return { kind: 'chunk_hash_mismatch' }
	}
	const reserved = await reservePublishBuildChunk({
		db: input.env.APP_DB,
		buildId: row.id,
		sha256: route.sha256,
		bytes: bytes.byteLength,
		clock,
	})
	if (reserved.kind !== 'reserved') return reserved
	await withDeadline(
		{
			label: 'publish_build_blob.put',
			timeoutMs: outboundTimeoutMs.r2,
			clock,
		},
		() => bucket.put(key, bytes),
	)
	return json({ ok: true, sha256: route.sha256 })
}

async function sealRoute(input: {
	request: Request
	env: Env
	row: PublishBuildRow
	clock?: DeadlineClock
}): Promise<Response | PublishBuildRouteFailure> {
	const { row, clock } = input
	const bucket = input.env.REPO_SESSION_BLOBS
	const decoded = await decodeJsonRequestBody(input.request, {
		schema: publishBuildDocumentSchema,
		maxBytes: publishOffloadLimits.maxSealDocumentBytes,
	})
	switch (decoded.kind) {
		case 'ok':
			break
		case 'body_too_large':
			return { kind: 'document_too_large' }
		case 'invalid_json':
			return { kind: 'invalid_json' }
		case 'invalid_shape':
			return {
				kind: 'invalid_document',
				message: `The build document is malformed: ${decoded.message}`,
			}
		default:
			return assertNever(decoded, 'seal body decode')
	}
	const document = decoded.value
	const invalid = checkSealedDocument(document, row)
	if (invalid) return invalid
	const sealedResponse = json({ ok: true, build_id: row.id, status: 'sealed' })
	const sealedAs = async (current: PublishBuildRow) =>
		current.status === 'sealed' &&
		current.document_sha256 === (await publishBuildDocumentSha256(document))
	if (row.status === 'sealed') {
		// A retried seal (the response was lost) succeeds again.
		return (await sealedAs(row))
			? sealedResponse
			: { kind: 'sealed_with_other_document' }
	}
	if (row.status !== 'uploading') {
		return { kind: 'not_uploading', status: row.status }
	}
	const uploaded = new Set(await listUploadedChunks(bucket, row.id, clock))
	const missing = [...referencedChunks(document)].filter(
		(chunk) => !uploaded.has(chunk),
	)
	if (missing.length > 0) return { kind: 'missing_chunks', missing }
	const sealed = await sealPublishBuild({
		db: input.env.APP_DB,
		bucket,
		buildId: row.id,
		document,
		clock,
	})
	if (sealed) return sealedResponse
	// Another request moved the build out of `uploading` first.
	const current = await getPublishBuild(input.env.APP_DB, row.id, clock)
	if (current && (await sealedAs(current))) return sealedResponse
	return { kind: 'seal_lost_race' }
}
