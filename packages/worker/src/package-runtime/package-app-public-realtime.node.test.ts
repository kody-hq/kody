import { expect, test } from 'vitest'
import { packageAppDefinitionSchema } from '#worker/package-registry/types.ts'
import {
	decidePublicRealtimeAccess,
	hashRealtimeClientIp,
	publicRealtimeNotOptedInMessage,
	publicRealtimeUnapprovedMessage,
} from './package-app-public-realtime.ts'

const approved = 'commit-approved'

test('public realtime is off unless an internet-visible app opts in', () => {
	for (const input of [
		{ isInternetVisible: true, mode: null },
		{ isInternetVisible: false, mode: 'receive' as const },
		{ isInternetVisible: false, mode: 'two-way' as const },
	]) {
		expect(
			decidePublicRealtimeAccess({
				...input,
				approvedPublishedCommit: approved,
				publishedCommit: approved,
			}),
		).toEqual({ ok: false, message: publicRealtimeNotOptedInMessage })
	}
	expect(publicRealtimeNotOptedInMessage).not.toMatch(/sign in/i)
})

test('public realtime runs only the commit the owner approved', () => {
	for (const pin of [
		{ approvedPublishedCommit: null, publishedCommit: approved },
		{ approvedPublishedCommit: approved, publishedCommit: 'commit-newer' },
		{ approvedPublishedCommit: approved, publishedCommit: null },
	]) {
		expect(
			decidePublicRealtimeAccess({
				isInternetVisible: true,
				mode: 'two-way',
				...pin,
			}),
		).toEqual({ ok: false, message: publicRealtimeUnapprovedMessage })
	}
	expect(
		decidePublicRealtimeAccess({
			isInternetVisible: true,
			mode: 'receive',
			approvedPublishedCommit: approved,
			publishedCommit: approved,
		}),
	).toEqual({ ok: true, mode: 'receive', approvedCommit: approved })
})

test('the client IP is hashed per app and never stored raw', async () => {
	const request = (ip: string) =>
		new Request('https://example.com/ws', {
			headers: { 'CF-Connecting-IP': ip },
		})
	const first = await hashRealtimeClientIp({
		packageId: 'pkg-1',
		request: request('203.0.113.7'),
	})
	expect(first).toMatch(/^[0-9a-f]{32}$/)
	expect(first).not.toContain('203')
	await expect(
		hashRealtimeClientIp({
			packageId: 'pkg-1',
			request: request('203.0.113.7'),
		}),
	).resolves.toBe(first)
	await expect(
		hashRealtimeClientIp({
			packageId: 'pkg-2',
			request: request('203.0.113.7'),
		}),
	).resolves.not.toBe(first)
	await expect(
		hashRealtimeClientIp({
			packageId: 'pkg-1',
			request: request('203.0.113.8'),
		}),
	).resolves.not.toBe(first)
})

test('kody.app.realtime.anonymous accepts only receive or two-way', () => {
	const parse = (realtime: unknown) =>
		packageAppDefinitionSchema.safeParse({ entry: 'app.ts', realtime }).success
	expect(parse(undefined)).toBe(true)
	expect(parse({})).toBe(true)
	expect(parse({ anonymous: 'receive' })).toBe(true)
	expect(parse({ anonymous: 'two-way' })).toBe(true)
	expect(parse({ anonymous: true })).toBe(false)
	expect(parse({ anonymous: 'send' })).toBe(false)
	expect(parse({ anonymous: 'receive', extra: 1 })).toBe(false)
})
