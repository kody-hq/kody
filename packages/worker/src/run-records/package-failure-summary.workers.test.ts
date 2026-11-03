import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { finishRunRecord, summarizePackageFailures } from './service.ts'
import type { RunRecordContext } from './types.ts'

const windowStartMs = Date.parse('2026-10-11T02:51:00.000Z')
const minuteMs = 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

const headerRefusal =
	'Secret "token" is in the request query. The fetch gateway substitutes a secret only into a request header, never the URL, query, or body. Send it in a header instead. (credential_placement_refused, slot "token")'
const bodyRefusal =
	'Secret "token" is in the request body. The fetch gateway never substitutes a secret into a request body, and it will not send an unsubstituted placeholder upstream.'
const plainHttpRefusal =
	'Secret "token" cannot be sent to host "api.example.com" over plain HTTP. The fetch gateway fills secrets only over HTTPS. Use an https:// URL. (credential_placement_refused, slot "token")'

async function recordFailure(input: {
	userId: OwnerId
	startedAtMs: number
	message: string
	packageId?: string | null
	status?: 'error' | 'success'
}) {
	const context: RunRecordContext = {
		surface: 'export',
		name: 'secret-run-name',
		packageId: input.packageId ?? null,
	}
	await finishRunRecord({
		env,
		handle: {
			id: crypto.randomUUID(),
			userId: input.userId,
			startedAt: iso(input.startedAtMs),
			persistence: 'eager',
			context,
		},
		status: input.status ?? 'error',
		error: input.status === 'success' ? undefined : new Error(input.message),
	})
}

test('summarizePackageFailures counts header-only refusals and flagged failures without returning messages', async () => {
	const userId = ownerIdFromStored(`placement-failures-${crypto.randomUUID()}`)
	await recordFailure({
		userId,
		packageId: 'pkg-refused',
		startedAtMs: windowStartMs + minuteMs,
		message: headerRefusal,
	})
	await recordFailure({
		userId,
		packageId: 'pkg-refused',
		startedAtMs: windowStartMs + 5 * minuteMs,
		message: bodyRefusal,
	})
	await recordFailure({
		userId,
		packageId: 'pkg-refused',
		startedAtMs: windowStartMs - minuteMs,
		message: headerRefusal,
	})
	await recordFailure({
		userId,
		packageId: 'pkg-http',
		startedAtMs: windowStartMs + 2 * minuteMs,
		message: plainHttpRefusal,
	})
	await recordFailure({
		userId,
		packageId: 'pkg-flagged',
		startedAtMs: windowStartMs + 3 * minuteMs,
		message: 'Bluesky returned 401 for {{secret:appPassword}}',
	})
	await recordFailure({
		userId,
		packageId: 'pkg-flagged',
		startedAtMs: windowStartMs + 4 * minuteMs,
		message: '',
		status: 'success',
	})
	await recordFailure({
		userId,
		packageId: null,
		startedAtMs: windowStartMs + 6 * minuteMs,
		message: headerRefusal,
	})

	const summary = await summarizePackageFailures({
		env,
		userId,
		window: {
			since: iso(windowStartMs),
			until: iso(windowStartMs + 60 * minuteMs),
			packageIds: ['pkg-flagged', 'pkg-quiet'],
		},
	})

	const byPackage = new Map(summary.packages.map((row) => [row.packageId, row]))
	expect(byPackage.get('pkg-refused')).toEqual({
		packageId: 'pkg-refused',
		placementRefusals: {
			count: 2,
			firstAt: iso(windowStartMs + minuteMs),
			lastAt: iso(windowStartMs + 5 * minuteMs),
		},
		failedRuns: null,
	})
	expect(byPackage.get('pkg-flagged')).toEqual({
		packageId: 'pkg-flagged',
		placementRefusals: { count: 0, firstAt: null, lastAt: null },
		failedRuns: {
			count: 1,
			firstAt: iso(windowStartMs + 3 * minuteMs),
			lastAt: iso(windowStartMs + 3 * minuteMs),
		},
	})
	expect(byPackage.get(null)?.placementRefusals.count).toBe(1)
	expect(byPackage.has('pkg-http')).toBe(false)
	expect(byPackage.has('pkg-quiet')).toBe(false)
	expect(JSON.stringify(summary)).not.toMatch(
		/secret|Bluesky|fetch gateway|token/,
	)
})
