/** @jsxImportSource @emotion/react */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import {
	AccountEmailMissingGrant,
	AccountEmailPage,
} from '../pages/account-email.tsx'
import { emailSearch, emailResourceInput } from '../pages/email-resources.ts'
import {
	loadEmailResources,
	useEmailResources,
} from '../pages/email-resource-queries.ts'

export const Route = createFileRoute('/_app/@{$orgSlug}_/-/email_/$messageId')({
	staticData: {
		filterSearchKeys: ['q', 'view', 'classification', 'page', 'pageSize'],
		workspaceSwitch: { section: 'email', suffix: [{ param: 'messageId' }] },
		navigation: { rail: 'workspace', item: 'email' },
		orgScope: { section: 'email' },
	},
	validateSearch: emailSearch,
	search: { middlewares: [stripSearchParams(emailSearch({}))] },
	loaderDeps: ({ search }) => ({ selected: search.selected }),
	beforeLoad: ({ params, search }) => ({
		emailInput: emailResourceInput(params, search),
	}),
	shouldReload: ({ context }) => !context.inPlaceNavigation,
	loader: async ({ context }) => {
		await loadEmailResources(
			context.queryClient,
			context.actorKey,
			context.emailInput,
		)
	},
	head: () => ({ meta: [{ title: 'Email inbox' }] }),
	component: Page,
})
function Page() {
	const { actorKey, pageLocation, emailInput } = Route.useRouteContext()
	const { orgSlug } = Route.useParams()
	const emailHref = pageLocation.href
	const resources = useEmailResources(actorKey, emailInput)
	if (resources.missingGrant)
		return (
			<AccountEmailMissingGrant orgSlug={orgSlug} currentHref={emailHref} />
		)
	const { payload, destinations } = resources
	if (!payload) return null
	return (
		<AccountEmailPage
			selectedId={emailInput.messageId}
			payload={payload}
			destinations={destinations}
			currentHref={emailHref}
		/>
	)
}
