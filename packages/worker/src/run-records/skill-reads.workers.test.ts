import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { runLogRpc, exportRunRecords, clearRunRecords } from './service.ts'
import { type SkillReadEvent } from '#universal/skill-metrics.ts'

function event(
	id: string,
	orgId: string,
	overrides: Partial<SkillReadEvent> = {},
): SkillReadEvent {
	return {
		id,
		orgId,
		occurredAt: new Date().toISOString(),
		actorId: 'person-1',
		actorUsername: 'jane',
		attribution: { kind: 'user', userId: 'person-1' },
		credentialKind: 'mcp-oauth',
		connectionId: 'connection-1',
		clientId: 'client-1',
		channel: 'mcp-resource',
		packageId: 'package-1',
		packageName: '@team/docs',
		packageOwnerId: orgId,
		publishedCommit: 'commit-1',
		skillName: 'writing',
		skillUri: 'skill://team/docs/writing/SKILL.md',
		filePath: 'skills/writing/SKILL.md',
		digest: 'sha256:test',
		kind: 'instructions',
		...overrides,
	}
}

test('skill reads deduplicate retries, preserve attribution, isolate organizations and filter package access', async () => {
	const userId = ownerIdFromStored(`skill-reads-${crypto.randomUUID()}`)
	const otherId = ownerIdFromStored(`skill-reads-${crypto.randomUUID()}`)
	const log = runLogRpc({ env, userId })
	const first = event('a', userId)
	await log.recordSkillRead(first)
	await log.recordSkillRead(first)
	await log.recordSkillRead(
		event('b', userId, {
			actorId: 'person-2',
			kind: 'supporting-file',
			filePath: 'skills/writing/references/a.md',
		}),
	)
	await log.recordSkillRead(
		event('c', userId, {
			actorId: null,
			attribution: {
				kind: 'automation',
				source: 'schedule',
				sourceId: 'schedule-1',
			},
		}),
	)
	await log.recordSkillRead(event('d', userId, { packageId: 'denied' }))
	await log.recordSkillRead(
		event('old', userId, { occurredAt: '2000-01-01T00:00:00.000Z' }),
	)
	await runLogRpc({ env, userId: otherId }).recordSkillRead(
		event('other', otherId),
	)
	const input = { since: '2026-01-01T00:00:00.000Z', packageIds: ['package-1'] }
	const summary = await log.skillReadSummary(input)
	expect(summary).toMatchObject({
		instructionReads: 2,
		supportingFileReads: 1,
		readers: 2,
	})
	expect(summary.dailyReads).toEqual([
		{ day: first.occurredAt.slice(0, 10), skillUri: first.skillUri, reads: 2 },
	])
	expect(summary.skillActivity).toEqual([
		{ uri: first.skillUri, reads: 2, lastRead: expect.any(String) },
	])
	expect(summary.topSkills).toEqual([
		{
			uri: first.skillUri,
			name: 'writing',
			packageName: '@team/docs',
			reads: 2,
		},
	])
	expect(summary.recentReads.find((row) => row.id === 'a')).toEqual(first)
	expect(
		await log.skillReadSummary({ ...input, packageIds: [] }),
	).toMatchObject({ instructionReads: 0, readers: 0, recentReads: [] })
	const exported: SkillReadEvent[] = []
	let cursor: string | undefined
	do {
		const page = await exportRunRecords({
			env,
			userId,
			startAfter: cursor,
			pageSize: 2,
		})
		exported.push(...page.skillReads)
		cursor = page.nextStartAfter ?? undefined
	} while (cursor)
	expect(exported.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd', 'old'])
	await clearRunRecords({ env, userId })
	expect((await log.skillReadSummary(input)).instructionReads).toBe(0)
	expect(
		(await runLogRpc({ env, userId: otherId }).skillReadSummary(input))
			.instructionReads,
	).toBe(1)
})

test('daily skill stacks retain all instruction reads with the remainder grouped as Other', async () => {
	const userId = ownerIdFromStored(`skill-stacks-${crypto.randomUUID()}`)
	const log = runLogRpc({ env, userId })
	for (let index = 0; index < 7; index++) {
		await log.recordSkillRead(
			event(`skill-${index}`, userId, {
				occurredAt: '2026-10-26T12:00:00.000Z',
				skillUri: `skill://team/docs/skill-${index}/SKILL.md`,
				skillName: `skill-${index}`,
			}),
		)
	}
	await log.recordSkillRead(
		event('support', userId, {
			kind: 'supporting-file',
			occurredAt: '2026-10-27T12:00:00.000Z',
		}),
	)
	const summary = await log.skillReadSummary({
		since: '2026-10-01T00:00:00.000Z',
		packageIds: ['package-1'],
	})
	expect(summary.dailyReads).toHaveLength(6)
	expect(summary.dailyReads.find((row) => row.skillUri === null)).toEqual({
		day: '2026-10-26',
		skillUri: null,
		reads: 2,
	})
	expect(summary.dailyReads.reduce((total, row) => total + row.reads, 0)).toBe(
		summary.instructionReads,
	)
	expect(
		summary.dailyReads
			.filter((row) => row.skillUri !== null)
			.map((row) => row.skillUri)
			.sort(),
	).toEqual(summary.topSkills.map((skill) => skill.uri).sort())
})
