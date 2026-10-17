import { createFileRoute } from '@tanstack/react-router'
import { accountMcpServersOauthCallbackHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/account_/mcp-servers_/oauth_/callback')({
	server: { handlers: { GET: accountMcpServersOauthCallbackHttp } },
})
