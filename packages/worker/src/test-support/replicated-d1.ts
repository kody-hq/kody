export type ReplicaReadFlag = {
	enabled: number
	rollout_percent: number | null
} | null

type Copy = { member: boolean; version: number }

/** A value shaped like a D1 bookmark, naming the version it was taken at. */
export function fakeD1Bookmark(version: number) {
	return `${version.toString(16).padStart(8, '0')}-00000000-00000000-${'a'.repeat(32)}`
}

/**
 * A primary and one replica that only catches up when told to. Statements
 * are `SELECT role` (is user 1 a member), `UPDATE revoke`, and the flag read.
 * A session started at a bookmark reads the replica once it has that
 * version, and the primary until then.
 */
export function fakeReplicatedD1(flag: ReplicaReadFlag) {
	const primary: Copy = { member: true, version: 1 }
	const replica: Copy = { member: true, version: 1 }
	const served: Array<string> = []
	const sessions: Array<string> = []
	let flagRow = flag
	let flagReadFails = false
	let flagGate: Promise<void> | undefined
	let releaseFlagReads = () => {}

	function statement(sql: string, read: () => Copy, by: string) {
		const run = async () => {
			served.push(`${by}:${sql}`)
			if (sql.includes('feature_flags')) {
				const row = flagRow
				await flagGate
				if (flagReadFails) throw new Error('D1 is down')
				return { results: row ? [row] : [], meta: {} }
			}
			if (sql === 'UPDATE revoke') {
				primary.member = false
				primary.version++
				return { results: [], meta: { changes: 1 } }
			}
			return { results: [{ member: read().member }], meta: {} }
		}
		const self = {
			bind: () => self,
			all: run,
			run,
			raw: async () => (await run()).results,
			first: async () => (await run()).results[0] ?? null,
		}
		return self as unknown as D1PreparedStatement
	}
	function queries(read: () => Copy, by: string) {
		return {
			prepare: (sql: string) => statement(sql, read, by),
			batch: (statements: Array<D1PreparedStatement>) =>
				Promise.all(statements.map((entry) => entry.all())),
		}
	}
	const db = {
		...queries(() => primary, 'primary'),
		withSession(start: string) {
			sessions.push(start)
			// The version the next read must have. `first-primary` asks the
			// primary once, then any copy at least that fresh will do.
			let wanted =
				start === 'first-primary'
					? Infinity
					: start === 'first-unconstrained'
						? 0
						: parseInt(start.slice(0, 8), 16)
			let read: Copy | undefined
			const source = () => {
				read = replica.version >= wanted ? replica : primary
				wanted = read.version
				return read
			}
			const by = () =>
				replica.version >= wanted ? 'replica' : 'primary-session'
			return {
				prepare: (sql: string) => statement(sql, source, by()),
				batch: (statements: Array<D1PreparedStatement>) =>
					Promise.all(statements.map((entry) => entry.all())),
				getBookmark: () => (read ? fakeD1Bookmark(read.version) : null),
			}
		},
	} as unknown as D1Database
	return {
		db,
		served,
		sessions,
		setFlag: (next: ReplicaReadFlag) => (flagRow = next),
		failFlagReads: () => (flagReadFails = true),
		/**
		 * Flag reads from now on do not settle, like a read Workers dropped
		 * with its request, until the returned function lets them through
		 * with the flag they started with.
		 */
		hangFlagReads() {
			flagGate = new Promise((resolve) => (releaseFlagReads = resolve))
			const release = releaseFlagReads
			return () => {
				flagGate = undefined
				return release
			}
		},
		replicate: () => Object.assign(replica, primary),
	}
}
