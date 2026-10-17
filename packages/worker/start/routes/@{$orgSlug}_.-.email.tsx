/** @jsxImportSource @emotion/react */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { AccountEmailPage } from '../pages/account-email.tsx'
import { emailSearch, emailResourceInput } from '../pages/email-resources.ts'
import {
	loadEmailResources,
	useEmailResources,
} from '../pages/email-resource-queries.ts'

export const Route = createFileRoute('/@{$orgSlug}_/-/email')({
	staticData: {
		workspaceSwitch: { section: 'email' },
		navigation: { rail: 'workspace', item: 'email' },
		orgScope: { section: 'email' },
	},
	validateSearch: emailSearch,
	search: { middlewares: [stripSearchParams(emailSearch({}))] },
	loaderDeps: ({ search }) => ({
		q: search.q,
		classification: search.classification,
		page: search.page,
		pageSize: search.pageSize,
		selected: search.selected,
	}),
	context: ({ params, deps }) => ({
		emailInput: emailResourceInput(params, deps),
	}),
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
	const emailHref = pageLocation.href
	const { payload, destinations } = useEmailResources(actorKey, emailInput)
	return (
		<AccountEmailPage
			selectedId={emailInput.messageId}
			payload={payload}
			destinations={destinations}
			currentHref={emailHref}
		/>
	)
}
