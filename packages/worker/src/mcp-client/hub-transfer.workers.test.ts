import { runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { mcpClientHubTransferStub } from './hub-transfer.ts'
import { mcpOAuthRefreshTokenStorageKey } from './oauth-token-recovery.ts'
import {
	openMcpOAuthStorageValue,
	sealMcpOAuthStorageValue,
} from './sealed-oauth-storage.ts'

function hubFor(userId: ReturnType<typeof ownerIdFromStored>) {
	return env.MCP_CLIENT_HUB.get(
		env.MCP_CLIENT_HUB.idFromName(mcpClientHubDurableObjectName(userId)),
	)
}

test('a server moves between hubs with its stored OAuth state', async () => {
	const fromUserId = ownerIdFromStored(`hub-from-${crypto.randomUUID()}`)
	const toUserId = ownerIdFromStored(`hub-to-${crypto.randomUUID()}`)
	const serverId = 'transfer-server'
	const tokenKey = `/Kody/${serverId}/client-1/token`
	// Seed an authorization still pending (auth_url set) so the import does not
	// dial a real MCP server.
	await hubFor(fromUserId).getSnapshot()
	await runInDurableObject(hubFor(fromUserId), async (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO cf_agents_mcp_servers
				(id, name, server_url, callback_url, client_id, auth_url, server_options)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			serverId,
			'Transfer Server',
			'https://mcp.example.com/mcp',
			'https://kody.example.com/mcp-oauth/callback',
			'client-1',
			'https://auth.example.com/authorize',
			JSON.stringify({ transport: { type: 'streamable-http' } }),
		)
		const seeded: Record<string, unknown> = {
			[tokenKey]: { access_token: 'tok', token_type: 'Bearer' },
			[mcpOAuthRefreshTokenStorageKey(serverId)]: { refresh_token: 'r' },
			'/Kody/other-server/client-2/token': { access_token: 'other' },
		}
		for (const [key, value] of Object.entries(seeded)) {
			seeded[key] = await sealMcpOAuthStorageValue({
				env,
				ownerId: state.id.name!,
				key,
				value,
			})
		}
		await state.storage.put(seeded)
	})

	const from = mcpClientHubTransferStub({ env, userId: fromUserId })
	const to = mcpClientHubTransferStub({ env, userId: toUserId })
	const exported = await from.exportServerForTransfer({ serverId })
	expect(exported?.row.id).toBe(serverId)
	expect(exported?.entries.map(([key]) => key).sort()).toEqual(
		[tokenKey, mcpOAuthRefreshTokenStorageKey(serverId)].sort(),
	)

	expect(await to.listServerIdsForTransfer()).toEqual([])
	expect(await to.importServerForTransfer(exported!)).toEqual({ ok: true })
	expect(await to.listServerIdsForTransfer()).toEqual([serverId])
	// Staged, not registered: a restore before commit cannot dial it.
	await runInDurableObject(hubFor(toUserId), async (_instance, state) => {
		expect(
			state.storage.sql.exec('SELECT id FROM cf_agents_mcp_servers').toArray(),
		).toEqual([])
		// Resealed for the destination owner: ciphertext at rest, never the
		// source hub's ciphertext.
		const raw = await state.storage.get(tokenKey)
		expect(raw).toMatch(/^v2\./)
		expect(JSON.stringify(raw)).not.toContain('tok')
		expect(
			await openMcpOAuthStorageValue({
				env,
				ownerId: state.id.name!,
				key: tokenKey,
				value: raw,
			}),
		).toEqual({ access_token: 'tok', token_type: 'Bearer' })
		expect(
			await state.storage.get(mcpOAuthRefreshTokenStorageKey(serverId)),
		).toMatch(/^v2\./)
	})
	expect(await to.importServerForTransfer(exported!)).toEqual({
		ok: false,
		reason: 'already_registered',
	})

	const rollbackUserId = ownerIdFromStored(
		`hub-rollback-${crypto.randomUUID()}`,
	)
	const rolledBack = mcpClientHubTransferStub({ env, userId: rollbackUserId })
	await rolledBack.importServerForTransfer(exported!)
	await rolledBack.discardTransferredServer({ serverId })
	expect(await rolledBack.listServerIdsForTransfer()).toEqual([])
	await runInDurableObject(hubFor(rollbackUserId), async (_instance, state) => {
		expect([...(await state.storage.list()).keys()]).toEqual([])
	})

	await expect(
		to.connectTransferredServer({ serverId }),
	).resolves.toMatchObject({ serverId, state: 'authenticating' })
	expect(await to.listServerIdsForTransfer()).toEqual([serverId])
	await runInDurableObject(hubFor(toUserId), async (_instance, state) => {
		expect(
			await openMcpOAuthStorageValue({
				env,
				ownerId: state.id.name!,
				key: tokenKey,
				value: await state.storage.get(tokenKey),
			}),
		).toEqual({ access_token: 'tok', token_type: 'Bearer' })
		expect(
			state.storage.sql
				.exec('SELECT id, client_id FROM cf_agents_mcp_servers')
				.toArray(),
		).toEqual([{ id: serverId, client_id: 'client-1' }])
	})

	expect(await to.importServerForTransfer(exported!)).toEqual({
		ok: false,
		reason: 'already_registered',
	})
	const third = mcpClientHubTransferStub({
		env,
		userId: ownerIdFromStored(`hub-third-${crypto.randomUUID()}`),
	})
	expect(
		await third.importServerForTransfer({
			...exported!,
			entries: [['/Kody/other-server/client-2/token', {}]],
		}),
	).toEqual({ ok: false, reason: 'foreign_storage_key' })

	await from.removeServerForTransfer({ serverId })
	expect(await from.exportServerForTransfer({ serverId })).toBeNull()
	await runInDurableObject(hubFor(fromUserId), async (_instance, state) => {
		expect(await state.storage.get(tokenKey)).toBeUndefined()
		expect(
			await state.storage.get(mcpOAuthRefreshTokenStorageKey(serverId)),
		).toBeUndefined()
		expect(
			await openMcpOAuthStorageValue({
				env,
				ownerId: state.id.name!,
				key: '/Kody/other-server/client-2/token',
				value: await state.storage.get('/Kody/other-server/client-2/token'),
			}),
		).toEqual({ access_token: 'other' })
	})
})

test('transfer carries sealed static headers as a sidecar, never in the row', async () => {
	const userId = ownerIdFromStored(`hub-headers-${crypto.randomUUID()}`)
	const serverId = 'bearer-server'
	const bearer = 'Bearer static-secret-value'
	await hubFor(userId).getSnapshot()
	await runInDurableObject(hubFor(userId), async (_instance, state) => {
		state.storage.sql.exec(
			`INSERT INTO cf_agents_mcp_servers
				(id, name, server_url, callback_url, client_id, auth_url, server_options)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			serverId,
			'Bearer Server',
			'https://mcp.example.com/mcp',
			'https://kody.example.com/mcp-oauth/callback',
			null,
			'https://auth.example.com/authorize',
			JSON.stringify({ transport: { type: 'streamable-http' } }),
		)
		const key = `mcp-static-transport-headers/${serverId}`
		await state.storage.put(
			key,
			await sealMcpOAuthStorageValue({
				env,
				ownerId: state.id.name!,
				key,
				value: { authorization: bearer },
			}),
		)
	})
	// Transfer carries the sealed headers as a sidecar, never in the row.
	const exported = await mcpClientHubTransferStub({
		env,
		userId,
	}).exportServerForTransfer({ serverId })
	expect(exported?.row.server_options).not.toContain('static-secret-value')
	expect(exported?.entries).toContainEqual([
		`mcp-static-transport-headers/${serverId}`,
		{ authorization: bearer },
	])
})
