/**
 * # storage.sql statement policy
 *
 * This oracle owns what `storage.sql` decides from the text of a statement
 * before and while it runs: whether a read-only call accepts it, whether a
 * writable call must pass the storage-byte entitlement check first, and
 * whether the cursor treats it as a write. It owns `assertStorageSqlAllowed`,
 * `storageSqlNeedsWriteEntitlement`, `isStorageSqlWrite`, and
 * `isStorageSqlReturningMutation`.
 *
 * ```ts
 * assertStorageSqlAllowed('select a from t', false) // → returns: a single SELECT, EXPLAIN, or schema PRAGMA
 * assertStorageSqlAllowed('select 1; delete from t', false) // → throws the read-only denial: a batch
 * storageSqlNeedsWriteEntitlement('create table if not exists z (a)') // → false: the table starts empty
 * storageSqlNeedsWriteEntitlement('create table if not exists z as values (1)') // → true: it stores rows
 * isStorageSqlWrite("with c as (select 'a' as v) select replace(v, 'a', 'b') from c") // → false: a read that calls replace()
 * ```
 *
 * `create table if not exists z (a)` skips the entitlement check, so what
 * does `create table if not exists z as values (1), (2)` do? It has no
 * SELECT, and it stores two rows.
 *
 * Three parts decide every answer. The statement kind is the leading verb of
 * the statement, or after `WITH` the verb the common table expressions feed.
 * The dress is everything around the kind that must not change the answer:
 * letter case, comments, a trailing semicolon, and words inside literals and
 * quoted identifiers. The batch is two or more statements in one call.
 *
 * The read-only gate: for every statement and dress, a read-only call
 * accepts exactly a single SELECT, EXPLAIN, or schema PRAGMA, and denies
 * everything else with `readOnlyStorageSqlDeniedMessage` ("Read-only
 * storage.sql only allows a single SELECT, EXPLAIN, or schema PRAGMA
 * statement"); a writable call accepts them all. A caller of a denied read sees that message; a caller of an
 * accepted write would change a bucket through a read-only handle.
 *
 * The write entitlement gate: for every statement and dress, a writable
 * call must pass the storage-byte entitlement check unless the read-only
 * gate would accept the statement, or it is a single
 * `CREATE TABLE IF NOT EXISTS` that stores no rows ("a new table starts
 * empty and adds only schema bytes", `isIdempotentStorageSqlDdl`). A
 * statement that skips the check wrongly stores bytes past the plan limit;
 * one that pays it wrongly runs the all-bucket fan-out on a pure read.
 *
 * The write classification: for every single statement and dress,
 * `isStorageSqlWrite` is true exactly for INSERT, UPDATE, DELETE, REPLACE,
 * CREATE, DROP, and ALTER, and for a WITH that feeds one of the first four
 * ("After `WITH`, only INSERT / UPDATE / DELETE / REPLACE count"). The
 * row-yielding mutation classification is the same without the three DDL
 * verbs ("Pure reads, including `WITH … SELECT` … stop early. Words inside
 * strings, identifiers, and comments are ignored"). A read classified as a
 * write loses the read ceiling and is drained past the row cap.
 *
 * The model reads only the plan. The kind comes from the grammar, which
 * builds each statement from a template of a known kind. Whether a statement
 * stores rows comes from SQLite itself: the model runs the text on a small
 * in-memory database and counts rows before and after, and a text SQLite
 * rejects is a grammar defect, not a verdict. The driver calls the four
 * functions with the text and records each answer, and a denial by its
 * message. The check compares each answer with the model's.
 *
 * Limits: the classifications are judged on single statements, because
 * nothing states how a batch classifies. PRAGMA writes, ANALYZE, VACUUM,
 * REINDEX, transaction statements, repeated semicolons, and whitespace
 * inside a schema PRAGMA's name are outside the grammar. The model database
 * is node:sqlite, not the Durable Object SQLite build.
 */
import { DatabaseSync } from 'node:sqlite'
import {
	isStorageSqlReturningMutation,
	isStorageSqlWrite,
} from '@kody-internal/shared/storage-sql-statement.ts'
import {
	differs,
	oracleProperty,
	pass,
	type Observation,
} from '@tanstack/oracles'
import fc from 'fast-check'
import {
	assertStorageSqlAllowed,
	readOnlyStorageSqlDeniedMessage,
	storageSqlNeedsWriteEntitlement,
} from '#worker/storage-runner.ts'

// The grammar. Each template is one statement of a known kind over the model
// database's tables `t(a, b)` (three rows, index `ti`) and `u(a)` (empty).
// `$L` is a string literal slot and `$I` a quoted identifier slot; the decoy
// fills both.
const kinds = [
	'select',
	'explain',
	'schema pragma',
	'with select',
	'insert',
	'replace',
	'update',
	'delete',
	'with mutation',
	'create table',
	'create table if not exists',
	'create index',
	'drop',
	'alter',
] as const
type Kind = (typeof kinds)[number]

const templates = {
	'select rows': ['select', 'select a from t'],
	'select literal': ['select', 'select count(*) from t where b = $L'],
	'select quoted column': ['select', 'select a as $I from t'],
	'explain select': ['explain', 'explain select a from t'],
	'explain delete': ['explain', 'explain query plan delete from t'],
	'explain insert': ['explain', 'explain insert into u values ($L)'],
	'pragma table_info': ['schema pragma', 'pragma table_info(t)'],
	'pragma index_list': ['schema pragma', 'pragma index_list(t)'],
	'pragma index_info': ['schema pragma', 'pragma index_info(ti)'],
	'pragma database_list': ['schema pragma', 'pragma database_list'],
	'pragma table_list': ['schema pragma', 'pragma table_list'],
	'with select rows': [
		'with select',
		'with c as (select a from t) select a from c',
	],
	'with select replace()': [
		'with select',
		"with c as (select $L as v) select replace(v, 'a', 'b') from c",
	],
	'with select quoted name': [
		'with select',
		'with $I as (select 1 as x) select x from $I',
	],
	'insert row': ['insert', 'insert into u values ($L)'],
	'insert returning': ['insert', 'insert into u (a) values ($L) returning a'],
	'replace row': ['replace', 'replace into u (rowid, a) values (1, $L)'],
	'update rows': ['update', 'update t set b = $L'],
	'update no rows': ['update', 'update t set a = a + 1 where 0'],
	'delete rows': ['delete', 'delete from t'],
	'delete returning': ['delete', 'delete from t where b = $L returning a'],
	'with insert': [
		'with mutation',
		'with c as (select a from t) insert into u select a from c',
	],
	'with update': [
		'with mutation',
		'with c as (select 1 as x) update t set a = 9 where a in (select x from c)',
	],
	'with delete': [
		'with mutation',
		'with c as (select 1 as x) delete from t where a in (select x from c)',
	],
	'create table': ['create table', 'create table z (a)'],
	'create table as select': [
		'create table',
		'create table z as select a from t',
	],
	'create table if not exists': [
		'create table if not exists',
		'create table if not exists z (a text primary key, b default $L)',
	],
	'create table if not exists, existing': [
		'create table if not exists',
		'create table if not exists t (a)',
	],
	'create table if not exists as select': [
		'create table if not exists',
		'create table if not exists z as select a from t',
	],
	'create table if not exists as values': [
		'create table if not exists',
		'create table if not exists z as values (1), (2)',
	],
	'create index': ['create index', 'create index if not exists zi on t (b)'],
	'create unique index': ['create index', 'create unique index zi on u (a)'],
	'drop table': ['drop', 'drop table u'],
	'drop index': ['drop', 'drop index ti'],
	'alter rename column': ['alter', 'alter table u rename column a to c'],
	'alter rename': ['alter', 'alter table u rename to w'],
} as const satisfies Record<string, readonly [Kind, string]>
type TemplateName = keyof typeof templates
const templateNames = Object.keys(templates) as Array<TemplateName>

// A batch's later statements touch only `t`, which no template drops or
// renames, so every batch is legal SQL whatever its first statement is.
const followerNames = [
	'select rows',
	'select literal',
	'update rows',
	'delete rows',
	'create table if not exists, existing',
] as const satisfies ReadonlyArray<TemplateName>

// The dress. Decoys are words a verb check could mistake for the statement:
// they go into string literals and comments, never into the statement itself.
const decoys = [
	'x',
	'insert',
	'replace',
	'select 1; delete from t',
	"it's",
	'say "hi"; drop',
	'a -- b /* c',
] as const
const cases = ['lower', 'upper'] as const
const quotes = ['double', 'backtick', 'bracket'] as const
const leads = ['', ' ', '\n\t', 'block comment', 'line comment'] as const
const tails = [
	'',
	';',
	' ; ',
	'line comment',
	'block comment',
	'semicolon, line comment',
	'semicolon, block comment',
] as const
const separators = ['plain', 'block comment', 'line comment'] as const

type History = {
	first: TemplateName
	followers: Array<(typeof followerNames)[number]>
	decoy: (typeof decoys)[number]
	letterCase: (typeof cases)[number]
	quote: (typeof quotes)[number]
	separator: (typeof separators)[number]
	lead: (typeof leads)[number]
	tail: (typeof tails)[number]
}

const anyBatch: fc.Arbitrary<History> = fc.record({
	first: fc.constantFrom(...templateNames),
	followers: fc.array(fc.constantFrom(...followerNames), { maxLength: 2 }),
	decoy: fc.constantFrom(...decoys),
	letterCase: fc.constantFrom(...cases),
	quote: fc.constantFrom(...quotes),
	separator: fc.constantFrom(...separators),
	lead: fc.constantFrom(...leads),
	tail: fc.constantFrom(...tails),
})
const anySingle: fc.Arbitrary<History> = fc.record({
	first: fc.constantFrom(...templateNames),
	followers: fc.array(fc.constantFrom(...followerNames), { maxLength: 0 }),
	decoy: fc.constantFrom(...decoys),
	letterCase: fc.constantFrom(...cases),
	quote: fc.constantFrom(...quotes),
	separator: fc.constantFrom(...separators),
	lead: fc.constantFrom(...leads),
	tail: fc.constantFrom(...tails),
})

type Plan = {
	sql: string
	kind: Kind
	statementCount: number
	dress: Pick<History, 'lead' | 'tail' | 'decoy'>
	usesIdentifier: boolean
	template: TemplateName
}

function renderStatement(name: TemplateName, history: History) {
	const literal = `'${history.decoy.replaceAll("'", "''")}'`
	const identifier =
		history.quote === 'double'
			? `"${history.decoy.replaceAll('"', '""')}"`
			: history.quote === 'backtick'
				? '`' + history.decoy + '`'
				: `[${history.decoy}]`
	const text = templates[name][1]
		.replaceAll('$L', literal)
		.replaceAll('$I', identifier)
	return history.letterCase === 'upper' ? text.toUpperCase() : text
}

function resolve(history: History): Plan {
	const lead =
		history.lead === 'block comment'
			? `/* ${history.decoy} */ `
			: history.lead === 'line comment'
				? `-- ${history.decoy}\n`
				: history.lead
	const tails: Record<History['tail'], string> = {
		'': '',
		';': ';',
		' ; ': ' ; ',
		'line comment': ` -- ${history.decoy}`,
		'block comment': ` /* ; ${history.decoy} */`,
		'semicolon, line comment': `; -- ${history.decoy}`,
		'semicolon, block comment': `;\n/* ${history.decoy} */`,
	}
	const tail = tails[history.tail]
	const separator =
		history.separator === 'block comment'
			? `; /* ${history.decoy} */ `
			: history.separator === 'line comment'
				? `; -- ${history.decoy}\n`
				: ';\n'
	const statements = [history.first, ...history.followers].map((name) =>
		renderStatement(name, history),
	)
	return {
		sql: `${lead}${statements.join(separator)}${tail}`,
		kind: templates[history.first][0],
		statementCount: statements.length,
		dress: { lead: history.lead, tail: history.tail, decoy: history.decoy },
		usesIdentifier: templates[history.first][1].includes('$I'),
		template: history.first,
	}
}

// The model. Each rule is one sentence of a law; the only fact it takes from
// outside the plan's kind is SQLite's own count of stored rows.
const readOnlyKinds: ReadonlySet<Kind> = new Set([
	'select',
	'explain',
	'schema pragma',
])
const rowYieldingMutationKinds: ReadonlySet<Kind> = new Set([
	'insert',
	'replace',
	'update',
	'delete',
	'with mutation',
])
const writeKinds: ReadonlySet<Kind> = new Set([
	...rowYieldingMutationKinds,
	'create table',
	'create table if not exists',
	'create index',
	'drop',
	'alter',
])

function storedRows(db: DatabaseSync) {
	const tables = db
		.prepare("select name from sqlite_schema where type = 'table'")
		.all() as Array<{ name: string }>
	let rows = 0
	for (const { name } of tables) {
		const counted = db.prepare(`select count(*) as n from "${name}"`).get()
		rows += Number(counted?.n)
	}
	return rows
}

/** Rows the text adds to the model database. SQLite rejecting it is a grammar defect. */
function rowsAddedBySqlite(sql: string) {
	const db = new DatabaseSync(':memory:')
	try {
		db.exec(
			"create table t (a, b); insert into t values (1, 'x'), (2, 'y'), (3, 'insert'); create index ti on t (a); create table u (a)",
		)
		const before = storedRows(db)
		db.exec(sql)
		return storedRows(db) - before
	} finally {
		db.close()
	}
}

type Owed = {
	readOnlyAccepted: boolean
	needsWriteEntitlement: boolean
	write: boolean
	rowYieldingMutation: boolean
}

function owed(plan: Plan): Owed {
	const single = plan.statementCount === 1
	const rowsAdded = rowsAddedBySqlite(plan.sql)
	// Read-only gate: exactly a single SELECT, EXPLAIN, or schema PRAGMA.
	const readOnlyAccepted = single && readOnlyKinds.has(plan.kind)
	// Entitlement gate: skipped only by an accepted read, or by a single
	// CREATE TABLE IF NOT EXISTS that stores no rows.
	const emptyIdempotentTable =
		single && plan.kind === 'create table if not exists' && rowsAdded === 0
	return {
		readOnlyAccepted,
		needsWriteEntitlement: !readOnlyAccepted && !emptyIdempotentTable,
		write: writeKinds.has(plan.kind),
		rowYieldingMutation: rowYieldingMutationKinds.has(plan.kind),
	}
}

// The driver records each function's answer for the text. A read-only denial
// is recorded by its message, so another error cannot pass as a denial.
const checkpoints = {
	readOnly: 'read-only call',
	writable: 'writable call',
	entitlement: 'needs write entitlement',
	write: 'is write',
	rowYieldingMutation: 'is row-yielding mutation',
} as const

function drive(
	plan: Plan,
	observe: (checkpoint: string, value: unknown) => void,
) {
	let readOnly: unknown
	try {
		assertStorageSqlAllowed(plan.sql, false)
		readOnly = true
	} catch (error) {
		readOnly =
			error instanceof Error &&
			error.message === readOnlyStorageSqlDeniedMessage
				? false
				: error
	}
	observe(checkpoints.readOnly, readOnly)
	let writable: unknown = true
	try {
		assertStorageSqlAllowed(plan.sql, true)
	} catch (error) {
		writable = error
	}
	observe(checkpoints.writable, writable)
	observe(checkpoints.entitlement, storageSqlNeedsWriteEntitlement(plan.sql))
	observe(checkpoints.write, isStorageSqlWrite(plan.sql))
	observe(
		checkpoints.rowYieldingMutation,
		isStorageSqlReturningMutation(plan.sql),
	)
}

function observed(trace: ReadonlyArray<Observation>, checkpoint: string) {
	return trace.find((observation) => observation.checkpoint === checkpoint)
		?.value
}

function flip(checkpoint: string) {
	return (trace: ReadonlyArray<Observation>) =>
		trace.map((observation) =>
			observation.checkpoint === checkpoint
				? { ...observation, value: !observation.value }
				: observation,
		)
}

// The states the laws need, read from the plan alone.
const states = {
	batch: 'a batch',
	commentFirst: 'a comment before the statement',
	semicolonInLiteral: 'a semicolon inside a literal',
	semicolonInIdentifier: 'a semicolon inside a quoted identifier',
	commentAfterSemicolon: 'a comment after the last semicolon',
	emptyIdempotentTable: 'an idempotent table that stores no rows',
	idempotentTableWithRows:
		'an idempotent table that stores rows without SELECT',
	verbNamedInRead: 'a WITH read that names a mutation verb',
	mutationAfterWith: 'a mutation after WITH',
} as const

function reached(plan: Plan) {
	const entered: Array<string> = []
	if (plan.statementCount > 1) entered.push(states.batch)
	if (plan.dress.lead === 'block comment' || plan.dress.lead === 'line comment')
		entered.push(states.commentFirst)
	if (plan.template === 'select literal' && plan.dress.decoy.includes(';'))
		entered.push(states.semicolonInLiteral)
	if (plan.usesIdentifier && plan.dress.decoy.includes(';'))
		entered.push(states.semicolonInIdentifier)
	if (
		plan.dress.tail === 'semicolon, line comment' ||
		plan.dress.tail === 'semicolon, block comment'
	)
		entered.push(states.commentAfterSemicolon)
	if (plan.template === 'create table if not exists')
		entered.push(states.emptyIdempotentTable)
	if (plan.template === 'create table if not exists as values')
		entered.push(states.idempotentTableWithRows)
	if (plan.template === 'with select replace()')
		entered.push(states.verbNamedInRead)
	if (plan.kind === 'with mutation') entered.push(states.mutationAfterWith)
	return entered
}

const plain = (generated: History): History => ({
	...generated,
	followers: [],
	lead: '',
})

const constructed = {
	batch: {
		name: states.batch,
		enters: [states.batch],
		build: (generated: History): History => ({
			...generated,
			followers: ['delete rows'],
			lead: '',
		}),
	},
	commentFirst: {
		name: states.commentFirst,
		enters: [states.commentFirst],
		build: (generated: History): History => ({
			...generated,
			followers: [],
			lead: 'block comment',
		}),
	},
	semicolonInLiteral: {
		name: states.semicolonInLiteral,
		enters: [states.semicolonInLiteral],
		build: (generated: History): History => ({
			...plain(generated),
			first: 'select literal',
			decoy: 'select 1; delete from t',
		}),
	},
	semicolonInIdentifier: {
		name: states.semicolonInIdentifier,
		enters: [states.semicolonInIdentifier],
		build: (generated: History): History => ({
			...plain(generated),
			first: 'select quoted column',
			decoy: 'say "hi"; drop',
		}),
	},
	commentAfterSemicolon: {
		name: states.commentAfterSemicolon,
		enters: [states.commentAfterSemicolon],
		build: (generated: History): History => ({
			...plain(generated),
			tail: 'semicolon, line comment',
		}),
	},
	emptyIdempotentTable: {
		name: states.emptyIdempotentTable,
		enters: [states.emptyIdempotentTable],
		build: (generated: History): History => ({
			...plain(generated),
			first: 'create table if not exists',
		}),
	},
	idempotentTableWithRows: {
		name: states.idempotentTableWithRows,
		enters: [states.idempotentTableWithRows],
		build: (generated: History): History => ({
			...plain(generated),
			first: 'create table if not exists as values',
		}),
	},
	verbNamedInRead: {
		name: states.verbNamedInRead,
		enters: [states.verbNamedInRead],
		build: (generated: History): History => ({
			...plain(generated),
			first: 'with select replace()',
		}),
	},
	mutationAfterWith: {
		name: states.mutationAfterWith,
		enters: [states.mutationAfterWith],
		build: (generated: History): History => ({
			...plain(generated),
			first: 'with insert',
		}),
	},
}

const runs = 200
const fixedSeeds = [20261116]

oracleProperty<History, Owed, Plan>({
	id: 'storage-sql.read-only-gate',
	owns: ['packages/worker/src/storage-runner.ts#assertStorageSqlAllowed'],
	law: {
		statement:
			'For every statement or batch, in any letter case and with any comments, trailing semicolon, and literal contents, a read-only storage.sql call accepts it exactly when it is a single SELECT, EXPLAIN, or schema PRAGMA statement, and otherwise throws readOnlyStorageSqlDeniedMessage. A writable call accepts every one of them.',
		authority:
			'readOnlyStorageSqlDeniedMessage in packages/worker/src/storage-runner.ts: "Read-only storage.sql only allows a single SELECT, EXPLAIN, or schema PRAGMA statement." "Pass writable: true to allow multi-statement or mutating queries." isReadOnlyStorageSqlQuery: "Mutating SQL (and multi-statement batches) return false".',
		limits:
			'WITH and VALUES reads, repeated semicolons, whitespace inside a schema PRAGMA name, and the empty query are not judged.',
	},
	histories: {
		arbitrary: anyBatch,
		states: [
			states.batch,
			states.commentFirst,
			states.semicolonInLiteral,
			states.semicolonInIdentifier,
			states.commentAfterSemicolon,
		],
		measured: [
			states.emptyIdempotentTable,
			states.idempotentTableWithRows,
			states.verbNamedInRead,
			states.mutationAfterWith,
		],
		runs,
		fixedSeeds,
		constructed: [
			constructed.batch,
			constructed.commentFirst,
			constructed.semicolonInLiteral,
			constructed.semicolonInIdentifier,
			constructed.commentAfterSemicolon,
		],
	},
	resolve,
	model: owed,
	reached,
	driver: drive,
	check: (_plan, trace, expected) =>
		differs(
			checkpoints.readOnly,
			'read-only gate',
			observed(trace, checkpoints.readOnly),
			expected.readOnlyAccepted,
		) ??
		differs(
			checkpoints.writable,
			'read-only gate',
			observed(trace, checkpoints.writable),
			true,
		) ??
		pass,
	calibrations: [
		{
			name: 'a read-only call that answers the opposite',
			law: 'read-only gate',
			history: { constructed: states.semicolonInLiteral },
			corrupt: flip(checkpoints.readOnly),
		},
	],
})

oracleProperty<History, Owed, Plan>({
	id: 'storage-sql.write-entitlement-gate',
	owns: [
		'packages/worker/src/storage-runner.ts#storageSqlNeedsWriteEntitlement',
	],
	law: {
		statement:
			'For every statement or batch, in any letter case and with any comments, trailing semicolon, and literal contents, a writable storage.sql call must pass the storage-byte entitlement check unless a read-only call would accept the statement, or it is a single CREATE TABLE IF NOT EXISTS that stores no rows.',
		authority:
			'storageSqlNeedsWriteEntitlement in packages/worker/src/storage-runner.ts: "True when a writable statement must pass the storage-byte entitlement check before it runs: not a pure read and not idempotent DDL." isIdempotentStorageSqlDdl: "a new table starts empty and adds only schema bytes, so they skip the storage-byte entitlement baseline."',
		limits:
			'Stored rows are counted on node:sqlite, not on the Durable Object SQLite build. Bytes added by schema text alone are not judged.',
	},
	histories: {
		arbitrary: anyBatch,
		states: [
			states.batch,
			states.commentFirst,
			states.emptyIdempotentTable,
			states.idempotentTableWithRows,
		],
		measured: [
			states.semicolonInIdentifier,
			states.commentAfterSemicolon,
			states.semicolonInLiteral,
			states.verbNamedInRead,
			states.mutationAfterWith,
		],
		runs,
		fixedSeeds,
		constructed: [
			constructed.batch,
			constructed.commentFirst,
			constructed.emptyIdempotentTable,
			constructed.idempotentTableWithRows,
		],
	},
	resolve,
	model: owed,
	reached,
	driver: drive,
	check: (_plan, trace, expected) =>
		differs(
			checkpoints.entitlement,
			'write entitlement gate',
			observed(trace, checkpoints.entitlement),
			expected.needsWriteEntitlement,
		) ?? pass,
	calibrations: [
		{
			name: 'an empty idempotent table that pays the entitlement check',
			law: 'write entitlement gate',
			history: { constructed: states.emptyIdempotentTable },
			corrupt: flip(checkpoints.entitlement),
		},
	],
})

oracleProperty<History, Owed, Plan>({
	id: 'storage-sql.write-classification',
	owns: ['packages/shared/src/storage-sql-statement.ts#isStorageSqlWrite'],
	law: {
		statement:
			'For every single statement, in any letter case and with any comments, trailing semicolon, and literal contents, isStorageSqlWrite is true exactly when the statement is an INSERT, UPDATE, DELETE, REPLACE, CREATE, DROP, or ALTER, or a WITH that feeds an INSERT, UPDATE, DELETE, or REPLACE.',
		authority:
			'isStorageSqlWrite in packages/shared/src/storage-sql-statement.ts: "True when the statement can change the bucket, including DDL such as `CREATE TABLE AS SELECT` ... Quoted words do not count. After `WITH`, only INSERT / UPDATE / DELETE / REPLACE count".',
		limits:
			'Batches, PRAGMA writes, ANALYZE, VACUUM, REINDEX, and transaction statements are not judged.',
	},
	histories: {
		arbitrary: anySingle,
		states: [
			states.commentFirst,
			states.verbNamedInRead,
			states.mutationAfterWith,
		],
		measured: [
			states.semicolonInIdentifier,
			states.commentAfterSemicolon,
			states.semicolonInLiteral,
			states.emptyIdempotentTable,
			states.idempotentTableWithRows,
		],
		runs,
		fixedSeeds,
		constructed: [
			constructed.commentFirst,
			constructed.verbNamedInRead,
			constructed.mutationAfterWith,
		],
	},
	resolve,
	model: owed,
	reached,
	driver: drive,
	check: (_plan, trace, expected) =>
		differs(
			checkpoints.write,
			'write classification',
			observed(trace, checkpoints.write),
			expected.write,
		) ?? pass,
	calibrations: [
		{
			name: 'a mutation after WITH that reads as a pure read',
			law: 'write classification',
			history: { constructed: states.mutationAfterWith },
			corrupt: flip(checkpoints.write),
		},
	],
})

oracleProperty<History, Owed, Plan>({
	id: 'storage-sql.row-yielding-mutation-classification',
	owns: [
		'packages/shared/src/storage-sql-statement.ts#isStorageSqlReturningMutation',
	],
	law: {
		statement:
			'For every single statement, in any letter case and with any comments, trailing semicolon, and literal contents, isStorageSqlReturningMutation is true exactly when the statement is an INSERT, UPDATE, DELETE, or REPLACE, or a WITH that feeds one of them.',
		authority:
			'isStorageSqlReturningMutation in packages/shared/src/storage-sql-statement.ts: "True when `query` can mutate while yielding rows (SQLite RETURNING on INSERT / UPDATE / DELETE / REPLACE, including after a WITH clause) ... Pure reads, including `WITH … SELECT` sent with `writable: true` from packageStorage, stop early. Words inside strings, identifiers, and comments are ignored."',
		limits: 'Batches are not judged.',
	},
	histories: {
		arbitrary: anySingle,
		states: [
			states.commentFirst,
			states.verbNamedInRead,
			states.mutationAfterWith,
		],
		measured: [
			states.semicolonInIdentifier,
			states.commentAfterSemicolon,
			states.semicolonInLiteral,
			states.emptyIdempotentTable,
			states.idempotentTableWithRows,
		],
		runs,
		fixedSeeds,
		constructed: [
			constructed.commentFirst,
			constructed.verbNamedInRead,
			constructed.mutationAfterWith,
		],
	},
	resolve,
	model: owed,
	reached,
	driver: drive,
	check: (_plan, trace, expected) =>
		differs(
			checkpoints.rowYieldingMutation,
			'row-yielding mutation classification',
			observed(trace, checkpoints.rowYieldingMutation),
			expected.rowYieldingMutation,
		) ?? pass,
	calibrations: [
		{
			name: 'a mutation after WITH that stops at the row cap',
			law: 'row-yielding mutation classification',
			history: { constructed: states.mutationAfterWith },
			corrupt: flip(checkpoints.rowYieldingMutation),
		},
	],
})
