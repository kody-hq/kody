import { expect, test } from 'vitest'
import { accountUserDataTargets } from '#worker/account/data-targets.ts'
import {
	orgTransferRepointedTables,
	orgTransferRewrittenTables,
} from './batch.ts'
import { orgTransferSealedColumns } from './reencrypt.ts'
import {
	orgTransferBucketEntryTables,
	orgTransferOwnerTables,
} from './snapshot.ts'
import { orgTransferTables } from './tables.ts'

test('every owner-keyed account table has an org transfer decision', () => {
	const accountTables = new Set(
		accountUserDataTargets.map((target) =>
			'table' in target ? target.table : 'mcp_memory_conversation_suppressions',
		),
	)
	const missing = [...accountTables].filter(
		(table) => !(table in orgTransferTables),
	)
	expect(
		missing,
		'Classify new owner-keyed tables in org-transfer/tables.ts',
	).toEqual([])
})

test('every moved table is read, written, and re-sealed where it holds ciphertext', () => {
	const read = new Set([
		...Object.keys(orgTransferOwnerTables),
		...Object.keys(orgTransferBucketEntryTables),
	])
	const written = new Set<string>([
		...orgTransferRepointedTables,
		...orgTransferRewrittenTables,
		'saved_package_search_index_debt',
		'vector_embed_fingerprints',
	])
	const moved = Object.entries(orgTransferTables)
		.filter(([, decision]) => decision.disposition === 'move')
		.map(([table]) => table)
	expect(moved.filter((table) => !read.has(table))).toEqual([])
	expect(moved.filter((table) => !written.has(table))).toEqual([])
	for (const table of Object.keys(orgTransferSealedColumns)) {
		expect(orgTransferTables[table]?.disposition).toBe('move')
		expect(orgTransferRewrittenTables).toContain(table)
	}
})

test('email, usage, and meter data stay with the source org', () => {
	for (const table of [
		'email_inboxes',
		'email_inbox_addresses',
		'email_sender_identities',
		'usage_rollups',
		'credit_ledger_entries',
		'org_memberships',
	]) {
		expect(orgTransferTables[table]?.disposition).toBe('keep')
	}
})

test('memories stay with their owning user', () => {
	for (const table of [
		'mcp_memories',
		'mcp_memory_conversation_suppressions',
	]) {
		expect(orgTransferTables[table]).toEqual({
			disposition: 'keep',
			reason:
				'Memories are personal: they stay with their owning user and are never moved to another org.',
		})
	}
	expect(orgTransferRepointedTables).not.toContain('mcp_memories')
	expect(orgTransferRepointedTables).not.toContain(
		'mcp_memory_conversation_suppressions',
	)
})
