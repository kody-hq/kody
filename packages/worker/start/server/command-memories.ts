import { createServerOnlyFn } from '@tanstack/react-start'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { loadScopedCollection } from './collection-context.ts'
import { searchMemoryMetadata } from '#mcp/memory/repo.ts'

export const loadCommandMemories = createServerOnlyFn(
	async (orgSlug: string, query: string, preferredIds: string[]) => {
		const { bindings, user } = await loadScopedCollection({
			orgSlug,
			section: 'memories',
			returnTo: `/@${orgSlug}/-/memories`,
		})
		const ownerId = ownerIdFromCaller({
			request: user.request,
			user: user.mcpUser,
		})
		return searchMemoryMetadata(bindings.APP_DB, ownerId, query, preferredIds)
	},
)
