/** @jsxImportSource @emotion/react */
import { updateExperiments } from '#start/server/account-mutations'
import { setExperiment } from '#start/server/experiment-opt-in'
import { type SelfServeExperimentState } from '#universal/feature-flags/experiments.ts'
import { primaryLinkCss } from '#universal/styles/style-primitives.ts'
import { SiteLink } from '../components/site-link.tsx'
import { type AccountExperimentsLoaderData } from '#universal/loader-data.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
} from './account-management-components.tsx'

export function AccountExperimentsPage({
	payload,
	currentHref,
}: {
	payload: AccountExperimentsLoaderData
	currentHref: string
}) {
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const capture = useSubmitterScope()
	const invalidate = usePageInvalidation('permissions', { refreshShell: true })
	const mutation = useMutation({
		gcTime: 0,
		mutationFn: (data: { experimentsOptIn: boolean }) =>
			updateExperiments({ data }),
		onMutate: () => invalidate,
		onSettled: (_result, _error, _input, reconcile) => reconcile?.(),
	})
	const saving = mutation.isPending
	const optedIn = mutation.isPending
		? mutation.variables?.experimentsOptIn === true
		: payload.experimentsOptIn
	async function saveOptIn(enabled: boolean) {
		if (saving) return
		const isCurrent = capture()
		setMessage(null)
		try {
			await mutation.mutateAsync({ experimentsOptIn: enabled })
			if (!isCurrent()) return
			setMessage(
				enabled
					? 'You are opted into experiments. You can turn this off anytime.'
					: 'You are opted out of experiments.',
			)
			setMessageTone('info')
		} catch (error) {
			if (!isCurrent()) return
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update experiments preference.',
			)
			setMessageTone('error')
		}
	}

	return (
		<AccountManagementShell
			layout="form"
			currentHref={currentHref}
			busy={saving}
		>
			<AccountPageHeader
				entity="experiments"
				title="Experiments"
				description="Try early, unfinished features. They may change or go away; turn any of them off anytime."
				currentHref={currentHref}
			/>

			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}
			{payload ? (
				<AccountManagementPanel
					title="Experiments you can try"
					description="Turn each one on or off for your account. Your switch wins over any rollout. Read the guide first: it says what you get and what may change."
				>
					<ExperimentCatalog
						experiments={payload.experiments}
						onMessage={(text, tone) => {
							setMessage(text)
							setMessageTone(tone)
						}}
					/>
				</AccountManagementPanel>
			) : null}
			{payload ? (
				<AccountManagementPanel
					title="Early access audience"
					description="Join to be included when Kody rolls an experiment out to people who opted in. A rollout can turn on experiments above that you have not switched yourself."
				>
					<label
						css={{
							...accountFieldCss,
							display: 'grid',
							gridTemplateColumns: 'auto 1fr',
							gap: spacing.md,
							alignItems: 'start',
						}}
					>
						<input
							type="checkbox"
							checked={optedIn}
							disabled={saving}
							onChange={(event) => {
								if (!(event.currentTarget instanceof HTMLInputElement)) {
									return
								}
								void saveOptIn(event.currentTarget.checked)
							}}
							css={{
								width: '1.25rem',
								height: '1.25rem',
								marginTop: '0.2rem',
								accentColor: colors.primary,
							}}
						/>
						<span>
							<span
								css={{
									...accountFieldLabelCss,
									display: 'block',
									marginBottom: spacing.xs,
									fontSize: typography.fontSize.base,
								}}
							>
								Opt into experiments
							</span>
							<span css={accountFieldNoteCss}>
								Expect unfinished UI, changing behavior, and occasional rough
								edges. Opt out here whenever you want to leave the audience.
							</span>
						</span>
					</label>
					{optedIn ? (
						<p
							css={{
								margin: 0,
								marginTop: spacing.lg,
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
								maxWidth: '60ch',
							}}
						>
							You are in the experiments audience. Individual flags still need
							to be enabled (globally, by percentage, or by override) before you
							see them.
						</p>
					) : (
						<p
							css={{
								margin: 0,
								marginTop: spacing.lg,
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
								maxWidth: '60ch',
							}}
						>
							No experiments are targeted at you while this is off. When
							something is ready for a wider dogfood, it can use this audience —
							you will only see it after you opt in and the flag is on for you.
						</p>
					)}
					{saving ? (
						<p
							css={{
								margin: 0,
								marginTop: spacing.md,
								color: colors.textMuted,
								fontSize: typography.fontSize.sm,
							}}
						>
							Saving…
						</p>
					) : null}
				</AccountManagementPanel>
			) : null}
		</AccountManagementShell>
	)
}

function ExperimentCatalog({
	experiments,
	onMessage,
}: {
	experiments: Array<SelfServeExperimentState>
	onMessage: (text: string, tone: 'info' | 'error') => void
}) {
	const capture = useSubmitterScope()
	const invalidate = usePageInvalidation('permissions', { refreshShell: true })
	const mutation = useMutation({
		gcTime: 0,
		mutationFn: (data: {
			experiment: SelfServeExperimentState['id']
			enabled: boolean
		}) => setExperiment({ data }),
		onMutate: () => invalidate,
		onSettled: (_result, _error, _input, reconcile) => reconcile?.(),
	})
	async function toggle(
		experiment: SelfServeExperimentState,
		enabled: boolean,
	) {
		if (mutation.isPending) return
		const isCurrent = capture()
		try {
			await mutation.mutateAsync({ experiment: experiment.id, enabled })
			if (!isCurrent()) return
			onMessage(
				enabled
					? `${experiment.title} is on for your account.`
					: `${experiment.title} is off for your account.`,
				'info',
			)
		} catch (error) {
			if (!isCurrent()) return
			onMessage(
				error instanceof Error
					? error.message
					: `Unable to update ${experiment.title}.`,
				'error',
			)
		}
	}
	return (
		<ul css={catalogListCss} data-testid="experiment-catalog">
			{experiments.map((experiment) => {
				const pending =
					mutation.isPending && mutation.variables?.experiment === experiment.id
				const enabled = pending
					? mutation.variables?.enabled === true
					: experiment.enabled
				const inputId = `experiment-${experiment.id}`
				return (
					<li
						key={experiment.id}
						css={catalogItemCss}
						data-experiment={experiment.id}
						data-enabled={enabled ? 'true' : 'false'}
					>
						<input
							id={inputId}
							type="checkbox"
							role="switch"
							checked={enabled}
							aria-checked={enabled}
							disabled={mutation.isPending}
							aria-describedby={`${inputId}-summary`}
							onChange={(event) => {
								if (!(event.currentTarget instanceof HTMLInputElement)) return
								void toggle(experiment, event.currentTarget.checked)
							}}
							css={checkboxCss}
						/>
						<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
							<div css={catalogHeadingCss}>
								<label htmlFor={inputId} css={catalogTitleCss}>
									{experiment.title}
								</label>
								<span
									css={enabled ? statusOnCss : statusOffCss}
									data-testid={`${experiment.id}-status`}
								>
									{pending ? 'Saving…' : enabled ? 'On' : 'Off'}
								</span>
							</div>
							<p id={`${inputId}-summary`} css={catalogSummaryCss}>
								{experiment.summary}
							</p>
							<p css={catalogMetaCss}>
								{experiment.stage}{' '}
								{experiment.choice === 'kody' && enabled
									? 'Kody turned this on for you. '
									: null}
								<SiteLink href={experiment.docsPath} css={primaryLinkCss}>
									Read the guide
								</SiteLink>
							</p>
						</div>
					</li>
				)
			})}
		</ul>
	)
}

const catalogListCss = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: spacing.lg,
}

const catalogItemCss = {
	display: 'grid',
	gridTemplateColumns: 'auto 1fr',
	gap: spacing.md,
	alignItems: 'start',
	paddingTop: spacing.lg,
	borderTop: `1px solid ${colors.border}`,
	'&:first-of-type': { paddingTop: 0, borderTop: 'none' },
}

const checkboxCss = {
	width: '1.25rem',
	height: '1.25rem',
	marginTop: '0.2rem',
	accentColor: colors.primary,
}

const catalogHeadingCss = {
	display: 'flex',
	flexWrap: 'wrap' as const,
	alignItems: 'center',
	gap: spacing.sm,
}

const catalogTitleCss = {
	...accountFieldLabelCss,
	fontSize: typography.fontSize.base,
	cursor: 'pointer',
}

const statusBaseCss = {
	padding: '0.05rem 0.5rem',
	borderRadius: '999px',
	fontSize: typography.fontSize.xs,
	fontWeight: 600,
	border: `1px solid ${colors.border}`,
}

const statusOnCss = {
	...statusBaseCss,
	color: colors.primary,
	borderColor: colors.primary,
}

const statusOffCss = {
	...statusBaseCss,
	color: colors.textMuted,
}

const catalogSummaryCss = {
	margin: 0,
	color: colors.text,
	maxWidth: '62ch',
}

const catalogMetaCss = {
	margin: 0,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
	maxWidth: '62ch',
}
