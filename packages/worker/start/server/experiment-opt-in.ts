import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
export const optIntoExperiment = createServerFn({ method: 'POST' })
	.validator(z.enum(['package-skills', 'mcp-events']))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { optIntoWebsiteExperiment } =
			await import('../../src/app/experiment-opt-in.ts')
		return withWebsiteMutation({}, (context) =>
			optIntoWebsiteExperiment({ ...context, experiment: data }),
		)
	})
