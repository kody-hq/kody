import { expect, test } from 'vitest'
import {
	findSecretPlaceholderRequestPlacements,
	formatSecretPlaceholderRequestPlacementNotice,
} from './secret-placeholder-request-placement.ts'

const source = [
	"const ACCOUNT = '{{secret:clerkReviewUserId}}'",
	'export async function run() {',
	"  await fetch('https://api.example.com/v1/reviews', {",
	"    method: 'POST',",
	"    headers: { Authorization: 'Bearer {{secret:apiKey}}' },",
	'    body: JSON.stringify({ userId: ACCOUNT }),',
	'  })',
	"  await fetch('https://api.example.com/v1/items?api_key={{secret:queryKey}}')",
	"  await fetch('https://api.example.com/bot{{integration-token:telegram}}/send')",
	'}',
].join('\n')

test('lists body, query, and path placeholders with file, line, and name, never headers', () => {
	expect(
		findSecretPlaceholderRequestPlacements({ 'src/index.ts': source }),
	).toEqual([
		{
			path: 'src/index.ts',
			line: 6,
			nameKind: 'secret',
			name: 'clerkReviewUserId',
			part: 'body',
		},
		{
			path: 'src/index.ts',
			line: 8,
			nameKind: 'secret',
			name: 'queryKey',
			part: 'query',
		},
		{
			path: 'src/index.ts',
			line: 9,
			nameKind: 'integration',
			name: 'telegram',
			part: 'path',
		},
	])
})

test('skips test files and packages with header-only placeholders', () => {
	expect(
		findSecretPlaceholderRequestPlacements({
			'src/index.ts':
				"export const go = () => fetch('https://api.example.com', { headers: { 'x-api-key': '{{secret:apiKey}}' } })",
			'src/index.test.ts':
				"fetch('https://api.example.com', { body: '{{secret:fixture}}' })",
		}),
	).toEqual([])
})

test('the notice names the fix and the switch decides whether it blocks', () => {
	const hits = findSecretPlaceholderRequestPlacements({
		'src/index.ts': source,
	})
	const warning = formatSecretPlaceholderRequestPlacementNotice({
		hits,
		mode: 'warn',
	})
	expect(warning).toContain('WARNING:')
	expect(warning).toContain(
		'- src/index.ts:6: secret "clerkReviewUserId" in the request body',
	)
	expect(warning).toContain(
		'- src/index.ts:9: integration token "telegram" in the URL path',
	)
	expect(warning).toContain('move the credential into a request header')
	expect(warning).toContain('This does not block publish.')
	const failure = formatSecretPlaceholderRequestPlacementNotice({
		hits,
		mode: 'fail',
	})
	expect(failure).toContain('Publish failed:')
	expect(failure).toContain('This blocks publish.')
	expect(failure).not.toContain('owner can allow')
	expect(
		formatSecretPlaceholderRequestPlacementNotice({ hits: [], mode: 'warn' }),
	).toBeNull()
})

test('caps the listed sites', () => {
	const many = Array.from(
		{ length: 12 },
		(_, index) =>
			`fetch('https://api.example.com', { body: '{{secret:key${index}}}' })`,
	).join('\n')
	const notice = formatSecretPlaceholderRequestPlacementNotice({
		hits: findSecretPlaceholderRequestPlacements({ 'src/index.ts': many }),
		mode: 'warn',
	})
	expect(notice).toContain('- and 2 more')
})
