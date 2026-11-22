import { Effect, Match, Schema } from 'effect'
import { runEdge, rethrow } from '#worker/effect/edge.ts'
import { ApiError, invalidRequest } from '#worker/open-api/errors.ts'
import { digestSha256Hex } from './digest.ts'
import type { PublishBuildTicketInvalid } from './errors.ts'
import { publishOffloadLimits } from './policy.ts'
import * as Schemas from './schemas.ts'
import { listAllKeys } from '#worker/effect/r2.ts'
import { PublishBuildBucket, publishOffloadRuntime } from './services.ts'
import {
	abandonPublishBuild,
	authenticatePublishBuildTicket,
	getPublishBuild,
	publishBuildBlobPrefix,
	publishBuildBlobKey,
	renewPublishBuildLease,
	sealPublishBuild,
	type PublishBuildRow,
} from './store.ts'
import { publishBuilderVersion, type PublishBuildDocument } from './types.ts'

/**
 * Ticket-authenticated publish build upload routes. The ticket from
 * `packagePublishBuildCreate` is the only credential: it can add chunks to,
 * read the status of, seal, and abandon one build. A chunk upload or status
 * read renews the ticket's lease (see `renewPublishBuildLease`). Publishing
 * the build still goes through `packagePublishExternalPush` with the
 * publisher's own login.
 *
 *   GET  /v1/publish-builds/{id}                 status + uploaded chunks
 *   PUT  /v1/publish-builds/{id}/blobs/{sha256}  one <= 4 MiB chunk
 *   POST /v1/publish-builds/{id}/seal            the build document
 *   POST /v1/publish-builds/{id}/abandon         stop and drop the upload
 */
const basePath = '/v1/publish-builds/'
const sha256Pattern = /^[0-9a-f]{64}$/
const buildIdPattern = /^pb_[0-9a-f]{24}$/

export class PublishBuildRouteNotFound extends Schema.TaggedError<PublishBuildRouteNotFound>()(
	'PublishBuildRouteNotFound',
	{},
) {}

/** Uploading, sealing or abandoning a build no longer uploading (409). */
export class PublishBuildNotUploading extends Schema.TaggedError<PublishBuildNotUploading>()(
	'PublishBuildNotUploading',
	{ status: Schemas.PublishBuildStatus },
) {}

/** A chunk or document the server refuses (400 `invalid_request`). */
export class PublishBuildInvalidUpload extends Schema.TaggedError<PublishBuildInvalidUpload>()(
	'PublishBuildInvalidUpload',
	{ message: Schema.String },
) {}

/** The document names chunks that were never uploaded (409 JSON body). */
export class PublishBuildChunksMissing extends Schema.TaggedError<PublishBuildChunksMissing>()(
	'PublishBuildChunksMissing',
	{ missing: Schema.Array(Schema.String) },
) {}

type ParsedRoute =
	| { kind: 'status'; buildId: string }
	| { kind: 'blob'; buildId: string; sha256: string }
	| { kind: 'seal'; buildId: string }
	| { kind: 'abandon'; buildId: string }

function parseRoute(method: string, pathname: string): ParsedRoute | null {
	if (!pathname.startsWith(basePath)) return null
	const parts = pathname.slice(basePath.length).split('/')
	const buildId = parts[0] ?? ''
	if (!buildIdPattern.test(buildId)) return null
	if (parts.length === 1 && method === 'GET') return { kind: 'status', buildId }
	if (parts.length === 2 && parts[1] === 'seal' && method === 'POST') {
		return { kind: 'seal', buildId }
	}
	if (parts.length === 2 && parts[1] === 'abandon' && method === 'POST') {
		return { kind: 'abandon', buildId }
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

const invalid = (message: string) => new PublishBuildInvalidUpload({ message })

const readBody = <A>(read: () => Promise<A>) =>
	// effect-check: allow reads the inbound request body, not an outbound call
	Effect.tryPromise({
		try: read,
		catch: () => invalid('The request body could not be read.'),
	})

function referencedChunks(document: PublishBuildDocument) {
	const chunks = new Set<string>()
	for (const target of document.targets) {
		for (const module of Object.values(target.modules)) {
			for (const chunk of module.chunks) chunks.add(chunk)
		}
	}
	return chunks
}

const DocumentEnvelope = Schema.Struct({
	builderVersion: Schema.optionalKey(Schema.Unknown),
	commit: Schema.optionalKey(Schema.Unknown),
	files: Schema.Array(Schema.Unknown),
	targets: Schema.Array(Schema.Unknown),
})

/** Every chunk uploaded to a build, by sha256. */
const listUploadedChunks = Effect.fn('PublishBuildHttp.listChunks')(function* (
	buildId: string,
) {
	const bucket = yield* PublishBuildBucket
	const prefix = publishBuildBlobPrefix(buildId)
	const keys = yield* listAllKeys(bucket, prefix)
	return keys.map((key) => key.slice(prefix.length))
})

/**
 * The envelope checks keep their order (shape, builder version, commit);
 * then the whole document must decode. The content checks run at publish
 * time in `verify.ts`.
 */
export const parseSealedDocument = Effect.fn('PublishBuildHttp.parseDocument')(
	function* (raw: unknown, row: Pick<PublishBuildRow, 'commit_sha'>) {
		const envelope = yield* Schema.decodeUnknownEffect(DocumentEnvelope)(
			raw,
		).pipe(
			Effect.mapError(() =>
				invalid('The build document needs files and targets.'),
			),
		)
		if (envelope.builderVersion !== publishBuilderVersion) {
			return yield* invalid(
				`This server accepts builder version ${publishBuilderVersion}; update the Kody CLI.`,
			)
		}
		if (envelope.commit !== row.commit_sha) {
			return yield* invalid(
				`The build document is for ${String(envelope.commit)}, but this build is for ${row.commit_sha}.`,
			)
		}
		return yield* Schema.decodeUnknownEffect(Schemas.PublishBuildDocument)(
			raw,
		).pipe(
			Effect.mapError((cause) =>
				invalid(`The build document is malformed: ${cause.message}`),
			),
		)
	},
)

const uploadChunk = Effect.fn('PublishBuildHttp.uploadChunk')(function* (
	request: Request,
	row: PublishBuildRow,
	sha256: string,
) {
	const bucket = yield* PublishBuildBucket
	const key = publishBuildBlobKey(row.id, sha256)
	// Content-addressed: a retried chunk is already there.
	if (yield* bucket.head(key)) return json({ ok: true, sha256 })
	const bytes = new Uint8Array(yield* readBody(() => request.arrayBuffer()))
	if (bytes.byteLength > publishOffloadLimits.chunkBytes) {
		return yield* invalid(
			`Chunks are at most ${publishOffloadLimits.chunkBytes} bytes.`,
		)
	}
	if ((yield* digestSha256Hex(bytes)) !== sha256) {
		return yield* invalid('The chunk bytes do not match its sha256.')
	}
	const uploaded = yield* listUploadedChunks(row.id)
	if (uploaded.length >= publishOffloadLimits.maxBlobsPerBuild) {
		return yield* invalid(
			`A build may upload at most ${publishOffloadLimits.maxBlobsPerBuild} chunks.`,
		)
	}
	yield* bucket.put(key, bytes)
	return json({ ok: true, sha256 })
})

const sealBuild = Effect.fn('PublishBuildHttp.seal')(function* (
	request: Request,
	row: PublishBuildRow,
) {
	const raw = yield* readBody(() => request.text()).pipe(
		Effect.flatMap((text) =>
			Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text),
		),
		Effect.mapError(() => invalid('The build document is not valid JSON.')),
	)
	const document = yield* parseSealedDocument(raw, row)
	const uploaded = new Set(yield* listUploadedChunks(row.id))
	const missing = [...referencedChunks(document)].filter(
		(chunk) => !uploaded.has(chunk),
	)
	if (missing.length > 0)
		return yield* new PublishBuildChunksMissing({ missing })
	if (!(yield* sealPublishBuild({ buildId: row.id, document }))) {
		const current = yield* getPublishBuild(row.id)
		return yield* new PublishBuildNotUploading({
			status: current._tag === 'Some' ? current.value.status : row.status,
		})
	}
	return json({ ok: true, build_id: row.id, status: 'sealed' })
})

const abandonedResponse = (buildId: string) =>
	json({ ok: true, build_id: buildId, status: 'abandoned' })

/** Abandoning twice answers the same; a sealed or later build is a 409. */
const abandonBuild = Effect.fn('PublishBuildHttp.abandon')(function* (
	row: PublishBuildRow,
) {
	if (row.status === 'abandoned') return abandonedResponse(row.id)
	if (row.status !== 'uploading') {
		return yield* new PublishBuildNotUploading({ status: row.status })
	}
	if (!(yield* abandonPublishBuild(row.id))) {
		const current = yield* getPublishBuild(row.id)
		const status = current._tag === 'Some' ? current.value.status : row.status
		if (status !== 'abandoned') {
			return yield* new PublishBuildNotUploading({ status })
		}
	}
	return abandonedResponse(row.id)
})

export const servePublishBuildRoute = Effect.fn('PublishBuildHttp.serve')(
	function* (request: Request, url: URL) {
		const route = parseRoute(request.method, url.pathname)
		if (!route) return yield* new PublishBuildRouteNotFound()
		const row = yield* authenticatePublishBuildTicket({
			buildId: route.buildId,
			ticket: bearer(request),
			allowAbandoned: route.kind === 'abandon',
		})
		if (route.kind === 'abandon') return yield* abandonBuild(row)
		if (route.kind === 'status') {
			const expiresAt = yield* renewPublishBuildLease(row)
			return json({
				build_id: row.id,
				commit: row.commit_sha,
				status: row.status,
				message: row.message,
				expires_at: expiresAt,
				uploaded_chunks: yield* listUploadedChunks(row.id),
			})
		}
		if (row.status !== 'uploading') {
			return yield* new PublishBuildNotUploading({ status: row.status })
		}
		if (route.kind === 'blob') {
			const response = yield* uploadChunk(request, row, route.sha256)
			yield* renewPublishBuildLease(row)
			return response
		}
		return yield* sealBuild(request, row)
	},
)

type PublishBuildRouteError = Effect.Error<
	ReturnType<typeof servePublishBuildRoute>
>

const publishBuildRouteFailure = Match.type<PublishBuildRouteError>().pipe(
	Match.tagsExhaustive({
		PublishBuildRouteNotFound: (): Response => {
			throw new ApiError({
				status: 404,
				code: 'not_found',
				message: 'Not found.',
			})
		},
		PublishBuildTicketInvalid: (_: PublishBuildTicketInvalid): Response => {
			throw new ApiError({
				status: 401,
				code: 'unauthorized',
				message:
					'This publish build ticket is invalid or expired. Start a new build with `kody package publish --build local`.',
			})
		},
		PublishBuildNotUploading: ({ status }): Response => {
			throw new ApiError({
				status: 409,
				code: 'invalid_request',
				message: `This publish build is already ${status}.`,
			})
		},
		PublishBuildInvalidUpload: ({ message }): Response => {
			throw invalidRequest(message)
		},
		PublishBuildChunksMissing: ({ missing }) =>
			json({ ok: false, missing_chunks: missing }, 409),
		DatabaseError: rethrow,
		OutboundCallError: rethrow,
	}),
)

/** The Open API dispatch edge (`open-api/http-handler.ts`). */
export async function handlePublishBuildRoute(input: {
	request: Request
	env: Env
	url: URL
}): Promise<Response> {
	return await runEdge(
		publishOffloadRuntime(input.env),
		servePublishBuildRoute(input.request, input.url),
		publishBuildRouteFailure,
	)
}
