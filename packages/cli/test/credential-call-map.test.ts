import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	formatCredentialClientError,
	formatCredentialFlagSuggestion,
	parseCredentialFlag,
	parseCredentialFlags,
} from '../src/credential-call-map.js'
import { buildExecuteToolArgs, resolveCommand } from '../src/cli.js'

const parseTable: Array<{
	flags: Array<string>
	expected: Record<string, unknown>
}> = [
	{ flags: ['github=work'], expected: { github: 'work' } },
	{
		flags: ['x=org:work'],
		expected: { x: { name: 'work', scope: 'org' } },
	},
	{
		flags: ['x=personal:home'],
		expected: { x: { name: 'home', scope: 'personal' } },
	},
	{ flags: ['github='], expected: { github: [] } },
	{
		flags: ['github=work', 'google=org:corp'],
		expected: { github: 'work', google: { name: 'corp', scope: 'org' } },
	},
	{
		flags: ['github=work', 'github=personal:home'],
		expected: { github: ['work', { name: 'home', scope: 'personal' }] },
	},
	{
		// First `:` only when prefix is exactly org/personal — otherwise name as-is.
		flags: ['svc=my:weird:name'],
		expected: { svc: 'my:weird:name' },
	},
	{
		flags: ['k=  padded  '],
		expected: { k: 'padded' },
	},
	{
		flags: ['github= org:work'],
		expected: { github: { name: 'work', scope: 'org' } },
	},
	{
		flags: ['github= personal:home '],
		expected: { github: { name: 'home', scope: 'personal' } },
	},
]

test('parseCredentialFlags parsing table', () => {
	for (const row of parseTable) {
		assert.deepEqual(
			parseCredentialFlags(row.flags),
			row.expected,
			JSON.stringify(row.flags),
		)
	}
	assert.equal(parseCredentialFlags(undefined), undefined)
	assert.equal(parseCredentialFlags([]), undefined)
})

test('parseCredentialFlag accepts name, scoped name, and empty none', () => {
	assert.deepEqual(parseCredentialFlag('github=work'), {
		key: 'github',
		picks: ['work'],
		empty: false,
	})
	assert.deepEqual(parseCredentialFlag('x=org:work'), {
		key: 'x',
		picks: [{ name: 'work', scope: 'org' }],
		empty: false,
	})
	assert.deepEqual(parseCredentialFlag('github='), {
		key: 'github',
		picks: [],
		empty: true,
	})
})

test('parseCredentialFlags rejects empty + named for the same key', () => {
	assert.throws(
		() => parseCredentialFlags(['github=', 'github=work']),
		/cannot combine an empty pick/,
	)
	assert.throws(
		() => parseCredentialFlags(['github=work', 'github=']),
		/cannot combine an empty pick/,
	)
})

test('parseCredentialFlag rejects bad shapes', () => {
	assert.throws(() => parseCredentialFlag('=work'), /Invalid --credential/)
	assert.throws(() => parseCredentialFlag('github'), /Invalid --credential/)
	assert.throws(
		() => parseCredentialFlag(' github=work'),
		/Invalid --credential key/,
	)
	assert.doesNotThrow(() => parseCredentialFlag('github='))
})

test('resolveCommand collects multiple --credential flags', () => {
	const { values } = resolveCommand([
		'execute',
		'--local',
		'--credential',
		'github=work',
		'--credential',
		'x=org:work',
		'--code',
		'export default () => 1',
	])
	assert.deepEqual(values.credential, ['github=work', 'x=org:work'])
})

test('buildExecuteToolArgs attaches credentials for MCP execute', () => {
	assert.deepEqual(
		buildExecuteToolArgs({
			code: 'export default () => 1',
			credentials: { github: 'work' },
		}),
		{ code: 'export default () => 1', credentials: { github: 'work' } },
	)
})

test('formatCredentialClientError prints code, message, and --credential retries', () => {
	assert.equal(
		formatCredentialFlagSuggestion('github', { name: 'work', scope: 'org' }),
		'--credential github=org:work',
	)
	assert.equal(
		formatCredentialFlagSuggestion('github', 'work'),
		'--credential github=work',
	)
	assert.equal(
		formatCredentialFlagSuggestion('github', []),
		'--credential github=',
	)
	const text = formatCredentialClientError({
		code: 'credential_ambiguous',
		message: 'Several credentials match github.',
		retryWith: [
			{
				credentials: {
					github: { name: 'work', scope: 'org' },
				},
			},
			{
				credentials: {
					github: ['personal', { name: 'home', scope: 'personal' }],
				},
			},
		],
	})
	assert.match(
		text,
		/^credential_ambiguous: Several credentials match github\./,
	)
	assert.match(text, /retry: --credential github=org:work/)
	assert.match(text, /retry: --credential github=personal/)
	assert.match(text, /retry: --credential github=personal:home/)
})
