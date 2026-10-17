import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
import { featureWebsiteCommunityPackage } from './community-feature.ts'
import type * as AuditLog from '#worker/audit-log.ts'

const mockModule = vi.hoisted(() => ({
	requireUserWithRole: vi.fn(),
	setCommunityListingFeatured: vi.fn(),
	logAuditEvent: vi.fn(),
}))

vi.mock('#app/permissions-server.ts', () => ({
	requireUserWithRole: (...args: Array<unknown>) =>
		mockModule.requireUserWithRole(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	setCommunityListingFeatured: (...args: Array<unknown>) =>
		mockModule.setCommunityListingFeatured(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

const env = { APP_DB: {} as D1Database } as Env

function buildFeatureRequest(body: unknown) {
	return {
		request: new Request(
			'https://example.com/community/listing-1/feature.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			},
		),
		env,
		listingId: 'listing-1',
		body,
		url: new URL('https://example.com/community/listing-1/feature.json'),
	} as never
}

test('community feature POST enforces admin role, validation, and error mapping', async () => {
	mockModule.requireUserWithRole.mockRejectedValue(
		new Response('Forbidden', { status: 403 }),
	)
	const forbidden = await featureWebsiteCommunityPackage(
		buildFeatureRequest({ featured: true }),
	)
	expect(forbidden.status).toBe(403)
	expect(mockModule.setCommunityListingFeatured).not.toHaveBeenCalled()

	mockModule.requireUserWithRole.mockResolvedValue({
		email: 'admin@example.com',
		mcpUser: { userId: ownerIdFromStored('stable-admin-id') },
	})

	const invalidBody = await featureWebsiteCommunityPackage(
		buildFeatureRequest({ featured: 'yes' }),
	)
	expect(invalidBody.status).toBe(400)
	expect(mockModule.setCommunityListingFeatured).not.toHaveBeenCalled()

	mockModule.setCommunityListingFeatured.mockResolvedValue({
		id: 'listing-1',
		featured: true,
	})
	const success = await featureWebsiteCommunityPackage(
		buildFeatureRequest({ featured: true }),
	)
	expect(success.status).toBe(200)
	expect(success.data).toEqual({ ok: true, featured: true })
	expect(mockModule.setCommunityListingFeatured).toHaveBeenCalledWith({
		env,
		listingId: 'listing-1',
		featured: true,
	})
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'community_listing_feature',
			result: 'success',
			reason: 'listing_id=listing-1;featured=true',
		}),
	)

	mockModule.setCommunityListingFeatured.mockRejectedValue(
		new CommunityActionError('Catalog entry "listing-1" was not found.'),
	)
	const userFacingError = await featureWebsiteCommunityPackage(
		buildFeatureRequest({ featured: true }),
	)
	expect(userFacingError.status).toBe(400)
	expect(userFacingError.data).toEqual({
		ok: false,
		error: 'Catalog entry "listing-1" was not found.',
	})

	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockModule.setCommunityListingFeatured.mockRejectedValue(
		new Error('db timeout'),
	)
	const serverError = await featureWebsiteCommunityPackage(
		buildFeatureRequest({ featured: false }),
	)
	expect(serverError.status).toBe(500)
	expect(serverError.data).toEqual({
		ok: false,
		error: 'Unable to update featuring for this listing.',
	})
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})
