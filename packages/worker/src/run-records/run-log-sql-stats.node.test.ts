import { expect, test } from 'vitest'
import { runLogSqlStatementKey } from './run-log-sql-stats.ts'

test('long statements that share a prefix get distinct keys', () => {
	const prefix = `SELECT ${'column_name, '.repeat(20)}`
	const first = runLogSqlStatementKey(
		`${prefix} FROM runs WHERE status = 'error'`,
	)
	const second = runLogSqlStatementKey(
		`${prefix}\n\t\tFROM runs WHERE status = 'success'`,
	)
	expect(first).not.toBe(second)
	expect(first.startsWith('SELECT column_name, column_name,')).toBe(true)
	expect(runLogSqlStatementKey(`SELECT 1\n\t\tFROM runs`)).toBe(
		'SELECT 1 FROM runs',
	)
})
