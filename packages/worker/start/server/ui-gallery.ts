import { notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { isNonProductionRuntime } from '../../src/app/deployment-env.ts'
import { getStartRequestEnv } from './request-env.ts'

/** The component gallery is developer tooling: 404 unless the runtime is local dev, test, or preview. */
export const loadUiGallery = createServerFn({ method: 'GET' }).handler(() => {
	if (!isNonProductionRuntime(getStartRequestEnv())) throw notFound()
	return { available: true as const }
})
