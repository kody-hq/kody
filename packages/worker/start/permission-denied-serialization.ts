import { createSerializationAdapter } from '@tanstack/react-router'
import {
	PermissionDeniedError,
	isPermissionDeniedError,
	toPermissionDeniedPayload,
} from '#universal/permission-denied.ts'

export const permissionDeniedSerializationAdapter = createSerializationAdapter({
	key: 'kody-permission-denied',
	test: isPermissionDeniedError,
	toSerializable: toPermissionDeniedPayload,
	fromSerializable: ({ message, permission }) =>
		new PermissionDeniedError(message, { permission }),
})
