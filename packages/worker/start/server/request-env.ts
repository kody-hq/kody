import { getGlobalStartContext } from '@tanstack/react-start'
import { getEnv } from '../../src/app/env.ts'
import type {} from '../request-context.ts'

/** Keep the provider's per-origin OAuth helpers on the server request boundary. */
export function getStartRequestEnv(): Env {
	const env = getGlobalStartContext()?.env
	if (!env || typeof env !== 'object') {
		throw new Error('Start request bindings are not available')
	}
	// The shared Router registration stays opaque to browser compilation.
	// The server entry supplies Env and getEnv validates this boundary at runtime.
	return getEnv(env as Env)
}
