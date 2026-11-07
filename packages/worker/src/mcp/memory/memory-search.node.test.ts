import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import * as embedding from '#worker/vectorize/embedding.ts'
import { queryMemoryVectorIds, searchMemories } from './memory-search.ts'
import type { McpMemoryRow } from './types.ts'

function row(
	id: string,
	userId: string,
	subject: string,
	summary: string,
): McpMemoryRow {
	return {
		id,
		user_id: ownerIdFromStored(userId),
		category: 'preference',
		status: 'active',
		subject,
		summary,
		details: '',
		tags_json: '[]',
		source_uris_json: '[]',
		dedupe_key: null,
		created_at: '2026-04-20T00:00:00.000Z',
		updated_at: '2026-04-20T00:00:00.000Z',
		last_accessed_at: null,
		deleted_at: null,
	}
}

test('searchMemories fail-closes on foreign rows and keeps Vectorize misses lexical-only', async () => {
	consoleWarn.mockImplementation(() => {})
	const owned = [
		row('mem-weak', 'user-1', 'helper', 'barely related ranking noise'),
		row(
			'mem-lexical',
			'user-1',
			'inbox triage',
			'summarize inbox threads for triage',
		),
	]
	const ranked = await searchMemories({
		env: {} as Env,
		query: 'summarize inbox threads for triage',
		limit: 5,
		userId: ownerIdFromStored('user-1'),
		statuses: ['active', 'archived'],
		rows: owned,
		vectorRanked: [{ id: 'mem-weak', score: 0.5 }],
	})
	const lexicalOnly = ranked.matches.find((match) => match.id === 'mem-lexical')
	expect(lexicalOnly).toMatchObject({ id: 'mem-lexical' })
	expect(lexicalOnly).not.toHaveProperty('vectorRank')
	expect(ranked.matches.find((match) => match.id === 'mem-weak')).toMatchObject(
		{
			vectorRank: 1,
		},
	)

	const foreign = await searchMemories({
		env: {} as Env,
		query: 'summarize inbox threads for triage',
		limit: 5,
		userId: ownerIdFromStored('user-1'),
		statuses: ['active'],
		rows: [...owned, row('mem-foreign', 'user-2', 'x', 'summarize inbox')],
		vectorRanked: [{ id: 'mem-weak', score: 0.5 }],
	})
	expect(foreign.matches).toEqual([])
})

test('queryMemoryVectorIds uses a shared embedText instead of embedding the query again', async () => {
	const embedSpy = vi
		.spyOn(embedding, 'embedTextForVectorize')
		.mockRejectedValue(new Error('should not embed again'))
	const embedTexts: Array<string> = []
	const embedText = async (text: string) => {
		embedTexts.push(text)
		return [0.4, 0.5, 0.6]
	}
	const queried: Array<Array<number>> = []
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		CAPABILITY_VECTOR_INDEX: {
			async query(values: Array<number>) {
				queried.push(values)
				return { matches: [] }
			},
		},
	} as unknown as Env

	try {
		await queryMemoryVectorIds({
			env,
			query: 'summarize inbox threads',
			userId: ownerIdFromStored('user-1'),
			statuses: ['active'],
			topK: 5,
			embedText,
		})
		expect(embedSpy).not.toHaveBeenCalled()
		expect(embedTexts).toEqual(['summarize inbox threads'])
		expect(queried).toEqual([[0.4, 0.5, 0.6]])
	} finally {
		embedSpy.mockRestore()
	}
})
