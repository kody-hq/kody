import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	assertPackageScopedSecretWriteAvailable,
	packageScopedSecretWriteUnavailableMessage,
} from './package-scoped-secret-write.ts'

test('package scope without a runtime binding fails closed with a clear message', () => {
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'package',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: null,
				storageId: null,
			},
		}),
	).toThrowError(McpCallerError)
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'package',
			storageContext: null,
		}),
	).toThrowError(packageScopedSecretWriteUnavailableMessage)
})

test('user and session scopes are not gated by package binding', () => {
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'user',
			storageContext: null,
		}),
	).not.toThrow()
	expect(() =>
		assertPackageScopedSecretWriteAvailable({
			scope: 'session',
			storageContext: {
				sessionId: 'sess-1',
				appId: null,
				packageId: null,
				storageId: null,
			},
		}),
	).not.toThrow()
})

test('assert runs before authorize so insufficient_scope is not the first error', async () => {
	const authorize = vi.fn(async () => {
		throw new Error('authorize should not run')
	})
	try {
		assertPackageScopedSecretWriteAvailable({
			scope: 'package',
			storageContext: null,
		})
		await authorize()
		expect.unreachable('expected assert to throw')
	} catch (error) {
		expect(error).toBeInstanceOf(McpCallerError)
		expect(authorize).not.toHaveBeenCalled()
	}
})
