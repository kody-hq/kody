import { createServerFn } from '@tanstack/react-start'
import {
	emailListHref,
	emailSearch,
	type EmailListInput,
	type EmailListResult,
	type EmailMissingGrant,
} from '../pages/email-resources.ts'
import { readJsonRecord } from './json-value.ts'

function validateList(input: EmailListInput): EmailListInput {
	if (
		!input ||
		(input.org !== null &&
			(typeof input.org !== 'string' ||
				!input.org ||
				/[/\\?#]/.test(input.org)))
	)
		throw new Error('Invalid inbox organization')
	const search = emailSearch({
		q: input.query,
		view: input.view,
		page: input.page,
		pageSize: input.pageSize,
	})
	return {
		org: input.org,
		query: search.q.trim(),
		view: search.view,
		page: search.page,
		pageSize: search.pageSize,
	}
}
export const loadEmailList = createServerFn({ method: 'GET' })
	.validator(validateList)
	.handler(async ({ data }): Promise<EmailListResult> => {
		const { bindings, user } = await emailContext(data.org, emailListHref(data))
		const { readAccountEmailData } =
			await import('../../src/app/account-email-data.ts')
		const result = await unlessEmailReadMissing(() =>
			readAccountEmailData({
				env: bindings,
				user,
				query: data.query,
				view: data.view,
				page: data.page,
				pageSize: data.pageSize,
			}),
		)
		if ('missingGrant' in result) return result
		const { selectedMessage: _selectedMessage, ...list } = result
		return list
	})
export const loadEmailDetail = createServerFn({ method: 'GET' })
	.validator((input: { org: string | null; messageId: string }) => {
		validateList({
			...input,
			query: '',
			view: 'inbox',
			page: 1,
			pageSize: 25,
		})
		if (typeof input.messageId !== 'string' || !input.messageId.trim())
			throw new Error('Invalid email message')
		return { org: input.org, messageId: input.messageId }
	})
	.handler(async ({ data }) => {
		const { bindings, user } = await emailContext(
			data.org,
			emailListHref({
				org: data.org,
				query: '',
				view: 'inbox',
				page: 1,
				pageSize: 25,
			}),
		)
		const { loadAccountEmailDetail } =
			await import('../../src/app/account-email-data.ts')
		const detail = await unlessEmailReadMissing(() =>
			loadAccountEmailDetail({
				env: bindings,
				user,
				messageId: data.messageId,
			}),
		)
		// The list result carries the missing-grant state for the page.
		if (detail && 'missingGrant' in detail) return null
		return detail
			? {
					...detail,
					headers: detail.headers ? readJsonRecord(detail.headers) : null,
				}
			: null
	})
export const loadEmailDestinations = createServerFn({ method: 'GET' }).handler(
	async () => {
		// Notification destinations belong to the signed-in actor, not an org.
		const { bindings, user } = await emailContext(null, '/account/email')
		const {
			listEmailNotificationDestinations,
			buildEmailDestinationsLoaderData,
		} = await import('../../src/email/destinations.ts')
		return buildEmailDestinationsLoaderData(
			await listEmailNotificationDestinations({
				db: bindings.APP_DB,
				dbUserId: user.userId,
				accountEmail: user.email,
				accountEmailVerified: user.emailVerified,
			}),
		)
	},
)

async function emailContext(org: string | null, returnTo: string) {
	const { loadScopedCollection, loadPersonalCollection } =
		await import('./collection-context.ts')
	return org
		? loadScopedCollection({ orgSlug: org, section: 'email', returnTo })
		: loadPersonalCollection(returnTo)
}

/**
 * Members open the Email section by role but read it only with `email:read`.
 * Return that denial as data so the page can explain the grant instead of
 * failing the route. Every other failure still throws.
 */
async function unlessEmailReadMissing<T>(
	read: () => Promise<T>,
): Promise<T | EmailMissingGrant> {
	const { AuthorizationError } =
		await import('#worker/authorization/authorize.ts')
	try {
		return await read()
	} catch (error) {
		if (
			error instanceof AuthorizationError &&
			error.code === 'missing_permission' &&
			error.permission === 'email:read'
		)
			return { missingGrant: 'email:read' }
		throw error
	}
}
