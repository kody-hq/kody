import { adminCodemodRunInputSchema } from '#universal/admin-codemod-input.ts'
import {
	providerMarkSaveSchema,
	platformIntegrationSaveSchema,
	adminProviderDeleteSchema,
} from '#universal/admin-provider-mutations.ts'
import {
	setGlobalFeatureFlagSchema,
	setFeatureFlagOverrideSchema,
	clearFeatureFlagOverrideSchema,
	deleteStaleFlagSchema,
	reservedUsernamesSchema,
} from '#universal/admin-setting-mutations.ts'
import {
	assignAdminUserRoleSchema,
	removeAdminUserRoleSchema,
	setAdminUserPlanSchema,
	suspendAdminUserSchema,
	unsuspendAdminUserSchema,
	resumeAdminUserEmailSchema,
	verifyAdminUserEmailSchema,
	mintAdminUserVerificationUrlSchema,
	verifyAdminUserEmailDestinationSchema,
	createAdminUserSchema,
} from '#universal/admin-user-mutations.ts'
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const setAdminGlobalFeatureFlag = createServerFn({ method: 'POST' })
	.validator(setGlobalFeatureFlagSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setAdminGlobalFeatureFlag } =
			await import('../../src/admin/feature-flags-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) =>
			setAdminGlobalFeatureFlag({ request, env, fields: data }),
		)
	})

export const setAdminFeatureFlagOverride = createServerFn({ method: 'POST' })
	.validator(setFeatureFlagOverrideSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setAdminFeatureFlagOverride } =
			await import('../../src/admin/feature-flags-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) =>
			setAdminFeatureFlagOverride({ request, env, fields: data }),
		)
	})

export const clearAdminFeatureFlagOverride = createServerFn({ method: 'POST' })
	.validator(clearFeatureFlagOverrideSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { clearAdminFeatureFlagOverride } =
			await import('../../src/admin/feature-flags-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) =>
			clearAdminFeatureFlagOverride({ request, env, fields: data }),
		)
	})

export const deleteAdminStaleFeatureFlag = createServerFn({ method: 'POST' })
	.validator(deleteStaleFlagSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { deleteAdminStaleFeatureFlag } =
			await import('../../src/admin/feature-flags-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) =>
			deleteAdminStaleFeatureFlag({ request, env, fields: data }),
		)
	})

export const addAdminReservedUsernames = createServerFn({ method: 'POST' })
	.validator(reservedUsernamesSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { addAdminReservedUsernames } =
			await import('../../src/admin/reserved-usernames-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) =>
			addAdminReservedUsernames({ request, env, usernames: data.usernames }),
		)
	})

export const removeAdminReservedUsernames = createServerFn({ method: 'POST' })
	.validator(reservedUsernamesSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { removeAdminReservedUsernames } =
			await import('../../src/admin/reserved-usernames-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) =>
			removeAdminReservedUsernames({ request, env, usernames: data.usernames }),
		)
	})

export const saveAdminProviderMark = createServerFn({ method: 'POST' })
	.validator(providerMarkSaveSchema)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { saveAdminProviderMark }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/admin/provider-marks-operations.ts'),
			])
		return withWebsiteMutation({}, async ({ env, request }) =>
			saveAdminProviderMark({ env, request, data }),
		)
	})

export const deleteAdminProviderMark = createServerFn({ method: 'POST' })
	.validator(adminProviderDeleteSchema)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { deleteAdminProviderMark }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/admin/provider-marks-operations.ts'),
			])
		return withWebsiteMutation({}, async ({ env, request }) =>
			deleteAdminProviderMark({ env, request, slug: data.slug }),
		)
	})

export const saveAdminPlatformIntegration = createServerFn({ method: 'POST' })
	.validator(platformIntegrationSaveSchema)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { saveAdminPlatformIntegration }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/admin/platform-integrations-operations.ts'),
			])
		return withWebsiteMutation({}, async ({ env, request }) =>
			saveAdminPlatformIntegration({ env, request, data }),
		)
	})

export const deleteAdminPlatformIntegration = createServerFn({ method: 'POST' })
	.validator(adminProviderDeleteSchema)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { deleteAdminPlatformIntegration }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/admin/platform-integrations-operations.ts'),
			])
		return withWebsiteMutation({}, async ({ env, request }) =>
			deleteAdminPlatformIntegration({ env, request, slug: data.slug }),
		)
	})

export const dismissAdminCommunityReport = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({ reportId: z.string().min(1), note: z.string().optional() }),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { dismissAdminCommunityReport } =
			await import('../../src/admin/community-reports-operations.ts')
		return withWebsiteMutation({}, async ({ env, request }) => {
			return dismissAdminCommunityReport({ env, request, ...data })
		})
	})
export const delistAdminCommunityReport = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({ reportId: z.string().min(1), note: z.string().optional() }),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { delistAdminCommunityReport } =
			await import('../../src/admin/community-reports-operations.ts')
		return withWebsiteMutation({}, async ({ env, request }) => {
			return delistAdminCommunityReport({ env, request, ...data })
		})
	})
export const deleteAdminCommunityReport = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({ reportId: z.string().min(1), note: z.string().optional() }),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { deleteAdminCommunityReport } =
			await import('../../src/admin/community-reports-operations.ts')
		return withWebsiteMutation({}, async ({ env, request }) => {
			return deleteAdminCommunityReport({ env, request, ...data })
		})
	})
export const banAdminReportReporter = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({ reportId: z.string().min(1), note: z.string().optional() }),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { banAdminReportReporter } =
			await import('../../src/admin/community-reports-operations.ts')
		return withWebsiteMutation({}, async ({ env, request }) => {
			return banAdminReportReporter({ env, request, ...data })
		})
	})
export const banAdminReportOwner = createServerFn({ method: 'POST' })
	.inputValidator(
		z.object({ reportId: z.string().min(1), note: z.string().optional() }),
	)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { banAdminReportOwner } =
			await import('../../src/admin/community-reports-operations.ts')
		return withWebsiteMutation({}, async ({ env, request }) => {
			return banAdminReportOwner({ env, request, ...data })
		})
	})
export const deleteAdminSystemEmail = createServerFn({ method: 'POST' })
	.inputValidator(z.object({ messageId: z.string() }))
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { deleteAdminSystemEmail } =
			await import('../../src/admin/system-email-operations.ts')
		return withWebsiteMutation({}, async ({ env, request }) => {
			return deleteAdminSystemEmail({ env, request, ...data })
		})
	})
export const assignAdminUserRole = createServerFn({ method: 'POST' })
	.inputValidator(assignAdminUserRoleSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { assignAdminUserRole } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return assignAdminUserRole({ env, request, ...data })
		})
	})
export const removeAdminUserRole = createServerFn({ method: 'POST' })
	.inputValidator(removeAdminUserRoleSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { removeAdminUserRole } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return removeAdminUserRole({ env, request, ...data })
		})
	})
export const setAdminUserPlan = createServerFn({ method: 'POST' })
	.inputValidator(setAdminUserPlanSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setAdminUserPlan } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return setAdminUserPlan({ env, request, ...data })
		})
	})
export const suspendAdminUser = createServerFn({ method: 'POST' })
	.inputValidator(suspendAdminUserSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setAdminUserSuspension } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return setAdminUserSuspension({
				env,
				request,
				...data,
				suspended: true,
			})
		})
	})
export const unsuspendAdminUser = createServerFn({ method: 'POST' })
	.inputValidator(unsuspendAdminUserSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { setAdminUserSuspension } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return setAdminUserSuspension({
				env,
				request,
				...data,
				suspended: false,
			})
		})
	})
export const resumeAdminUserEmail = createServerFn({ method: 'POST' })
	.inputValidator(resumeAdminUserEmailSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { resumeAdminUserEmail } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return resumeAdminUserEmail({ env, request, ...data })
		})
	})
export const verifyAdminUserEmail = createServerFn({ method: 'POST' })
	.inputValidator(verifyAdminUserEmailSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { verifyAdminUserEmail } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return verifyAdminUserEmail({ env, request, ...data })
		})
	})
export const mintAdminUserVerificationUrl = createServerFn({ method: 'POST' })
	.inputValidator(mintAdminUserVerificationUrlSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { mintAdminUserVerificationUrl } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return mintAdminUserVerificationUrl({ env, request, ...data })
		})
	})
export const verifyAdminUserEmailDestination = createServerFn({
	method: 'POST',
})
	.inputValidator(verifyAdminUserEmailDestinationSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { verifyAdminUserEmailDestination } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return verifyAdminUserEmailDestination({ env, request, ...data })
		})
	})
export const createAdminUser = createServerFn({ method: 'POST' })
	.inputValidator(createAdminUserSchema)
	.handler(async ({ data }) => {
		const { withWebsiteMutation } = await import('./mutation-context.ts')
		const { createAdminUser } =
			await import('../../src/admin/users-operations.ts')
		return withWebsiteMutation({}, async ({ request, env }) => {
			return createAdminUser({ env, request, ...data })
		})
	})
export const adminCodemodRun = createServerFn({ method: 'POST' })
	.inputValidator(adminCodemodRunInputSchema)
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { adminCodemodsRun }] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/admin/codemods-operations.ts'),
		])
		return withWebsiteMutation({}, async ({ request, env }) =>
			adminCodemodsRun({
				env,
				request,
				url: new URL('/admin/codemods', request.url),
				body: data,
			}),
		)
	})

export const adminCodemodRunStop = createServerFn({ method: 'POST' })
	.inputValidator(z.record(z.string(), z.unknown()))
	.handler(async ({ data }) => {
		const [{ withWebsiteMutation }, { adminCodemodsRunStop }] =
			await Promise.all([
				import('./mutation-context.ts'),
				import('../../src/admin/codemods-operations.ts'),
			])
		return withWebsiteMutation({}, async ({ request, env }) =>
			adminCodemodsRunStop({
				env,
				request,
				url: new URL('/admin/codemods', request.url),
				body: data,
			}),
		)
	})
