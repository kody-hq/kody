import { expect, test } from 'vitest'
import {
	admitWalletGuardInWindows,
	type WalletGuardCheck,
	type WalletGuardWindowStore,
} from './wallet-guard-windows.ts'

function memoryStore(): WalletGuardWindowStore {
	const rows = new Map<string, { windowStart: number; count: number }>()
	return {
		read: (bucket) => rows.get(bucket) ?? null,
		write: (bucket, windowStart, count) => {
			rows.set(bucket, { windowStart, count })
		},
	}
}

const minuteMs = 60_000
const dayMs = 24 * 60 * minuteMs
const noon = Date.parse('2026-11-17T12:00:20.000Z')

test('admits up to the limit, then refuses until the window rolls over', () => {
	const store = memoryStore()
	const checks: Array<WalletGuardCheck> = [
		{ bucket: 'org:burst', windowMs: minuteMs, limit: 2 },
	]
	expect(admitWalletGuardInWindows({ nowMs: noon, checks, store })).toEqual({
		admitted: true,
	})
	expect(admitWalletGuardInWindows({ nowMs: noon, checks, store })).toEqual({
		admitted: true,
	})
	expect(admitWalletGuardInWindows({ nowMs: noon, checks, store })).toEqual({
		admitted: false,
		bucket: 'org:burst',
		limit: 2,
		windowMs: minuteMs,
		retryAfterMs: 40_000,
	})
	expect(
		admitWalletGuardInWindows({ nowMs: noon + 40_000, checks, store }),
	).toEqual({ admitted: true })
})

test('a refused call is not counted in any window', () => {
	const store = memoryStore()
	const checks: Array<WalletGuardCheck> = [
		{ bucket: 'user:a:burst', windowMs: minuteMs, limit: 1 },
		{ bucket: 'org:day', windowMs: dayMs, limit: 3 },
	]
	expect(
		admitWalletGuardInWindows({ nowMs: noon, checks, store }).admitted,
	).toBe(true)
	for (let attempt = 0; attempt < 5; attempt += 1) {
		expect(
			admitWalletGuardInWindows({ nowMs: noon, checks, store }),
		).toMatchObject({ admitted: false, bucket: 'user:a:burst' })
	}
	// Only the one admitted call reached the daily window.
	expect(store.read('org:day')).toEqual({
		windowStart: Date.parse('2026-11-17T00:00:00.000Z'),
		count: 1,
	})
})

test('the daily window refuses with the time left until the next UTC day', () => {
	const store = memoryStore()
	const checks: Array<WalletGuardCheck> = [
		{ bucket: 'org:burst', windowMs: minuteMs, limit: 100 },
		{ bucket: 'org:day', windowMs: dayMs, limit: 1 },
	]
	admitWalletGuardInWindows({ nowMs: noon, checks, store })
	expect(
		admitWalletGuardInWindows({ nowMs: noon + minuteMs, checks, store }),
	).toEqual({
		admitted: false,
		bucket: 'org:day',
		limit: 1,
		windowMs: dayMs,
		retryAfterMs: 43_120_000,
	})
})

test('check refuses a full window without counting, and record counts without refusing', () => {
	const store = memoryStore()
	const checks: Array<WalletGuardCheck> = [
		{ bucket: 'org:burst', windowMs: minuteMs, limit: 1 },
	]
	expect(
		admitWalletGuardInWindows({ nowMs: noon, checks, store, mode: 'check' }),
	).toEqual({ admitted: true })
	expect(store.read('org:burst')).toBeNull()

	for (let call = 0; call < 2; call += 1) {
		expect(
			admitWalletGuardInWindows({ nowMs: noon, checks, store, mode: 'record' }),
		).toEqual({ admitted: true })
	}
	expect(store.read('org:burst')?.count).toBe(2)
	expect(
		admitWalletGuardInWindows({ nowMs: noon, checks, store, mode: 'check' }),
	).toMatchObject({ admitted: false, bucket: 'org:burst' })
	expect(store.read('org:burst')?.count).toBe(2)
})
