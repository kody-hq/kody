import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import type * as MemoryService from '#mcp/memory/service.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	upsertMemory: vi.fn(),
}))

vi.mock('#mcp/memory/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MemoryService>()
	return {
		...actual,
		upsertMemory: (...args: Array<unknown>) => mockModule.upsertMemory(...args),
	}
})

const {
	memoryDetailsMaxLength,
	memorySubjectMaxLength,
	memorySummaryMaxLength,
} = await import('./meta-memory-shared.ts')
const { metaMemoryUpsertCapability } = await import('./meta-memory-upsert.ts')
const { metaMemoryVerifyCapability } = await import('./meta-memory-verify.ts')

function createSignedInCapabilityContext() {
	return {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: {
				userId: personIdFromStored('user-123'),
				email: 'user@example.com',
				displayName: 'User',
			},
		}),
	}
}

const validMemoryFields = {
	subject: 'Preferred editor theme',
	summary: 'User prefers a dark editor theme.',
} as const

const fieldLimits = [
	['subject', memorySubjectMaxLength],
	['summary', memorySummaryMaxLength],
	['details', memoryDetailsMaxLength],
] as const

test('metaMemoryVerify and metaMemoryUpsert reject oversize subject, summary, and details with limit and actual length', async () => {
	const capabilities = [
		[metaMemoryVerifyCapability, validMemoryFields],
		[
			metaMemoryUpsertCapability,
			{ ...validMemoryFields, verified_by_agent: true },
		],
	] as const
	for (const [capability, base] of capabilities) {
		for (const [field, maxLength] of fieldLimits) {
			const error = await capability
				.handler(
					{ ...base, [field]: 'x'.repeat(maxLength + 1) },
					createSignedInCapabilityContext(),
				)
				.catch((caught: unknown) => caught)
			expect(error).toBeInstanceOf(McpCallerError)
			expect((error as Error).message).toContain(
				`Invalid input for capability "${capability.name}".`,
			)
			expect((error as Error).message).toContain(
				`${field} must be at most ${String(maxLength)} characters, got ${String(maxLength + 1)}`,
			)
		}
	}
})
