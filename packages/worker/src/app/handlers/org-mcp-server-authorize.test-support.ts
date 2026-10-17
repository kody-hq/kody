import { operationResult } from '#app/operation-result.ts'
import { type McpServerAuthorizeContinueResponse } from '#universal/loader-data.ts'
import {
	continueMcpServerAuthorization,
	isConsentRefusal,
	loadConsentContext,
	refusalStatus,
} from './org-mcp-server-authorize.ts'
export * from './org-mcp-server-authorize.ts'
export function testOrgMcpServerAuthorizePostHandler(env: Env) {
	function respond(body: McpServerAuthorizeContinueResponse, status = 200) {
		return operationResult(body, {
			status,
			headers: { 'Cache-Control': 'private, no-store' },
		})
	}
	return {
		async execute({
			request,
			params,
		}: {
			request: Request
			params: { orgSlug: string; serverId: string }
		}) {
			const context = await loadConsentContext({ env, request, params })
			if (isConsentRefusal(context)) {
				return respond(
					{
						ok: false,
						error:
							context.kind === 'signed-out'
								? 'Sign in to Kody, then open this page again.'
								: context.title,
						consent: null,
					},
					refusalStatus(context),
				)
			}
			const form = await request.formData().catch(() => null)
			const token = form?.get('_csrf')
			const result = await continueMcpServerAuthorization({
				env,
				context,
				token,
			})
			return respond(result.data, result.status)
		},
	}
}
