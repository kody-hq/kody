import { expect, test } from 'vitest'
import {
	applyServerTimingHeader,
	formatServerTimingHeader,
	parseServerTimingHeader,
	recordServerTimingPhase,
	type ServerTimingEntry,
	unaccountedServerTimingMs,
} from './server-timing.ts'

test('format and parse Server-Timing keep page phases and quoted desc', () => {
	const header = formatServerTimingHeader([
		{ name: 'session', durationMs: 12.4 },
		{ name: 'highlight', durationMs: 45.6, desc: 'hit' },
		{ name: 'code-runs', durationMs: 3 },
		{ name: 'not a token', durationMs: 1 },
		{ name: 'ssr', durationMs: -2 },
	])
	expect(header).toBe(
		'session;dur=12, highlight;dur=46;desc="hit", code-runs;dur=3, ssr;dur=0',
	)
	expect(parseServerTimingHeader(header)).toEqual([
		{ name: 'session', durationMs: 12 },
		{ name: 'highlight', durationMs: 46, desc: 'hit' },
		{ name: 'code-runs', durationMs: 3 },
		{ name: 'ssr', durationMs: 0 },
	])
	expect(
		parseServerTimingHeader('cfEdge;dur=9, highlight;dur=20;desc=worker'),
	).toEqual([
		{ name: 'cfEdge', durationMs: 9 },
		{ name: 'highlight', durationMs: 20, desc: 'worker' },
	])
	expect(parseServerTimingHeader(null)).toEqual([])
	expect(
		parseServerTimingHeader('highlight;dur=20;desc="hit;miss", session;dur=1'),
	).toEqual([
		{ name: 'highlight', durationMs: 20, desc: 'hit;miss' },
		{ name: 'session', durationMs: 1 },
	])
	expect(
		parseServerTimingHeader('highlight;dur=20;desc="say \\"hi\\""'),
	).toEqual([{ name: 'highlight', durationMs: 20, desc: 'say "hi"' }])
})

test('applyServerTimingHeader appends to an existing header', () => {
	const headers = new Headers({ 'Server-Timing': 'cfEdge;dur=4' })
	applyServerTimingHeader(headers, [
		{ name: 'session', durationMs: 8 },
		{ name: 'ssr', durationMs: 11 },
	])
	expect(headers.get('Server-Timing')).toBe(
		'cfEdge;dur=4, session;dur=8, ssr;dur=11',
	)
	applyServerTimingHeader(headers, [])
	expect(headers.get('Server-Timing')).toBe(
		'cfEdge;dur=4, session;dur=8, ssr;dur=11',
	)
})

test('unaccounted time is the request window no phase interval covers', () => {
	const timings: Array<ServerTimingEntry> = []
	// Nested and concurrent phases overlap; markers carry no interval.
	recordServerTimingPhase(timings, { name: 'pre', startedAt: 0, endedAt: 10 })
	recordServerTimingPhase(timings, { name: 'a', startedAt: 30, endedAt: 80 })
	recordServerTimingPhase(timings, { name: 'b', startedAt: 40, endedAt: 60 })
	recordServerTimingPhase(timings, { name: 'c', startedAt: 70, endedAt: 90 })
	timings.push({ name: 'appBuild', durationMs: 500, desc: 'cached' })
	// Phase time outside the window does not count.
	recordServerTimingPhase(timings, { name: 'd', startedAt: 95, endedAt: 130 })

	expect(
		unaccountedServerTimingMs(timings, { startedAt: 0, endedAt: 100 }),
	).toBe(25)
	expect(unaccountedServerTimingMs([], { startedAt: 5, endedAt: 5 })).toBe(0)
})
