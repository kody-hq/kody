import { runD1WithRetry } from '#worker/d1-retry.ts'
import { parseMcpCallerContext, type McpServerProps } from './context.ts'

export type McpAgentSession = {
	doId: string
}

export async function registerMcpAgentSession(input: {
	db: D1Database
	userId: string
	/** Org this MCP session is bound to. Defaults to the personal org. */
	orgId?: string
	doId: string
}) {
	const orgId = input.orgId?.trim() || input.userId
	await runD1WithRetry(async () => {
		await input.db
			.prepare(
				`INSERT INTO mcp_agent_sessions (do_id, user_id, org_id)
				VALUES (?, ?, ?)
				ON CONFLICT(do_id) DO NOTHING`,
			)
			.bind(input.doId, input.userId, orgId)
			.run()
		const owned = await input.db
			.prepare(
				`SELECT 1 AS owned FROM mcp_agent_sessions
				WHERE do_id = ? AND user_id = ?`,
			)
			.bind(input.doId, input.userId)
			.first<{ owned: number }>()
		if (owned?.owned !== 1) {
			throw new Error('MCP agent session Durable Object ownership conflict.')
		}
	})
}

export async function listMcpAgentSessionsForUser(
	db: D1Database,
	userId: string,
) {
	const rows = await db
		.prepare(
			`SELECT do_id FROM mcp_agent_sessions
			WHERE user_id = ?
			ORDER BY do_id`,
		)
		.bind(userId)
		.all<{ do_id: string }>()
	return (rows.results ?? []).map((row) => ({ doId: row.do_id }))
}

export async function readPersistedMcpAgentOwner(input: {
	storage: Pick<DurableObjectStorage, 'get'>
	doId: string
}) {
	const props = await input.storage.get<McpServerProps>('props')
	return {
		doId: input.doId,
		userId: props
			? (parseMcpCallerContext(props, { kind: 'mcp-oauth' }).user?.userId ??
				null)
			: null,
	}
}

export async function purgePersistedMcpAgentSession(input: {
	storage: Pick<DurableObjectStorage, 'get' | 'deleteAll'>
	doId: string
	userId: string
}) {
	const owner = await readPersistedMcpAgentOwner(input)
	// A prior deletion attempt may have already wiped this Durable Object while
	// leaving the mcp_agent_sessions registry row. No persisted owner means
	// nothing left to steal; deleteAll is idempotent. Only reject when props
	// identify a *different* live user — that is the cross-user guard.
	if (owner.userId != null && owner.userId !== input.userId) {
		throw new Error('MCP agent session user scope mismatch.')
	}
	await input.storage.deleteAll()
}
