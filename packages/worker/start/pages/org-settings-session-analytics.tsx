/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import { TextLink } from '../components/text-link.tsx'
import { updateOrganizationSessionAnalytics } from '#start/server/org-settings-mutations'
import {
	useMutation,
	useQueryClient,
	type QueryKey,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import type { OrgSettingsLoaderData } from '#universal/loader-data.ts'
import { orgSessionInsightsPath } from '#universal/org-pages.ts'
import {
	sessionAnalyticsAskParagraphs,
	sessionAnalyticsOffConfirmation,
} from '#universal/session-analytics.ts'
import { fieldDescriptionCss } from '#universal/styles/style-primitives.ts'
import { renderIcon } from '../components/icon.tsx'
import { orgSettingsMutationOptions } from '../org-settings-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	accountActionsCss,
} from './account-management-components.tsx'
import { formCss, mutedCopyCss } from './org-settings-member-creation.tsx'

const stateLabels = {
	unset: 'Not answered yet. Nothing is collected.',
	enabled: 'On.',
	declined: 'Off. Nothing is collected.',
} as const

export function OrgSettingsSessionAnalytics({
	data,
	queryKey,
}: {
	data: OrgSettingsLoaderData
	queryKey: QueryKey
}) {
	const { state, canChange } = data.sessionAnalytics
	const client = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const capture = useSubmitterScope()
	const [confirmingOff, setConfirmingOff] = useState(false)
	const [message, setMessage] = useState<{
		text: string
		tone: 'info' | 'error'
	} | null>(null)
	const mutation = useMutation(
		orgSettingsMutationOptions(
			client,
			queryKey,
			actorKey,
			updateOrganizationSessionAnalytics,
		),
	)
	const orgName = data.org.displayName ?? data.org.slug
	function save(enabled: boolean) {
		if (mutation.isPending) return
		const isCurrent = capture()
		setMessage(null)
		mutation.mutate(
			{ orgSlug: data.org.slug, enabled },
			{
				onSuccess: () => {
					if (!isCurrent()) return
					setConfirmingOff(false)
					setMessage({
						tone: 'info',
						text: enabled
							? 'Session analytics turned on.'
							: state === 'enabled'
								? `Session analytics turned off. Everything stored for ${orgName} was deleted.`
								: 'Session analytics stays off.',
					})
				},
				onError: (error) => {
					if (isCurrent()) setMessage({ tone: 'error', text: error.message })
				},
			},
		)
	}
	return (
		<AccountManagementPanel
			id="session-analytics"
			title="Session analytics"
			description="Help improve Kody by letting it count how agent sessions go. Off until an Owner or Admin turns it on."
		>
			<div css={formCss} data-testid="org-settings-session-analytics">
				<p
					css={mutedCopyCss}
					data-testid="org-settings-session-analytics-state"
				>
					<strong>Session analytics: {stateLabels[state]}</strong>
				</p>
				{sessionAnalyticsAskParagraphs(orgName).map((paragraph) => (
					<p key={paragraph} css={fieldDescriptionCss}>
						{paragraph}
					</p>
				))}
				{state === 'enabled' ? (
					<p css={fieldDescriptionCss}>
						See what is counted, and delete any entry, on{' '}
						<TextLink href={orgSessionInsightsPath(data.org.slug)}>
							Session insights
						</TextLink>
						.
					</p>
				) : null}
				{message ? (
					<AccountManagementMessage tone={message.tone}>
						{message.text}
					</AccountManagementMessage>
				) : null}
				{!canChange ? (
					<p css={mutedCopyCss}>Only an Owner or Admin can change this.</p>
				) : confirmingOff ? (
					<>
						<AccountManagementMessage tone="error">
							{sessionAnalyticsOffConfirmation(orgName)}
						</AccountManagementMessage>
						<div css={accountActionsCss}>
							<Button
								type="button"
								variant="danger"
								data-testid="org-settings-session-analytics-confirm-off"
								disabled={mutation.isPending}
								onClick={() => save(false)}
							>
								{renderIcon('close', { size: '1.05rem' })}
								{mutation.isPending ? 'Turning off…' : 'Turn off and delete'}
							</Button>
							<Button
								type="button"
								variant="secondary"
								disabled={mutation.isPending}
								onClick={() => setConfirmingOff(false)}
							>
								Keep it on
							</Button>
						</div>
					</>
				) : (
					<div css={accountActionsCss}>
						{state === 'enabled' ? (
							<Button
								type="button"
								variant="secondary"
								data-testid="org-settings-session-analytics-off"
								onClick={() => {
									setMessage(null)
									setConfirmingOff(true)
								}}
							>
								Turn off
							</Button>
						) : (
							<>
								<Button
									type="button"
									variant="primary"
									data-testid="org-settings-session-analytics-on"
									disabled={mutation.isPending}
									onClick={() => save(true)}
								>
									{renderIcon('check', { size: '1.05rem' })}
									{mutation.isPending ? 'Saving…' : 'Turn on'}
								</Button>
								{state === 'unset' ? (
									<Button
										type="button"
										variant="secondary"
										data-testid="org-settings-session-analytics-decline"
										disabled={mutation.isPending}
										onClick={() => save(false)}
									>
										No thanks
									</Button>
								) : null}
							</>
						)}
					</div>
				)}
			</div>
		</AccountManagementPanel>
	)
}
