import { createFileRoute } from '@tanstack/react-router'
import { accountMcpServerLogoHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute('/account_/mcp-servers_/logos_/$serverId')(
	{
		staticData: { documentNavigation: true },
		server: { handlers: { GET: accountMcpServerLogoHttp } },
	},
)
