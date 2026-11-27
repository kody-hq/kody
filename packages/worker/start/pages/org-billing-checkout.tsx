/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { startCheckoutFromLink } from '#start/server/billing-mutations'
import type { OrgBillingCheckoutLoaderData } from '#universal/loader-data.ts'
import { orgBillingPath } from '#universal/org-pages.ts'
import { colors } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	layoutMaxWidths,
} from '#universal/styles/style-primitives.ts'
import { Button } from '../components/button.tsx'
import { TextLink } from '../components/text-link.tsx'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
} from './account-management-components.tsx'

/**
 * Where an agent's checkout link lands. Nothing is sent to Stripe until the
 * person presses the button, and the server checks everything again then.
 */
export function OrgBillingCheckoutPage({
	payload,
	currentHref,
}: {
	payload: OrgBillingCheckoutLoaderData
	currentHref: string
}) {
	return (
		<AccountManagementShell
			layout="form"
			currentHref={currentHref}
			maxWidth={layoutMaxWidths.content}
			busy={false}
		>
			<AccountPageHeader
				entity="billing"
				title="Check out Pro"
				description="You pay on Stripe. Nothing is charged until you finish there."
				currentHref={currentHref}
			/>
			{payload.ok ? (
				<ConfirmPanel payload={payload} />
			) : (
				<AccountManagementPanel title="Checkout is not available">
					<AccountManagementMessage tone="error">
						{payload.reason}
					</AccountManagementMessage>
				</AccountManagementPanel>
			)}
			<p css={descriptionCss}>
				<TextLink
					tone="muted"
					href={orgBillingPath(payload.ok ? payload.org.slug : payload.orgSlug)}
				>
					Back to billing
				</TextLink>
			</p>
		</AccountManagementShell>
	)
}

function ConfirmPanel({
	payload,
}: {
	payload: Extract<OrgBillingCheckoutLoaderData, { ok: true }>
}) {
	const [error, setError] = useState<string | null>(null)
	const { org, interval, offer } = payload
	const orgName = org.displayName
		? `${org.displayName} (@${org.slug})`
		: `@${org.slug}`
	const mutation = useMutation({
		retry: false,
		gcTime: 0,
		mutationFn: () =>
			startCheckoutFromLink({ data: { orgSlug: org.slug, interval } }),
	})
	async function confirm() {
		setError(null)
		try {
			const result = await mutation.mutateAsync()
			window.location.assign(result.url)
		} catch (cause) {
			mutation.reset()
			setError(
				cause instanceof Error
					? cause.message
					: 'Unable to start checkout. Try again shortly.',
			)
		}
	}
	const pending = mutation.isPending || mutation.isSuccess
	return (
		<AccountManagementPanel
			title={`Pro for ${orgName}`}
			description={`Billed ${interval === 'year' ? 'annually' : 'monthly'}, for every owner and member of the organization.`}
		>
			{offer ? (
				<p css={{ margin: 0, color: colors.text }}>
					{offer.applies
						? offer.message
						: `${offer.message} Checkout is at the regular price.`}
				</p>
			) : null}
			{error ? (
				<AccountManagementMessage tone="error">
					{error}
				</AccountManagementMessage>
			) : null}
			<div>
				<Button
					type="button"
					disabled={pending}
					onClick={() => void confirm()}
					variant="primary"
				>
					{pending ? 'Opening Stripe…' : 'Continue to Stripe'}
				</Button>
			</div>
		</AccountManagementPanel>
	)
}
