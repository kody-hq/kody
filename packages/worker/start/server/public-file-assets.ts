import {
	defaultFileAssetSettings,
	signedAssetRouteToken,
} from '#universal/file-assets.ts'
import { z } from 'zod'
import { fileIdSchema } from '#universal/files.ts'
const scope = z.object({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	rootId: fileIdSchema,
	token: z.string().regex(/^[a-f0-9]{64}$/),
	itemId: fileIdSchema,
})

export async function publicFileAssetHttp({
	params,
}: {
	params: { orgSlug: string; rootId: string; token: string; itemId: string }
}) {
	const parsed = scope.safeParse(params)
	if (!parsed.success) return new Response('Not found', { status: 404 })
	const [
		{ getRequest },
		{ getStartRequestEnv },
		{ publicFileScope },
		{ fileBlobKey },
		{ fileObjectReader },
		{ parseFileRange, fileAssetPolicy, inlineFileType },
		{ detectFileMediaType },
	] = await Promise.all([
		import('@tanstack/react-start/server'),
		import('./request-env.ts'),
		import('../../src/files/public-links.ts'),
		import('../../src/files/object-keys.ts'),
		import('../../src/files/object-storage.ts'),
		import('#universal/file-assets.ts'),
		import('#universal/file-viewers.ts'),
	])
	try {
		const env = getStartRequestEnv()
		const request = getRequest()
		const query = new URL(request.url).searchParams
		const signed = params.token === signedAssetRouteToken
		const publicAsset = !signed && query.get('asset') === '1'
		const result = signed
			? await resolveSignedAsset(env, params, query.get('signature'))
			: await publicFileScope(
					env,
					params.orgSlug,
					params.rootId,
					params.token,
					params.itemId,
				)
		const file = result.file
		const revision = file.revisions.find(
			(revision) => revision.id === file.revisionId,
		)
		if (!revision) throw new Error('Not found')
		const range = parseFileRange(request.headers.get('Range'), revision.bytes),
			type = detectFileMediaType(file.name, file.mediaType)
		const { fileStoreRpc } = await import('../../src/files/client.ts')
		const settings =
			signed || publicAsset
				? ((await fileStoreRpc(env, result.ownerId).assetSettings(
						result.ownerId,
						file.id,
					)) ?? defaultFileAssetSettings)
				: defaultFileAssetSettings
		const headers = new Headers({
			'Content-Type': type,
			'Cache-Control': 'private, no-store',
			'Referrer-Policy': 'no-referrer',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': fileAssetPolicy(type),
			'X-Kody-File-Asset': '1',
			'Accept-Ranges': 'bytes',
		})
		const download =
			query.get('download') === 'true' ||
			settings.disposition === 'attachment' ||
			!inlineFileType(type)
		headers.set(
			'Content-Disposition',
			`${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
		)
		if (range === false) {
			headers.set('Content-Range', `bytes */${revision.bytes}`)
			return new Response(null, { status: 416, headers })
		}
		if (range)
			headers.set(
				'Content-Range',
				`bytes ${range.offset}-${range.offset + range.length - 1}/${revision.bytes}`,
			)
		headers.set('Content-Length', String(range ? range.length : revision.bytes))
		const object =
			request.method === 'HEAD'
				? null
				: await fileObjectReader(env, result.ownerId).get(
						fileBlobKey(result.ownerId, file.id, revision.id),
						range ? { range } : undefined,
					)
		if (request.method !== 'HEAD' && !object) throw new Error('Not found')
		if (signed || publicAsset) {
			headers.set('Access-Control-Allow-Origin', '*')
			headers.set(
				'Access-Control-Expose-Headers',
				'Accept-Ranges, Content-Disposition, Content-Range',
			)
		}
		if (publicAsset) {
			headers.set('Cache-Control', settings.cacheControl)
		}
		return new Response(object?.body ?? null, {
			status: range ? 206 : 200,
			headers,
		})
	} catch {
		return new Response('Shared file unavailable.', {
			status: 404,
			headers: { 'Cache-Control': 'private, no-store' },
		})
	}
}

const signedAssetPayload = z.object({
	expiresAt: z.number().int(),
	revisionId: fileIdSchema,
})

async function resolveSignedAsset(
	env: Env,
	params: z.infer<typeof scope>,
	signature: string | null,
) {
	if (
		!signature ||
		signature.length > 512 ||
		params.rootId !== params.itemId ||
		env.FILES_COLLABORATION_ENABLED === 'false'
	)
		throw new Error('File unavailable.')
	const { getOrgBySlug, isOrgActive } = await import('../../src/orgs/repo.ts')
	const { ownerIdFromStored } =
		await import('@kody-internal/shared/owner-person-ids.ts')
	const { openSignedAsset } = await import('../../src/files/public-links.ts')
	const { fileStoreRpc } = await import('../../src/files/client.ts')
	const { fileLinkEnabled } = await import('../../src/files/feature.ts')
	const org = await getOrgBySlug(env.APP_DB, params.orgSlug)
	if (
		!org ||
		!(await isOrgActive(env.APP_DB, org.id)) ||
		!(await fileLinkEnabled(env, org.id))
	)
		throw new Error('File unavailable.')
	const ownerId = ownerIdFromStored(org.id)
	const payload = signedAssetPayload.parse(
		JSON.parse(await openSignedAsset(env, ownerId, params.itemId, signature)),
	)
	if (payload.expiresAt <= Date.now()) throw new Error('File unavailable.')
	const store = fileStoreRpc(env, ownerId)
	const { loadFileAncestors } = await import('../../src/files/tree-access.ts')
	const ancestors = await loadFileAncestors(
		(id) => store.metadata(ownerId, id),
		params.itemId,
	)
	const file = ancestors.get(params.itemId)
	if (!file || [...ancestors.values()].some((ancestor) => ancestor.trashedAt))
		throw new Error('File unavailable.')
	const revision = await store.revision(ownerId, file.id, payload.revisionId)
	if (!revision) throw new Error('File unavailable.')
	return {
		ownerId,
		file: { ...file, revisionId: revision.id, revisions: [revision] },
	}
}
