import { expect, test } from 'vitest'
import {
	classifyApprovalHosts,
	filterValidApprovalHosts,
} from '#universal/approval-host-shape.ts'

test('approval host classification accepts happy-path hosts and rejects truncated or malformed values', () => {
	const classified = classifyApprovalHosts([
		'api.openai.com',
		'hooks.slack.com',
		'api.ope',
		'api.openai.com/v1',
		'  ',
		'',
		'api. openai.com',
		'openai',
		'https://api.github.com/path',
		'localhost',
		'127.0.0.1',
		'API.Cloudflare.com',
	])

	expect(classified.valid).toEqual([
		'127.0.0.1',
		'api.cloudflare.com',
		'api.github.com',
		'api.openai.com',
		'hooks.slack.com',
		'localhost',
	])
	expect(
		classified.rejected.map((entry) => [entry.host, entry.reason]),
	).toEqual([
		['api. openai.com', 'malformed'],
		['api.ope', 'unknown_suffix'],
		['api.openai.com/v1', 'malformed'],
		['openai', 'malformed'],
	])

	expect(
		filterValidApprovalHosts([
			'hooks.slack.com',
			'api.ope',
			'api.openai.com/v1',
		]),
	).toEqual(['hooks.slack.com'])
	expect(classifyApprovalHosts(['', '   '])).toEqual({
		valid: [],
		rejected: [],
	})
	expect(classifyApprovalHosts(['api.test', 'foo.localhost']).valid).toEqual([
		'api.test',
		'foo.localhost',
	])
	expect(
		classifyApprovalHosts(['999.1.1.1', 'com', 'api.o']).rejected.map(
			(entry) => [entry.host, entry.reason],
		),
	).toEqual([
		['999.1.1.1', 'malformed'],
		['api.o', 'unknown_suffix'],
		['com', 'malformed'],
	])
	expect(
		classifyApprovalHosts(['::1', '[::1]', '2001:db8::1', 'not:an:ip']).valid,
	).toEqual(['[2001:db8::1]', '[::1]'])
	expect(
		classifyApprovalHosts(['not:an:ip', '::1/128', '[::1]:443']).rejected.map(
			(entry) => [entry.host, entry.reason],
		),
	).toEqual([
		['::1/128', 'malformed'],
		['[::1]:443', 'malformed'],
		['not:an:ip', 'malformed'],
	])
})
