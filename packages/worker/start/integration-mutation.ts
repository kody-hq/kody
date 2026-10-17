import { type QueryClient } from '@tanstack/react-query'
import { type AccountIntegrationsLoaderData } from '#universal/loader-data.ts'
import { integrationListId } from './pages/account-integrations-shared.ts'
import { settleConnectionResources } from './connection-resource-settlement.ts'

export type IntegrationWrite = {
	write: () => Promise<unknown>
	actorKey: string | null
	orgSlug: string | null
	decision?: Promise<boolean>
	removeNames?: string[]
	removeApp?: string
}
export function integrationMutationOptions(client: QueryClient) {
	return {
		gcTime: 0,
		mutationFn: async ({ write, decision }: IntegrationWrite) => {
			if (decision && !(await decision)) return { undone: true }
			return write()
		},
		onSettled: (
			_data: unknown,
			_error: unknown,
			{ actorKey, orgSlug }: IntegrationWrite,
		) =>
			settleConnectionResources(client, actorKey, orgSlug, [
				'loadIntegrationsPage',
			]),
	}
}

/** Pending actions project over the latest server result. Refetches never undo
 * a visible removal, and undo/failure never restores a stale snapshot. */
export function projectIntegrationWrites(
	payload: AccountIntegrationsLoaderData,
	writes: IntegrationWrite[],
): AccountIntegrationsLoaderData {
	const names = new Set(writes.flatMap((write) => write.removeNames ?? []))
	const apps = new Set(
		writes.flatMap((write) => (write.removeApp ? [write.removeApp] : [])),
	)
	return {
		...payload,
		integrations: payload.integrations.filter(
			(entry) => !names.has(entry.name),
		),
		apps: (payload.apps ?? []).flatMap((app) => {
			if (apps.has(integrationListId(app))) return []
			const connections = app.connections.filter(
				(connection) => !names.has(connection.name),
			)
			if (connections.length === app.connections.length) return [app]
			return connections.length
				? [{ ...app, connections, connectionCount: connections.length }]
				: []
		}),
	}
}
