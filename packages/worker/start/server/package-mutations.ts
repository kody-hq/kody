import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

export const lockPackage = createServerFn({ method: 'POST' })
	.validator(z.object({ packageId: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ lockAccountPackage },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-publish-lock.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await lockAccountPackage({ ...context, ...data })
			setResponseStatus(result.status)
			return result.data
		})
	})

export const unlockPackage = createServerFn({ method: 'POST' })
	.validator(z.object({ packageId: z.string().trim().min(1) }))
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ unlockAccountPackage },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-publish-lock.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await unlockAccountPackage({ ...context, ...data })
			setResponseStatus(result.status)
			return result.data
		})
	})

export const approvePackagePublish = createServerFn({ method: 'POST' })
	.validator(
		z.object({ packageId: z.string().trim().min(1), commit: z.string() }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ approveAccountPackagePublish },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-publish-lock.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await approveAccountPackagePublish({ ...context, ...data })
			setResponseStatus(result.status)
			return result.data
		})
	})

export const setPackageVisibility = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			packageId: z.string().trim().min(1),
			visibility: z.enum(['public', 'private']),
			confirmName: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ setAccountPackageVisibility },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-visibility.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await setAccountPackageVisibility({ ...context, ...data })
			setResponseStatus(result.status)
			return result.data
		})
	})

export const setPackageInternetVisible = createServerFn({ method: 'POST' })
	.validator(
		z.object({
			packageId: z.string().trim().min(1),
			internetVisible: z.boolean(),
			confirmName: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ setAccountPackageInternetVisible },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-capability-approval.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await setAccountPackageInternetVisible({
				...context,
				...data,
			})
			setResponseStatus(result.status)
			return result.data
		})
	})

export const approvePackageCapabilities = createServerFn({ method: 'POST' })
	.validator(
		z.strictObject({
			packageId: z.string().trim().min(1),
			fingerprint: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ approveAccountPackageCapabilities },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-capability-approval.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await approveAccountPackageCapabilities({
				...context,
				...data,
			})
			setResponseStatus(result.status)
			return result.data
		})
	})

export const approvePackageCapabilitiesAndGoPublic = createServerFn({
	method: 'POST',
})
	.validator(
		z.strictObject({
			packageId: z.string().trim().min(1),
			fingerprint: z.string(),
			requestId: z.string().trim().min(1),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ approveAccountPackageCapabilitiesAndGoPublic },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-capability-approval.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await approveAccountPackageCapabilitiesAndGoPublic({
				...context,
				...data,
			})
			setResponseStatus(result.status)
			return result.data
		})
	})

export const approvePackageCredentialNeeds = createServerFn({ method: 'POST' })
	.validator(
		z.strictObject({
			packageId: z.string().trim().min(1),
			requestId: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ approveAccountPackageCredentialNeeds },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-capability-approval.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await approveAccountPackageCredentialNeeds({
				...context,
				...data,
			})
			setResponseStatus(result.status)
			return result.data
		})
	})

export const approvePackageWentPublic = createServerFn({ method: 'POST' })
	.validator(
		z.strictObject({
			packageId: z.string().trim().min(1),
			requestId: z.string(),
		}),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ approveAccountPackageWentPublic },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-capability-approval.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await approveAccountPackageWentPublic({
				...context,
				...data,
			})
			setResponseStatus(result.status)
			return result.data
		})
	})

export const deletePackage = createServerFn({ method: 'POST' })
	.validator(
		z.object({ packageId: z.string().trim().min(1), confirmName: z.string() }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ deleteAccountPackage },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-delete.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await deleteAccountPackage({ ...context, ...data })
			setResponseStatus(result.status)
			return result.data
		})
	})

export const adoptPackageFork = createServerFn({ method: 'POST' })
	.validator(
		z.object({ packageId: z.string().trim().min(1), reviewNote: z.string() }),
	)
	.handler(async ({ data }) => {
		const [
			{ withWebsiteMutation },
			{ adoptAccountPackageFork },
			{ setResponseStatus },
		] = await Promise.all([
			import('./mutation-context.ts'),
			import('../../src/app/account-package-adopt.ts'),
			import('@tanstack/react-start/server'),
		])
		return withWebsiteMutation({}, async (context) => {
			const result = await adoptAccountPackageFork({ ...context, ...data })
			setResponseStatus(result.status)
			return result.data
		})
	})
