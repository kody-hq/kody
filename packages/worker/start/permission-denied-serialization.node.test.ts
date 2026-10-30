import { expect, test } from 'vitest'
import { permissionDeniedSerializationAdapter } from './permission-denied-serialization.ts'
import {
	PermissionDeniedError,
	isOnlyPermissionDenied,
	isPermissionDeniedError,
} from '#universal/permission-denied.ts'

test('recognizes our denial and the server AuthorizationError by name only', () => {
	expect(isPermissionDeniedError(new PermissionDeniedError('No.'))).toBe(true)
	const authorization = Object.assign(new Error('Missing email:read.'), {
		name: 'AuthorizationError',
		permission: 'email:read',
	})
	expect(isPermissionDeniedError(authorization)).toBe(true)
	expect(isPermissionDeniedError(new Error('Missing email:read.'))).toBe(false)
	expect(isPermissionDeniedError({ name: 'PermissionDeniedError' })).toBe(false)
})

test('Start adapter rebuilds a typed denial from an AuthorizationError', () => {
	const adapter = permissionDeniedSerializationAdapter
	const authorization = Object.assign(new Error('Missing email:read.'), {
		name: 'AuthorizationError',
		permission: 'email:read',
		orgId: 'org_secret',
	})
	expect(adapter.test(authorization)).toBe(true)
	expect(adapter.test(new Error('boom'))).toBe(false)
	const payload = adapter.toSerializable(authorization)
	expect(payload).toEqual({
		message: 'Missing email:read.',
		permission: 'email:read',
	})
	const rebuilt = adapter.fromSerializable(payload)
	expect(rebuilt).toBeInstanceOf(PermissionDeniedError)
	expect(rebuilt).toMatchObject({
		name: 'PermissionDeniedError',
		message: 'Missing email:read.',
		permission: 'email:read',
		status: 403,
	})
})

test('document status is 403 only when every route failure is a denial', () => {
	const denied = new PermissionDeniedError('No.')
	expect(isOnlyPermissionDenied([denied])).toBe(true)
	expect(isOnlyPermissionDenied([new Error('boom'), denied])).toBe(false)
	expect(isOnlyPermissionDenied([])).toBe(false)
})
