import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'
import {
	fileStorageConfigSchema,
	fileStorageStatusSchema,
} from '#universal/file-storage.ts'
const scope = z.object({ orgSlug: z.string().regex(/^[a-zA-Z0-9_-]+$/) })
export const readFileStorage = createServerFn({ method: 'GET' })
	.validator(scope)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteRead },
			{ websiteCapabilityContext },
			{ getFileStorage },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/files/storage-settings.ts'),
		])
		return withWebsiteRead({ scope: { orgSlug: data.orgSlug } }, (context) =>
			getFileStorage(websiteCapabilityContext(context)).then((result) =>
				fileStorageStatusSchema.parse(result),
			),
		)
	})
export const setFileStorage = createServerFn({ method: 'POST' })
	.validator(
		scope.extend({ configuration: fileStorageConfigSchema.nullable() }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ websiteCapabilityContext },
			{ configureFileStorage },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/website-capability.ts'),
			import('../../src/files/storage-settings.ts'),
		])
		return withWebsiteMutation(
			{ scope: { orgSlug: data.orgSlug } },
			(context) =>
				configureFileStorage(
					websiteCapabilityContext(context),
					data.configuration,
				).then((result) => fileStorageStatusSchema.parse(result)),
		)
	})
