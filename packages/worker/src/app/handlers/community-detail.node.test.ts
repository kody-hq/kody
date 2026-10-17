import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { CommunityActionError } from '#worker/community/errors.ts'
import { reportWebsiteCommunityPackage } from './community-detail.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	reportCommunityListing: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	reportCommunityListing: (...args: Array<unknown>) =>
		mockModule.reportCommunityListing(...args),
	getCommunityListingWithAggregates: vi.fn(),
}))

const env = {} as Env

test('community report POST enforces auth, validation, and error mapping', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		mcpUser: { userId: ownerIdFromStored('stable-reporter-id') },
	})
	const invalidReason = await reportWebsiteCommunityPackage({
		env,
		user: await mockModule.readAuthenticatedAppUser(),
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: '   ' }),
			},
		),
		listingId: 'listing-1',
		body: { reason: '   ' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	expect(invalidReason.status).toBe(400)
	expect((invalidReason.data as { ok: boolean }).ok).toBe(false)
	expect(mockModule.reportCommunityListing).not.toHaveBeenCalled()

	mockModule.reportCommunityListing.mockResolvedValue({ id: 'report-1' })
	const success = await reportWebsiteCommunityPackage({
		env,
		user: await mockModule.readAuthenticatedAppUser(),
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'Unsafe imports' }),
			},
		),
		listingId: 'listing-1',
		body: { reason: 'Unsafe imports' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	expect(success.status).toBe(200)
	expect(success.data).toEqual({ ok: true })
	expect(mockModule.reportCommunityListing).toHaveBeenCalledWith({
		env,
		userId: ownerIdFromStored('stable-reporter-id'),
		listingId: 'listing-1',
		reason: 'Unsafe imports',
	})

	mockModule.reportCommunityListing.mockRejectedValue(
		new CommunityActionError('banned from community participation'),
	)
	const userFacingError = await reportWebsiteCommunityPackage({
		env,
		user: await mockModule.readAuthenticatedAppUser(),
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'Spam content' }),
			},
		),
		listingId: 'listing-1',
		body: { reason: 'Spam content' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	expect(userFacingError.status).toBe(400)
	expect(userFacingError.data).toEqual({
		ok: false,
		error: 'banned from community participation',
	})

	const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
	mockModule.reportCommunityListing.mockRejectedValue(new Error('db timeout'))
	const serverError = await reportWebsiteCommunityPackage({
		env,
		user: await mockModule.readAuthenticatedAppUser(),
		request: new Request(
			'https://example.com/community/listing-1/report.json',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: 'Spam content' }),
			},
		),
		listingId: 'listing-1',
		body: { reason: 'Spam content' },
		url: new URL('https://example.com/community/listing-1/report.json'),
	} as never)
	expect(serverError.status).toBe(500)
	expect(serverError.data).toEqual({
		ok: false,
		error: 'Unable to submit report.',
	})
	expect(consoleError).toHaveBeenCalled()
	consoleError.mockRestore()
})
