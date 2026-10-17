import { createFileRoute } from '@tanstack/react-router'
import { orgAvatarHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/orgs_/$orgSlug_/avatar_/$file')({
	server: {
		handlers: {
			GET: ({ request, params }) => {
				const match = /^(.+)\.([^.]+)$/.exec(params.file)
				if (!match) return new Response(null, { status: 404 })
				return orgAvatarHttp({
					request,
					params: { ...params, hash: match[1]!, ext: match[2]! },
				})
			},
		},
	},
})
