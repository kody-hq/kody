import { createServerFn } from '@tanstack/react-start'
import {
	emailListHref,
	emailSearch,
	type EmailListInput,
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
		classification: input.classification,
		page: input.page,
		pageSize: input.pageSize,
	})
	return {
		org: input.org,
		query: search.q.trim(),
		classification: search.classification,
		page: search.page,
		pageSize: search.pageSize,
	}
}
export const loadEmailList = createServerFn({ method: 'GET' })
	.validator(validateList)
	.handler(async ({ data }) => {
		const { bindings, user } = await emailContext(data.org, emailListHref(data))
		const { readAccountEmailData } =
			await import('../../src/app/account-email-data.ts')
		const { selectedMessage: _selectedMessage, ...list } =
			await readAccountEmailData({
				env: bindings,
				user,
				query: data.query,
				classification: data.classification,
				page: data.page,
				pageSize: data.pageSize,
			})
		return list
	})
export const loadEmailDetail = createServerFn({ method: 'GET' })
	.validator((input: { org: string | null; messageId: string }) => {
		validateList({
			...input,
			query: '',
			classification: null,
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
				classification: null,
				page: 1,
				pageSize: 25,
			}),
		)
		const { loadAccountEmailDetail } =
			await import('../../src/app/account-email-data.ts')
		const detail = await loadAccountEmailDetail({
			env: bindings,
			user,
			messageId: data.messageId,
		})
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
