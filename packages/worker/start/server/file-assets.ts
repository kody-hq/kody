import { detectFileMediaType } from '#universal/file-viewers.ts'
import { getRequest } from '@tanstack/react-start/server'
import { fileIdSchema } from '#universal/files.ts'
import { fileAssetPolicy, inlineFileType } from '#universal/file-assets.ts'
import { withWebsiteRead } from './mutation-context.ts'
import { websiteCapabilityContext } from '../../src/app/website-capability.ts'
import { fileCollaborationEnabled } from '../../src/files/feature.ts'
import { getFileAsset } from '../../src/files/service.ts'
export async function fileAssetHttp({
	params,
}: {
	params: { orgSlug: string; fileId: string }
}) {
	const request = getRequest(),
		url = new URL(request.url)
	const id = fileIdSchema.safeParse(params.fileId),
		revision = fileIdSchema
			.optional()
			.safeParse(url.searchParams.get('revision') ?? undefined)
	if (
		!id.success ||
		!revision.success ||
		!/^[a-zA-Z0-9_-]+$/.test(params.orgSlug)
	)
		return new Response('Not found', { status: 404 })
	try {
		return await withWebsiteRead(
			{ scope: { orgSlug: params.orgSlug, requireMembership: false } },
			async (context) => {
				if (
					!(await fileCollaborationEnabled(context.env, context.user.request))
				)
					return new Response('File unavailable', {
						status: 404,
						headers: { 'Cache-Control': 'private, no-store' },
					})
				const ctx = websiteCapabilityContext(context)

				const {
					file,
					revision: current,
					range,
					object,
				} = await getFileAsset(
					ctx,
					id.data,
					revision.data,
					request.headers.get('Range'),
					request.method === 'HEAD',
				)
				const type = detectFileMediaType(file.name, file.mediaType)

				const headers = new Headers({
					'Content-Type': type,
					'Cache-Control': 'private, no-store',
					'Accept-Ranges': 'bytes',
					'X-Content-Type-Options': 'nosniff',
					'Content-Security-Policy': fileAssetPolicy(type),
					'X-Frame-Options': 'SAMEORIGIN',
					'X-Kody-File-Asset': '1',
					'Referrer-Policy': 'no-referrer',
				})

				headers.set(
					'Content-Disposition',
					`${url.searchParams.get('download') === 'true' || !inlineFileType(type) ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", '%27')}`,
				)
				if (range === false) {
					headers.set('Content-Range', `bytes */${current.bytes}`)
					return new Response(null, { status: 416, headers })
				}
				const length = range ? range.length : current.bytes
				headers.set('Content-Length', String(length))
				if (range)
					headers.set(
						'Content-Range',
						`bytes ${range.offset}-${range.offset + range.length - 1}/${current.bytes}`,
					)
				const body = request.method === 'HEAD' ? null : object!.body
				return new Response(body, { status: range ? 206 : 200, headers })
			},
		)
	} catch {
		return new Response('File unavailable', {
			status: 404,
			headers: { 'Cache-Control': 'private, no-store' },
		})
	}
}
