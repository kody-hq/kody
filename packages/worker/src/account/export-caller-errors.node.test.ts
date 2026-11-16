import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { toApiError } from '#worker/open-api/errors.ts'
import {
	createAccountExportManifest,
	readAccountExportSection,
} from './export.ts'
import {
	createMigratedDbWithUser,
	createStubNamespace,
} from '#worker/test-support/account-export.ts'

type SectionInput = Parameters<typeof readAccountExportSection>[0]

function createEnv() {
	const { db } = createMigratedDbWithUser()
	return {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		RUN_LOG: createStubNamespace({ listStorageIds: async () => [] }),
	} as unknown as Env
}

async function readSectionError(
	input: Omit<SectionInput, 'env' | 'dbUserId' | 'mcpUserId'>,
) {
	const error = await readAccountExportSection({
		env: createEnv(),
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
		...input,
	}).then(
		() => null,
		(cause: unknown) => cause,
	)
	expect(error).toBeInstanceOf(McpCallerError)
	return error as McpCallerError
}

test('d1_table with a section name tells the caller to read that section', async () => {
	const error = await readSectionError({
		section: 'd1_table',
		table: 'artifact_repos',
	})
	expect(error.message).toBe(
		'"artifact_repos" is an account export section, not a D1 table. Call accountExportSection with section: "artifact_repos" instead of section: "d1_table".',
	)
	const apiError = toApiError(error)
	expect(apiError.status).toBe(400)
	expect(apiError.message).toBe(error.message)
})

test('d1_table with the storage_runners manifest key points at storage id discovery', async () => {
	const error = await readSectionError({
		section: 'd1_table',
		table: 'storage_runners',
	})
	expect(error.message).toContain(
		'Call accountExportSection with section: "durable_object_summaries", kind: "storage_runner"',
	)
})

test('d1_table with a d1.-prefixed manifest key names the bare table', async () => {
	const error = await readSectionError({
		section: 'd1_table',
		table: 'd1.mcp_memories',
	})
	expect(error.message).toBe(
		'Table "d1.mcp_memories" is a manifest key, not a table name. Call accountExportSection with section: "d1_table", table: "mcp_memories".',
	)
})

test('d1_table with an unknown or missing table points to the manifest table keys', async () => {
	const unknown = await readSectionError({
		section: 'd1_table',
		table: 'not_a_table',
	})
	expect(unknown.message).toMatch(
		/^Table "not_a_table" is not part of account export\. Exportable tables are the "d1\.<table>" keys/,
	)
	const missing = await readSectionError({ section: 'd1_table' })
	expect(missing.message).toMatch(
		/^table is required when section is d1_table\. Exportable tables are the "d1\.<table>" keys/,
	)
})

test('storage_runner caller mistakes are caller errors with a discovery hint', async () => {
	const missing = await readSectionError({ section: 'storage_runner' })
	expect(missing.message).toBe(
		'storage_id is required when section is storage_runner. List storage ids with accountExportSection with section: "durable_object_summaries" and kind: "storage_runner".',
	)
	const notFound = await readSectionError({
		section: 'storage_runner',
		storageId: 'exec:not-mine',
	})
	expect(notFound.message).toMatch(
		/^Storage runner "exec:not-mine" was not found for account export\./,
	)
	expect(toApiError(notFound).status).toBe(404)
})

test('durable_object_summaries rejects a missing kind and malformed cursors as caller errors', async () => {
	const missingKind = await readSectionError({
		section: 'durable_object_summaries',
	})
	expect(missingKind.message).toMatch(
		/^kind is required when section is durable_object_summaries\./,
	)
	for (const startAfter of ['{not json', 'null', '[]', '{"stage":"bogus"}']) {
		const malformed = await readSectionError({
			section: 'durable_object_summaries',
			kind: 'storage_runner',
			startAfter,
		})
		expect(malformed.message).toMatch(
			/^start_after is not a durable_object_summaries cursor\./,
		)
	}
})

test('r2_object rejects an unreadable cursor as a caller error', async () => {
	const error = await readSectionError({
		section: 'r2_object',
		startAfter: 'garbage',
	})
	expect(error.message).toContain(
		'restart the r2_object section without start_after',
	)
})

test('every manifest section names the accountExportSection arguments that read it', async () => {
	const manifest = await createAccountExportManifest({
		env: createEnv(),
		dbUserId: 1,
		mcpUserId: ownerIdFromStored('user-aaa'),
	})
	const sections = Object.entries(manifest.sections)
	expect(sections.length).toBeGreaterThan(0)
	for (const [key, section] of sections) {
		if (key.startsWith('d1.')) {
			expect(section.discovery).toEqual({
				section: 'd1_table',
				table: key.slice('d1.'.length),
			})
		} else {
			expect({ key, discovery: section.discovery }).toEqual({
				key,
				discovery: expect.objectContaining({ section: expect.any(String) }),
			})
		}
	}
	expect(manifest.sections.artifact_repos?.discovery).toEqual({
		section: 'artifact_repos',
	})
	expect(manifest.sections.kv_keys?.discovery).toEqual({ section: 'kv_keys' })
	expect(manifest.sections.oauth_grants?.discovery).toEqual({
		section: 'oauth_grants',
	})
})
