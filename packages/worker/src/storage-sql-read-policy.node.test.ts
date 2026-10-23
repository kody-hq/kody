import { expect, test } from 'vitest'
import { isUserStorageSqlCallerMessage } from '#worker/storage-sql-caller-error.ts'
import {
	collectStorageSqlCursor,
	settleStorageSqlRead,
	storageSqlReadCeilingMessage,
	storageSqlReadDisposition,
	storageSqlRowsReadCeiling,
	storageSqlRowsReadWarnAt,
	type StorageSqlReadValue,
} from '#worker/storage-sql-read-policy.ts'

function cursor(input: {
	rows: Array<Record<string, StorageSqlReadValue>>
	rowsReadAt: (index: number) => number
	rowsWritten?: number
}) {
	let index = 0
	let rowsRead = 0
	let pulled = 0
	return {
		columnNames: Object.keys(input.rows[0] ?? { value: 0 }),
		get rowsRead() {
			return rowsRead
		},
		rowsWritten: input.rowsWritten ?? 0,
		get pulled() {
			return pulled
		},
		[Symbol.iterator]() {
			return {
				next: () => {
					const value = input.rows[index]
					if (value === undefined) {
						return { done: true as const, value: undefined }
					}
					pulled += 1
					rowsRead = input.rowsReadAt(index)
					index += 1
					return { done: false as const, value }
				},
			}
		},
	}
}

test('an oversized storage sql read is allowed and warned', () => {
	expect(
		storageSqlReadDisposition({
			rowsRead: storageSqlRowsReadWarnAt,
			writeFinished: false,
		}),
	).toBe('warn')
	expect(
		storageSqlReadDisposition({
			rowsRead: storageSqlRowsReadCeiling,
			writeFinished: false,
		}),
	).toBe('warn')
	const source = cursor({
		rows: [{ value: 1 }],
		rowsReadAt: () => storageSqlRowsReadWarnAt,
	})
	const collected = collectStorageSqlCursor(source, {
		drainOverflow: false,
		writeFinished: false,
		maxRows: 1_000,
	})
	expect(collected.readCeilingExceeded).toBe(false)
	expect(collected.rows).toEqual([{ value: 1 }])
	expect(collected.warning).toContain(String(storageSqlRowsReadWarnAt))
	expect(collected.warning).toContain('allowed')
	expect(collected.warning).toContain('credits')
	const settled = settleStorageSqlRead(collected)
	expect(settled.outcome).toBe('success')
	if (settled.outcome === 'success') {
		expect(settled.result.warning).toBe(collected.warning)
		expect(settled.result).not.toHaveProperty('readCeilingExceeded')
	}
})

test('a read cursor stops after the ceiling and the error stays caller-clearable', () => {
	expect(
		storageSqlReadDisposition({
			rowsRead: storageSqlRowsReadCeiling + 1,
			writeFinished: false,
		}),
	).toBe('stop')
	const source = cursor({
		rows: [{ value: 1 }, { value: 2 }, { value: 3 }],
		rowsReadAt: (index) => storageSqlRowsReadCeiling + index + 1,
	})
	const collected = collectStorageSqlCursor(source, {
		drainOverflow: false,
		writeFinished: false,
		maxRows: 1_000,
	})
	expect(source.pulled).toBe(1)
	expect(collected.readCeilingExceeded).toBe(true)
	expect(collected.rows).toEqual([])
	expect(collected.rowsRead).toBe(storageSqlRowsReadCeiling + 1)
	const settled = settleStorageSqlRead(collected)
	expect(settled.outcome).toBe('error')
	if (settled.outcome === 'error') {
		expect(settled.error.message).toBe(
			storageSqlReadCeilingMessage(storageSqlRowsReadCeiling + 1),
		)
		expect(isUserStorageSqlCallerMessage(settled.error.message)).toBe(true)
	}
})

test('a zero-row scan that already passed the ceiling still stops', () => {
	const source = cursor({
		rows: [],
		rowsReadAt: () => 0,
	})
	Object.defineProperty(source, 'rowsRead', {
		get: () => storageSqlRowsReadCeiling + 1,
	})
	const collected = collectStorageSqlCursor(source, {
		drainOverflow: false,
		writeFinished: false,
		maxRows: 1_000,
	})
	expect(collected.readCeilingExceeded).toBe(true)
	expect(collected.rowCount).toBe(0)
})

test('a mutating statement past the ceiling finishes and warns', () => {
	expect(
		storageSqlReadDisposition({
			rowsRead: storageSqlRowsReadCeiling + 1,
			writeFinished: true,
		}),
	).toBe('warn')
	const source = cursor({
		rows: [{ value: 1 }, { value: 2 }],
		rowsReadAt: () => storageSqlRowsReadCeiling + 40,
		rowsWritten: 2,
	})
	const collected = collectStorageSqlCursor(source, {
		drainOverflow: true,
		writeFinished: true,
		maxRows: 1,
	})
	expect(source.pulled).toBe(2)
	expect(collected.readCeilingExceeded).toBe(false)
	expect(collected.truncated).toBe(true)
	expect(collected.rows).toEqual([{ value: 1 }])
	expect(collected.rowsWritten).toBe(2)
	expect(collected.warning).toContain('write finished')
	expect(settleStorageSqlRead(collected).outcome).toBe('success')
})

test('a committed write that is not a RETURNING statement warns instead of failing', () => {
	const source = cursor({
		rows: [],
		rowsReadAt: () => 0,
	})
	Object.defineProperty(source, 'rowsRead', {
		get: () => storageSqlRowsReadCeiling + 1,
	})
	const collected = collectStorageSqlCursor(source, {
		drainOverflow: false,
		writeFinished: true,
		maxRows: 1_000,
	})
	expect(collected.readCeilingExceeded).toBe(false)
	expect(collected.warning).toContain('write finished')
	expect(settleStorageSqlRead(collected).outcome).toBe('success')
})

test('read cursors still truncate at the return cap before the ceiling', () => {
	const source = cursor({
		rows: [{ value: 1 }, { value: 2 }, { value: 3 }],
		rowsReadAt: (index) => index + 1,
	})
	const collected = collectStorageSqlCursor(source, {
		drainOverflow: false,
		writeFinished: false,
		maxRows: 2,
	})
	expect(source.pulled).toBe(3)
	expect(collected.truncated).toBe(true)
	expect(collected.rowCount).toBe(2)
	expect(collected.warning).toBeNull()
	expect(collected.readCeilingExceeded).toBe(false)
})
