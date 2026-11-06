/**
 * Advertising an MCP `outputSchema` makes strict clients (Claude Code, the
 * MCP SDK Ajv validator) reject any `structuredContent` key missing from the
 * advertised JSON Schema (`additionalProperties: false`). Server-side Zod
 * `safeParse` strips unknown keys and cannot catch that drift.
 *
 * These tests convert each tool's Zod field record the same way tools/list
 * does, then validate representative envelopes with Ajv — including usage,
 * admission, entitlement, and search rateLimit paths.
 */

import { expect, test } from 'vitest'
import { apiToolOutputSchema } from './api.ts'
import { executeToolOutputSchema } from './execute.ts'
import {
	expectMcpToolStructuredContent,
	validateMcpToolStructuredContent,
} from '#worker/test-support/mcp-tool-output-validation.ts'
import { mcpToolOutputJsonSchema } from './mcp-tool-output.ts'
import { searchToolOutputSchema } from './search-tool-definition.ts'

const timing = {
	startedAt: '2026-08-05T00:00:00.000Z',
	endedAt: '2026-08-05T00:00:01.000Z',
	durationMs: 1000,
}

const usage = {
	unit: 'execute_unique_workers',
	day: {
		used: 1,
		limit: 100,
		remaining: 99,
		resetsAt: '2026-08-06T00:00:00.000Z',
	},
}

const entitlement = {
	code: 'entitlement_limit_exceeded',
	resource: 'execute_unique_workers_per_day',
	plan: 'free',
	limit: 100,
	current: 100,
	used: 100,
	remaining: 0,
	upgradeHint: 'upgrade your plan at /@<slug>/-/billing.',
}

test('advertised JSON schemas set additionalProperties false', () => {
	for (const fields of [
		searchToolOutputSchema,
		executeToolOutputSchema,
		apiToolOutputSchema,
	]) {
		const schema = mcpToolOutputJsonSchema(fields)
		expect(schema['additionalProperties']).toBe(false)
	}
})

test('search structured content passes strict client validation for all return paths', () => {
	const payloads = [
		{
			conversationId: 'c1',
			timing,
			result: {
				offline: false,
				warnings: [],
				telemetry: { topResultTypes: ['capability'] },
				phaseTimings: { formattingMs: 2 },
				matches: [{ type: 'capability', name: 'emailSend' }],
			},
		},
		{
			conversationId: 'c1',
			timing,
			result: { entityRef: 'capability:x' },
		},
		{
			conversationId: 'c1',
			timing,
			result: [{ entityRef: 'capability:a', error: 'not found' }],
			error: 'All entity lookups failed.',
		},
		{ conversationId: 'c1', timing, error: 'Provide "query".' },
		{
			conversationId: 'c1',
			timing,
			error: 'Plan limit reached.',
			entitlement,
		},
		{
			conversationId: 'c1',
			timing,
			error: 'Search rate limited.',
			rateLimit: {
				code: 'search_rate_limited',
				window: 'burst',
				retryAfterSeconds: 12,
				limit: 60,
				plan: 'pro',
			},
		},
	]
	for (const payload of payloads) {
		expectMcpToolStructuredContent(searchToolOutputSchema, payload)
	}
})

test('execute structured content passes strict client validation for all return paths', () => {
	const payloads = [
		{
			conversationId: 'c1',
			timing: { ...timing, serverTiming: [{ name: 'registry', ms: 5 }] },
			returnedBytes: 42,
			result: { anything: ['goes', 1, null] },
			logs: ['log line', { level: 'warn' }],
			warnings: ['Consider integration auth helpers for api.example.com.'],
			memories: { surfaced: [], suppressedCount: 0 },
			usage,
		},
		{
			conversationId: 'c1',
			timing,
			returnedBytes: 100000,
			truncated: true,
			note: 'Result truncated to fit responseLimit.',
			result: 'partial…',
			logs: [],
			usage,
		},
		{
			conversationId: 'c1',
			timing,
			returnedBytes: 0,
			error: 'ReferenceError: foo is not defined',
			errorDetails: { phase: 'sandbox' },
			logs: [],
			usage,
		},
		{
			conversationId: 'c1',
			timing,
			returnedBytes: 0,
			error:
				'Kody plan limit reached: your "free" plan allows at most 10 saved packages and you currently have 10.',
			errorDetails: { kind: 'entitlement_limit_exceeded' },
			entitlement: {
				code: 'entitlement_limit_exceeded',
				resource: 'saved_packages',
				plan: 'free',
				limit: 10,
				current: 10,
				upgradeHint: 'upgrade your plan at /@<slug>/-/billing.',
			},
			logs: [],
			usage,
		},
		{
			conversationId: 'c1',
			timing,
			runId: 'run-1',
			replayed: true,
			returnedBytes: 0,
			result: { ok: true },
			logs: [],
			usage,
		},
		{
			conversationId: 'c1',
			timing,
			runId: 'run-1',
			inProgress: true,
			status: 'running',
			usage,
		},
		{
			conversationId: 'c1',
			timing,
			returnedBytes: 0,
			error: 'Identical execute call refused.',
			admission: {
				code: 'execute_rate_limited',
				retryAfterMs: 250,
			},
			logs: [],
			usage,
		},
	]
	for (const payload of payloads) {
		expectMcpToolStructuredContent(executeToolOutputSchema, payload)
	}
})

test('api structured content passes strict client validation for success and error paths', () => {
	const payloads = [
		{
			operationId: 'metaGetCurrentUser',
			result: { user: { email: 'a@example.com' } },
		},
		{
			operationId: 'webhookSyntheticDispatch',
			error: {
				code: 'not_found',
				message: 'Unknown operationId "webhookSyntheticDispatch".',
			},
		},
		{
			operationId: 'packageList',
			result: { packages: [] },
			truncated: true,
			note: 'Result truncated to fit the response limit.',
		},
	]
	for (const payload of payloads) {
		expectMcpToolStructuredContent(apiToolOutputSchema, payload)
	}
})

test('strict validation rejects undeclared top-level fields the way Claude Code does', () => {
	const withExtra = {
		conversationId: 'c1',
		timing,
		returnedBytes: 1,
		result: { ok: true },
		logs: [],
		usage,
		storage: { id: 'bucket-1' },
	}
	const result = validateMcpToolStructuredContent(
		executeToolOutputSchema,
		withExtra,
	)
	expect(result.valid).toBe(false)
	if (result.valid) throw new Error('expected invalid')
	expect(result.errorMessage).toContain('must NOT have additional properties')

	const searchWithExtra = {
		conversationId: 'c1',
		timing,
		error: 'boom',
		unexpected: true,
	}
	const searchResult = validateMcpToolStructuredContent(
		searchToolOutputSchema,
		searchWithExtra,
	)
	expect(searchResult.valid).toBe(false)
})

test('stale execute schema without usage rejects modern usage responses', () => {
	// Documents the 2026-10-11 Claude Code failure: clients that cached
	// tools/list from before #3267 (usage on every execute response) reject
	// live structuredContent with "data must NOT have additional properties".
	const { usage: _usage, ...staleFields } = executeToolOutputSchema
	void _usage
	const modernResponse = {
		conversationId: 'c1',
		timing,
		returnedBytes: 1,
		result: { ok: true },
		logs: [],
		usage,
	}
	const result = validateMcpToolStructuredContent(staleFields, modernResponse)
	expect(result.valid).toBe(false)
	if (result.valid) throw new Error('expected invalid')
	expect(result.errorMessage).toContain('must NOT have additional properties')
})
