import { expect, test } from 'vitest'
import { z } from 'zod'
import {
	workflowRunListOutputSchema,
	workflowRunListInputSchema,
} from './workflow-list.ts'

test('workflowRunList rejects unknown keys and suggests supported snake_case filters', () => {
	const result = workflowRunListInputSchema.safeParse({
		workflowId: 'dynwf-1',
		packageId: 'pkg-1',
		name: 'publish',
		limit: 5,
	})
	expect(result.success).toBe(false)
	if (result.success) return
	const message = z.prettifyError(result.error)
	expect(message).toContain(
		'workflowId is not a parameter; did you mean workflow_id?',
	)
	expect(message).toContain(
		'packageId is not a parameter; did you mean package_id?',
	)
	expect(message).toContain('name is not a parameter')
})

test('workflowRunList accepts workflow_id, status, package_id, and since', () => {
	const result = workflowRunListInputSchema.safeParse({
		workflow_id: 'dynwf-1',
		status: 'running',
		package_id: 'pkg-1',
		since: '2026-07-01T00:00:00.000Z',
		limit: 10,
	})
	expect(result.success).toBe(true)
	if (!result.success) return
	expect(result.data).toEqual({
		workflow_id: 'dynwf-1',
		status: 'running',
		package_id: 'pkg-1',
		since: '2026-07-01T00:00:00.000Z',
		limit: 10,
	})
})

test('workflowRunList accepts an opaque cursor', () => {
	const result = workflowRunListInputSchema.safeParse({
		cursor: 'opaque-cursor',
		limit: 100,
	})
	expect(result.success).toBe(true)
})

test('workflowRunList documents idempotency_key as opaque and returns next_cursor', () => {
	const output = z.toJSONSchema(workflowRunListOutputSchema) as unknown as {
		properties: {
			next_cursor: unknown
			workflows: {
				items: { properties: Record<string, { description?: string }> }
			}
		}
	}
	expect(output.properties.next_cursor).toBeDefined()
	expect(
		output.properties.workflows.items.properties['idempotency_key']
			?.description,
	).toMatch(/opaque/i)
})
