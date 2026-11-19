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
	expect(error.message).toContain('"artifact_repos"')
	expect(error.message).toContain('section: "artifact_repos"')
	expect(error.message).toContain('section: "d1_table"')
	expect(toApiError(error).status).toBe(400)
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
	expect(error.message).toContain('"d1.mcp_memories"')
	expect(error.message).toContain('table: "mcp_memories"')
	expect(error.message).not.toContain('table: "d1.mcp_memories"')
})

test('d1_table with an unknown or missing table points to the manifest table keys', async () => {
	const unknown = await readSectionError({
		section: 'd1_table',
		table: 'not_a_table',
	})
	expect(unknown.message).toContain('"not_a_table"')
	expect(unknown.message).toContain('d1.<table>')
	const missing = await readSectionError({ section: 'd1_table' })
	expect(missing.message).toContain('table is required')
	expect(missing.message).toContain('d1_table')
	expect(missing.message).toContain('d1.<table>')
})

test('storage_runner caller mistakes are caller errors with a discovery hint', async () => {
	const missing = await readSectionError({ section: 'storage_runner' })
	expect(missing.message).toContain('storage_id is required')
	expect(missing.message).toContain('section: "durable_object_summaries"')
	expect(missing.message).toContain('kind: "storage_runner"')
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
			continue
		}
		// Most non-D1 keys are the section name. storage_runners is the
		// exception: it is listed by durable_object_summaries.
		expect({ key, discovery: section.discovery }).toEqual({
			key,
			discovery:
				key === 'storage_runners'
					? { section: 'durable_object_summaries', kind: 'storage_runner' }
					: { section: key },
		})
	}
})
