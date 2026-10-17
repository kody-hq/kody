import { redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { orgSectionRestPath } from '#universal/org-section-hrefs.ts'

export const loadMcpServerAuthorizePage = createServerFn({ method: 'GET' })
	.validator(
		z.object({
			orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/),
			serverId: z
				.string()
				.min(1)
				.refine(
					(value) => !/[\\/]/.test(value) && value !== '.' && value !== '..',
				),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ loadPersonalCollection },
			{ setResponseStatus },
			{ loadMcpServerAuthorizeData },
			{ loadDocumentHead },
		] = await Promise.all([
			import('./collection-context.ts'),
			import('@tanstack/react-start/server'),
			import('../../src/app/handlers/org-mcp-server-authorize.ts'),
			import('./document-head.ts'),
		])
		const pathname = orgSectionRestPath(
			data.orgSlug,
			'mcp-servers',
			`${data.serverId}/authorize`,
		)
		const { bindings, request } = await loadPersonalCollection(pathname)
		const result = await loadMcpServerAuthorizeData({
			env: bindings,
			request,
			params: data,
		})
		if (result.kind === 'signed-out')
			throw redirect({
				href: `/login?redirectTo=${encodeURIComponent(pathname)}`,
			})
		if (result.kind !== 'ready') {
			// Authentication is enforced above using the incoming request, including
			// session-cookie cleanup. The domain repeats authorization independently.
			setResponseStatus(result.kind === 'forbidden' ? 403 : 404)
			return {
				payload: null,
				error: result.title,
				head: loadDocumentHead('orgMcpServers', pathname, {}),
			}
		}
		return {
			payload: result.payload,
			error: null,
			head: loadDocumentHead('orgMcpServers', pathname, {
				mcpServerAuthorize: result.payload,
			}),
		}
	})
