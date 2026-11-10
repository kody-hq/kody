import type { StorageSqlReadResult } from './storage-sql-read-policy.ts'

type StorageSqlParityCounters = Pick<
	StorageSqlReadResult,
	'rowsRead' | 'rowsWritten'
>

export type StorageSqlParityStep = {
	query: string
	params?: Array<string | number | boolean | null>
} & (
	| {
			/**
			 * Full hosted result. `rows` may be omitted for large results, which
			 * then only check `rowCount`, `truncated`, and the first row.
			 */
			result: Omit<StorageSqlReadResult, 'rows'> & {
				rows?: StorageSqlReadResult['rows']
				firstRow?: StorageSqlReadResult['rows'][number]
			}
			/**
			 * Counters the CLI mock reports when node:sqlite cannot reproduce
			 * Cloudflare's accounting. Every other field must match hosted.
			 */
			mockCounters?: StorageSqlParityCounters
	  }
	| { error: string }
)

/**
 * One `packageStorage().sql` session run in order against a fresh bucket.
 * Shared by the hosted StorageRunner test and the CLI mock test so both prove
 * the same result shape, row cap, multi-statement rules, and binding errors.
 * Hosted counters were read from a real Durable Object SQLite cursor.
 */
export const storageSqlParitySteps: Array<StorageSqlParityStep> = [
	{
		query: 'create table notes (id integer primary key, body text)',
		result: {
			columns: [],
			rows: [],
			rowCount: 0,
			rowsRead: 1,
			rowsWritten: 2,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 0, rowsWritten: 0 },
	},
	{
		query: 'insert into notes (body) values (?), (?), (?)',
		params: ['a', 'b', 'c'],
		result: {
			columns: [],
			rows: [],
			rowCount: 0,
			rowsRead: 0,
			rowsWritten: 3,
			truncated: false,
			warning: null,
		},
	},
	{
		query: 'select id, body from notes order by id',
		result: {
			columns: ['id', 'body'],
			rows: [
				{ id: 1, body: 'a' },
				{ id: 2, body: 'b' },
				{ id: 3, body: 'c' },
			],
			rowCount: 3,
			rowsRead: 3,
			rowsWritten: 0,
			truncated: false,
			warning: null,
		},
	},
	{
		query: 'select count(*) as n from notes',
		result: {
			columns: ['n'],
			rows: [{ n: 3 }],
			rowCount: 1,
			rowsRead: 3,
			rowsWritten: 0,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 1, rowsWritten: 0 },
	},
	{
		query: 'select body from notes where id = :id',
		params: [2],
		result: {
			columns: ['body'],
			rows: [{ body: 'b' }],
			rowCount: 1,
			rowsRead: 1,
			rowsWritten: 0,
			truncated: false,
			warning: null,
		},
	},
	{
		query: 'update notes set body = ? where id = ? returning id, body',
		params: ['z', 1],
		result: {
			columns: ['id', 'body'],
			rows: [{ id: 1, body: 'z' }],
			rowCount: 1,
			rowsRead: 2,
			rowsWritten: 1,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 1, rowsWritten: 1 },
	},
	{
		query: 'update notes set body = ? where id = 99 returning id',
		params: ['nope'],
		result: {
			columns: ['id'],
			rows: [],
			rowCount: 0,
			rowsRead: 2,
			rowsWritten: 0,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 0, rowsWritten: 0 },
	},
	{
		query: 'delete from notes where id = ?',
		params: [3],
		result: {
			columns: [],
			rows: [],
			rowCount: 0,
			rowsRead: 1,
			rowsWritten: 1,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 0, rowsWritten: 1 },
	},
	{
		query:
			"create table tags (name text); insert into tags (name) values ('x'), ('y')",
		result: {
			columns: [],
			rows: [],
			rowCount: 0,
			rowsRead: 0,
			rowsWritten: 2,
			truncated: false,
			warning: null,
		},
	},
	{
		query: 'pragma table_info(tags)',
		result: {
			columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'],
			rows: [
				{
					cid: 0,
					name: 'name',
					type: 'TEXT',
					notnull: 0,
					dflt_value: null,
					pk: 0,
				},
			],
			rowCount: 1,
			rowsRead: 0,
			rowsWritten: 0,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 1, rowsWritten: 0 },
	},
	{
		query: 'select ? as yes, ? as no, ? as missing',
		params: [true, false, null],
		result: {
			columns: ['yes', 'no', 'missing'],
			rows: [{ yes: 1, no: 0, missing: null }],
			rowCount: 1,
			rowsRead: 0,
			rowsWritten: 0,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 1, rowsWritten: 0 },
	},
	{
		query: 'drop table tags',
		result: {
			columns: [],
			rows: [],
			rowCount: 0,
			rowsRead: 3,
			rowsWritten: 0,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 2, rowsWritten: 0 },
	},
	{
		query: 'create table big (id integer primary key, v integer)',
		result: {
			columns: [],
			rows: [],
			rowCount: 0,
			rowsRead: 1,
			rowsWritten: 2,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 0, rowsWritten: 0 },
	},
	{
		query:
			'with recursive seq(i) as (select 1 union all select i + 1 from seq where i < 1001) insert into big (v) select i from seq',
		result: {
			columns: [],
			rows: [],
			rowCount: 0,
			rowsRead: 1002,
			rowsWritten: 1001,
			truncated: false,
			warning: null,
		},
		mockCounters: { rowsRead: 0, rowsWritten: 1001 },
	},
	{
		query: 'select id from big',
		result: {
			columns: ['id'],
			firstRow: { id: 1 },
			rowCount: 1000,
			rowsRead: 1001,
			rowsWritten: 0,
			truncated: true,
			warning: null,
		},
	},
	{
		query: 'update big set v = v + 1 returning id',
		result: {
			columns: ['id'],
			firstRow: { id: 1 },
			rowCount: 1000,
			rowsRead: 4004,
			rowsWritten: 1001,
			truncated: true,
			warning: null,
		},
		mockCounters: { rowsRead: 1001, rowsWritten: 1001 },
	},
	{
		query: 'select ? as a, ? as b',
		params: [1],
		error: 'Wrong number of parameter bindings for SQL query.',
	},
	{
		query: 'select ? as a; select 1 as b',
		params: [1],
		error:
			'When executing multiple SQL statements in a single call, only the last statement can have parameters.',
	},
	{
		query: 'select 1 as a; -- trailing',
		error: 'SQL code did not contain a statement.',
	},
]
