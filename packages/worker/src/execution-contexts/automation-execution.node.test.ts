import { expect, test } from 'vitest'
import {
	automationExecutionSchema,
	automationQueueDefaultMinutes,
	automationQueueExpiresAt,
	automationQueueMaxMinutes,
	parseAutomationExecution,
} from './automation-execution-schema.ts'
import {
	automationTargetId,
	exportKeyForPath,
	packageExportSpecifier,
} from './automation-settings.ts'

test('execution setting mirrors execute routing rules', () => {
	expect(
		automationExecutionSchema.safeParse({ context: 'studio' }).success,
	).toBe(true)
	expect(
		automationExecutionSchema.safeParse({ chain: ['a', 'b', 'c', 'cloud'] })
			.success,
	).toBe(true)
	for (const bad of [
		{},
		{ fallback: 'chain' },
		{ chain: ['cloud', 'a'] },
		{ chain: ['a', 'a'] },
		{ chain: ['a', 'b', 'c', 'd'] },
		{ context: 'a', queueMinutes: 5 },
		{
			context: 'a',
			whenOffline: 'queue',
			queueMinutes: automationQueueMaxMinutes + 1,
		},
		{ context: 'a', requires: ['gpu'] },
		{ context: 'a', extra: true },
	]) {
		expect(automationExecutionSchema.safeParse(bad).success).toBe(false)
	}
	expect(parseAutomationExecution({ chain: ['cloud', 'a'] })).toBe(null)
})

test('queue expiry defaults to an hour', () => {
	const now = 1_000_000
	expect(
		automationQueueExpiresAt({ context: 'a', whenOffline: 'queue' }, now),
	).toBe(now + automationQueueDefaultMinutes * 60_000)
	expect(
		automationQueueExpiresAt(
			{ context: 'a', whenOffline: 'queue', queueMinutes: 5 },
			now,
		),
	).toBe(now + 5 * 60_000)
})

test('maps declared handler paths to importable package exports', () => {
	const exports = {
		'.': './src/index.ts',
		'./sync': { import: './src/sync.ts' },
	}
	expect(exportKeyForPath(exports, 'src/sync.ts')).toBe('./sync')
	expect(exportKeyForPath(exports, './src/missing.ts')).toBe(null)
	expect(packageExportSpecifier('@me/pkg', './sync')).toBe('kody:@me/pkg/sync')
	expect(packageExportSpecifier('@me/pkg', '.')).toBe('kody:@me/pkg')
	expect(automationTargetId({ kind: 'job', jobId: 'job-1' })).toBe('job-1')
})
