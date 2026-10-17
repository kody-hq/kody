import { createFileRoute } from '@tanstack/react-router'
import { accountRepoIconHttp } from '#start/server/protocol-handlers'
export const Route = createFileRoute(
	'/account_/repos_/$repoId_/icon_/$iconCommit',
)({ server: { handlers: { GET: accountRepoIconHttp } } })
