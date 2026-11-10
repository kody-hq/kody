/**
 * Per-statement policy for oversized StorageRunner SQL reads.
 *
 * Soft-bill first: a large scan is allowed, metered on
 * `durable_object_rows_read`, and warned. Hard-fail only after
 * {@link storageSqlRowsReadCeiling}. Both numbers are a gut feel (about one
 * published rate unit to warn, about $2 at $0.002 per million rows to stop)
 * and can move when fleet data says the line is wrong. The 1,000-row return
 * cap is a response limit and stays separate.
 */

export const storageSqlRowsReadWarnAt = 1_000_000
export const storageSqlRowsReadCeiling = 1_000_000_000

export type StorageSqlReadValue = string | number | null

export type StorageSqlReadResult = {
	columns: Array<string>
	rows: Array<Record<string, StorageSqlReadValue>>
	rowCount: number
	rowsRead: number
	rowsWritten: number
	truncated: boolean
	/**
	 * Set when the statement was allowed and examined at least
	 * {@link storageSqlRowsReadWarnAt} rows. Null under that line.
	 */
	warning: string | null
}

export type StorageSqlReadCollection = StorageSqlReadResult & {
	/** Read cursor stopped because it passed the ceiling. Not a public field. */
	readCeilingExceeded: boolean
}

export type StorageSqlReadCursor = {
	columnNames: Iterable<string>
	rowsRead: number
	rowsWritten: number
	[Symbol.iterator](): Iterator<Record<string, StorageSqlReadValue>>
}

type StorageSqlReadDisposition = 'allow' | 'warn' | 'stop'

export function storageSqlReadDisposition(input: {
	rowsRead: number
	writeFinished: boolean
}): StorageSqlReadDisposition {
	if (input.rowsRead > storageSqlRowsReadCeiling) {
		// A finished write is not rolled back. Warn and meter; do not fail
		// the call after the statement has already changed the bucket.
		return input.writeFinished ? 'warn' : 'stop'
	}
	if (input.rowsRead >= storageSqlRowsReadWarnAt) return 'warn'
	return 'allow'
}

export function storageSqlReadCeilingMessage(rowsRead: number) {
	return (
		`storage.sql read stopped after examining ${rowsRead} rows, above the ` +
		`${storageSqlRowsReadCeiling}-row ceiling. Narrow the query with LIMIT or ` +
		`WHERE. Rows already examined count toward the monthly Rows read include, ` +
		`and usage past the include is billed from credits.`
	)
}

export function storageSqlReadWarningMessage(input: {
	rowsRead: number
	writeFinished: boolean
}) {
	if (input.writeFinished && input.rowsRead > storageSqlRowsReadCeiling) {
		return (
			`This statement examined ${input.rowsRead} rows, above the ` +
			`${storageSqlRowsReadCeiling}-row read ceiling. The write finished so it ` +
			`would not stop halfway, and those rows still count toward the monthly ` +
			`Rows read include. Narrow later statements with LIMIT or WHERE.`
		)
	}
	return (
		`This read examined ${input.rowsRead} rows and was allowed. Those rows ` +
		`count toward the monthly Rows read include, and usage past the include ` +
		`is billed from credits. Narrow it with LIMIT or WHERE. One read stops ` +
		`after ${storageSqlRowsReadCeiling} rows.`
	)
}

function warningFor(input: {
	rowsRead: number
	writeFinished: boolean
	disposition: StorageSqlReadDisposition
}): string | null {
	switch (input.disposition) {
		case 'allow':
		case 'stop':
			return null
		case 'warn':
			return storageSqlReadWarningMessage({
				rowsRead: input.rowsRead,
				writeFinished: input.writeFinished,
			})
		default: {
			const exhaustive: never = input.disposition
			throw new Error(
				`Unknown storage sql read disposition: ${String(exhaustive)}`,
			)
		}
	}
}

/**
 * Materialize a StorageRunner SQL cursor. Read cursors stop once `rowsRead`
 * passes the ceiling so a streaming scan cannot keep going. `drainOverflow`
 * keeps stepping so a RETURNING write finishes. `writeFinished` is any
 * statement that already changed the bucket, including DDL such as
 * `CREATE TABLE AS SELECT`: those warn and meter instead of failing the call.
 */
export function collectStorageSqlCursor(
	cursor: StorageSqlReadCursor,
	options: {
		drainOverflow: boolean
		writeFinished: boolean
		maxRows: number
	},
): StorageSqlReadCollection {
	const rows: Array<Record<string, StorageSqlReadValue>> = []
	let truncated = false
	let readCeilingExceeded = false
	for (const row of cursor) {
		if (!options.writeFinished && cursor.rowsRead > storageSqlRowsReadCeiling) {
			readCeilingExceeded = true
			break
		}
		if (rows.length >= options.maxRows) {
			truncated = true
			if (!options.drainOverflow) break
			continue
		}
		rows.push(row)
	}
	if (!options.writeFinished && cursor.rowsRead > storageSqlRowsReadCeiling) {
		readCeilingExceeded = true
	}
	const writeFinished = options.writeFinished
	const disposition = storageSqlReadDisposition({
		rowsRead: cursor.rowsRead,
		writeFinished,
	})
	return {
		columns: [...cursor.columnNames],
		rows,
		rowCount: rows.length,
		rowsRead: cursor.rowsRead,
		rowsWritten: cursor.rowsWritten,
		truncated,
		warning: warningFor({
			rowsRead: cursor.rowsRead,
			writeFinished,
			disposition,
		}),
		readCeilingExceeded,
	}
}

export function settleStorageSqlRead(
	collection: StorageSqlReadCollection,
):
	| { outcome: 'error'; error: Error }
	| { outcome: 'success'; result: StorageSqlReadResult } {
	if (collection.readCeilingExceeded) {
		return {
			outcome: 'error',
			error: new Error(storageSqlReadCeilingMessage(collection.rowsRead)),
		}
	}
	return {
		outcome: 'success',
		result: {
			columns: collection.columns,
			rows: collection.rows,
			rowCount: collection.rowCount,
			rowsRead: collection.rowsRead,
			rowsWritten: collection.rowsWritten,
			truncated: collection.truncated,
			warning: collection.warning,
		},
	}
}
