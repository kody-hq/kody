import { z } from 'zod'
import { fileIdSchema } from '#universal/files.ts'
const scope = z.object({
	orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
	fileId: fileIdSchema,
})

export async function fileCollaborationHttp({
	params,
}: {
	params: { orgSlug: string; fileId: string }
}): Promise<Response> {
	const [
		{ getRequest },
		{ withWebsiteRead },
		{ websiteCapabilityContext },
		{ connectFileCollaboration },
		{ readParsedAuthSession, getAuthSessionExpiresAtMs },
	] = await Promise.all([
		import('@tanstack/react-start/server'),
		import('./mutation-context.ts'),
		import('../../src/app/website-capability.ts'),
		import('../../src/files/service.ts'),
		import('../../src/app/auth-session.ts'),
	])
	const request = getRequest(),
		url = new URL(request.url)
	if (
		request.headers.get('Upgrade')?.toLowerCase() !== 'websocket' ||
		request.headers.get('Origin') !== url.origin
	)
		return new Response('Invalid connection', { status: 403 })
	const parsed = scope
		.extend({ sessionId: fileIdSchema })
		.safeParse({ ...params, sessionId: url.searchParams.get('session') })
	if (!parsed.success) return new Response('Not found', { status: 404 })
	try {
		return await withWebsiteRead(
			{ scope: { orgSlug: params.orgSlug, requireMembership: false } },
			async (context) => {
				const parsedSession = await readParsedAuthSession(request)
				if (!parsedSession?.issuedAt) throw new Error('Session expired.')
				return connectFileCollaboration(
					websiteCapabilityContext(context),
					params.fileId,
					parsed.data.sessionId,
					{
						issuedAt: parsedSession.issuedAt,
						expiresAt: getAuthSessionExpiresAtMs({
							rememberMe: parsedSession.session.rememberMe,
							issuedAt: parsedSession.issuedAt,
						}),
					},
				)
			},
		)
	} catch {
		return new Response('File unavailable', {
			status: 403,
			headers: { 'Cache-Control': 'private, no-store' },
		})
	}
}
