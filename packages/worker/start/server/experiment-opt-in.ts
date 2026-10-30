import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import { selfServeExperimentIds } from '#universal/feature-flags/experiments.ts'

export const setExperiment = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			experiment: z.enum(selfServeExperimentIds),
			enabled: z.boolean(),
		}),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setWebsiteExperiment } =
			await import('../../src/app/experiment-opt-in.ts')
		return withWebsiteMutation({}, (context) =>
			setWebsiteExperiment({ ...context, ...data }),
		)
	})
