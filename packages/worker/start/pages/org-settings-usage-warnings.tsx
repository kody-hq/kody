/** @jsxImportSource @emotion/react */
import { updateOrganizationUsageWarnings } from '#start/server/org-settings-mutations'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { type OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { orgUsagePath } from '#universal/org-pages.ts'
import {
	getPillButtonCss,
	primaryLinkCss,
	visuallyHiddenCss,
} from '#universal/styles/style-primitives.ts'
import { SiteLink } from '../components/site-link.tsx'
import { renderIcon } from '../components/icon.tsx'
import { orgSettingsMutationOptions } from '../org-settings-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	accountActionsCss,
	accountFieldNoteCss,
} from './account-management-components.tsx'
import {
	checkboxCss,
	checkLabelCss,
	checkRowCss,
	checkTextCss,
	fieldsetCss,
	formCss,
	mutedCopyCss,
} from './org-settings-member-creation.tsx'

const usageWarningsLabel = 'Send usage warnings'
const usageWarningsDescription =
	'Email billing contacts when this organization reaches 80% and 100% of a monthly limit, and add a once-a-month heads-up to agent execute responses.'

export function OrgSettingsUsageWarnings({
	data,
	queryKey,
}: {
	data: OrgSettingsLoaderData
	queryKey: QueryKey
}) {
	const saved = data.usageWarnings
	const client = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const [draft, setDraft] = useState(saved)
	const [draftBase, setDraftBase] = useState(saved)
	if (draftBase !== saved) {
		setDraftBase(saved)
		setDraft(saved)
	}
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const mutation = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			updateOrganizationUsageWarnings,
		),
	)
	const unchanged = draft === saved
	const usageLink = (
		<SiteLink css={primaryLinkCss} href={orgUsagePath(data.org.slug)}>
			Usage
		</SiteLink>
	)
	return (
		<AccountManagementPanel
			title="Usage warnings"
			description="Warnings before this organization runs out of included usage. Limits and billing still apply when warnings are off."
		>
			{data.canManageDomains ? (
				<form
					css={formCss}
					data-testid="org-settings-usage-warnings"
					onSubmit={(event) => {
						event.preventDefault()
						if (mutation.isPending || unchanged) return
						const isCurrent = capture()
						setMessage(null)
						mutation.mutate(
							{ orgSlug: data.org.slug, enabled: draft },
							{
								onSuccess: () => {
									if (isCurrent())
										setMessage({
											tone: 'info',
											text: draft
												? 'Usage warnings turned on.'
												: 'Usage warnings turned off.',
										})
								},
								onError: (error) => {
									if (isCurrent())
										setMessage({ tone: 'error', text: error.message })
								},
							},
						)
					}}
				>
					<fieldset css={fieldsetCss} disabled={mutation.isPending}>
						<legend css={visuallyHiddenCss}>Usage warnings</legend>
						<label css={checkRowCss}>
							<input
								type="checkbox"
								name="usageWarnings"
								data-testid="org-settings-usage-warnings-toggle"
								checked={draft}
								css={checkboxCss}
								onChange={(event) => {
									const checked = event.currentTarget.checked
									setMessage(null)
									setDraft(checked)
								}}
							/>
							<span css={checkTextCss}>
								<span css={checkLabelCss}>{usageWarningsLabel}</span>
								<span css={accountFieldNoteCss}>
									{usageWarningsDescription}
								</span>
							</span>
						</label>
					</fieldset>
					<p css={accountFieldNoteCss}>
						Current usage is always on {usageLink}. Agents can change this with{' '}
						<code>orgUpdate</code> (<code>usage_warnings</code>).
					</p>
					{message ? (
						<AccountManagementMessage tone={message.tone}>
							{message.text}
						</AccountManagementMessage>
					) : null}
					<div css={accountActionsCss}>
						<button
							type="submit"
							data-testid="org-settings-usage-warnings-save"
							disabled={unchanged || mutation.isPending}
							css={getPillButtonCss({ size: 'sm' })}
						>
							{renderIcon('check', { size: '1.05rem' })}
							{mutation.isPending ? 'Saving…' : 'Save usage warnings'}
						</button>
					</div>
				</form>
			) : (
				<p css={mutedCopyCss} data-testid="org-settings-usage-warnings-value">
					{usageWarningsLabel}: {saved ? 'On' : 'Off'}. Only an owner can change
					this.
				</p>
			)}
		</AccountManagementPanel>
	)
}
