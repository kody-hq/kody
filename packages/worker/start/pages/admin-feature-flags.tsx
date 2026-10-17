/** @jsxImportSource @emotion/react */
import {
	setAdminGlobalFeatureFlag,
	setAdminFeatureFlagOverride,
	clearAdminFeatureFlagOverride,
	deleteAdminStaleFeatureFlag,
} from '#start/server/admin-mutations'
import {
	missingSuccessMetricNotice,
	type FeatureFlagSuccessMetricMeasure,
} from '#universal/feature-flags/registry.ts'
import { type FeatureFlagMetricCohort } from '#universal/feature-flags/types.ts'
import {
	type AdminFeatureFlag,
	type AdminFeatureFlagsLoaderData,
} from '#universal/loader-data.ts'
import {
	cardCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
} from '#universal/styles/style-primitives.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { useState, type FormEvent } from 'react'
import { renderAdminFeatureFlagAudienceField } from '../components/admin-feature-flag-audience-field.tsx'
import { formatNullableTimestamp } from '../components/local-timestamp.tsx'
import { useMutation } from '@tanstack/react-query'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AdminPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
	accountInputCss,
} from './account-management-components.tsx'
const selectCss = getSelectCss()
type ActionState =
	| 'idle'
	| 'saving-global'
	| 'saving-override'
	| 'clearing-override'
	| 'deleting-stale'
function formatMeasureLabel(measure: FeatureFlagSuccessMetricMeasure): string {
	switch (measure) {
		case 'event_count':
			return 'event count'
		case 'error_rate':
			return 'error rate'
		case 'avg_duration_ms':
			return 'average duration'
		default:
			measure satisfies never
			return measure
	}
}
function formatMeasureValue(
	measure: FeatureFlagSuccessMetricMeasure,
	cohort: FeatureFlagMetricCohort,
): string {
	switch (measure) {
		case 'event_count':
			return String(cohort.eventCount)
		case 'error_rate':
			return cohort.errorRate === null
				? 'n/a'
				: `${(cohort.errorRate * 100).toFixed(1)}%`
		case 'avg_duration_ms':
			return cohort.avgDurationMs === null
				? 'n/a'
				: `${Math.round(cohort.avgDurationMs)} ms`
		default:
			measure satisfies never
			return 'n/a'
	}
}
function summarizeMetricCohort(
	measure: FeatureFlagSuccessMetricMeasure,
	cohort: FeatureFlagMetricCohort,
): string {
	return `${cohort.users} user(s) · ${cohort.eventCount} event(s) · ${formatMeasureLabel(measure)} ${formatMeasureValue(measure, cohort)}`
}
function summarizeEffectiveSource(flag: AdminFeatureFlag): string {
	if (flag.stale) {
		return 'stale (absent from the code registry)'
	}
	const audienceSuffix =
		flag.global?.audience === 'experiments_opt_in'
			? ' · experiments opt-in only'
			: ''
	if (!flag.global) {
		return flag.defaultEnabled
			? `default (on)${audienceSuffix}`
			: `default (off)${audienceSuffix}`
	}
	if (!flag.global.enabled) {
		return `globally off${audienceSuffix}`
	}
	if (flag.global.rolloutPercent === null) {
		return `globally on${audienceSuffix}`
	}
	return `on for ${flag.global.rolloutPercent}% of users${audienceSuffix}`
}
export function AdminFeatureFlagsPage({
	payload,
	currentHref,
}: {
	payload: AdminFeatureFlagsLoaderData
	currentHref: string
}) {
	const captureSubmitter = useSubmitterScope()
	const invalidate = usePageInvalidation('permissions', { refreshShell: true })
	const setGlobalMutation = useMutation({
		gcTime: 0,
		mutationFn: setAdminGlobalFeatureFlag,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const setOverrideMutation = useMutation({
		gcTime: 0,
		mutationFn: setAdminFeatureFlagOverride,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const clearOverrideMutation = useMutation({
		gcTime: 0,
		mutationFn: clearAdminFeatureFlagOverride,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const deleteStaleMutation = useMutation({
		gcTime: 0,
		mutationFn: deleteAdminStaleFeatureFlag,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const featureFlags = payload.featureFlags
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const actionState: ActionState = setGlobalMutation.isPending
		? 'saving-global'
		: setOverrideMutation.isPending
			? 'saving-override'
			: clearOverrideMutation.isPending
				? 'clearing-override'
				: deleteStaleMutation.isPending
					? 'deleting-stale'
					: 'idle'

	async function submitAdminAction(
		submit: () => Promise<unknown>,
		successMessage: string,
	): Promise<boolean> {
		const isCurrent = captureSubmitter()
		setMessage(null)
		setMessageTone('info')
		try {
			await submit()
			if (!isCurrent()) return false
			setMessage(successMessage)
			setMessageTone('info')
			return true
		} catch (error) {
			if (!isCurrent()) return false
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to update feature flags.',
			)
			setMessageTone('error')
			return false
		}
	}
	function handleSaveGlobalSubmit(
		event: FormEvent<HTMLFormElement>,
		key: string,
	) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const formData = new FormData(event.currentTarget)
		const enabled = formData.get('enabled') === 'on'
		const rolloutRaw = String(formData.get('rolloutPercent') ?? '').trim()
		const audience = String(formData.get('audience') ?? 'everyone').trim()
		const note = String(formData.get('note') ?? '')
		void submitAdminAction(
			() =>
				setGlobalMutation.mutateAsync({
					data: {
						key,
						enabled,
						rolloutPercent: rolloutRaw === '' ? null : Number(rolloutRaw),
						audience,
						note,
					},
				}),
			`Saved global state for ${key}.`,
		)
	}
	function handleAddOverrideSubmit(
		event: FormEvent<HTMLFormElement>,
		key: string,
	) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const form = event.currentTarget
		const formData = new FormData(form)
		const username = String(formData.get('username') ?? '').trim()
		const enabled = String(formData.get('enabled') ?? 'true') === 'true'
		void submitAdminAction(
			() =>
				setOverrideMutation.mutateAsync({
					data: {
						key,
						username,
						enabled,
					},
				}),
			`Saved override for ${username} on ${key}.`,
		).then((ok) => {
			if (ok) form.reset()
		})
	}
	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const secondaryButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })
	const isMutating = actionState !== 'idle'
	const registryFlags = featureFlags.filter((flag) => !flag.stale)
	const staleFlags = featureFlags.filter((flag) => flag.stale)
	return (
		<AccountManagementShell
			currentHref={currentHref}
			busy={actionState !== 'idle'}
		>
			<AdminPageHeader
				title="Admin feature flags"
				description="Toggle registry feature flags, set percentage rollouts, and manage per-user overrides."
				currentHref={currentHref}
			/>

			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}
			<div css={{ display: 'grid', gap: spacing.lg }}>
				{registryFlags.map((flag) => (
					<section
						key={`${flag.key}:${flag.global?.updatedAt ?? 'none'}:${flag.global?.audience ?? 'everyone'}:${flag.overrides.length}`}
						css={cardCss}
					>
						<div
							css={{
								display: 'grid',
								gap: spacing.sm,
								marginBottom: spacing.md,
							}}
						>
							<div
								css={{
									display: 'flex',
									justifyContent: 'space-between',
									gap: spacing.md,
									flexWrap: 'wrap',
									alignItems: 'baseline',
								}}
							>
								<h2
									css={{
										fontSize: typography.fontSize.lg,
										fontWeight: typography.fontWeight.semibold,
										margin: 0,
									}}
								>
									<code css={{ fontSize: typography.fontSize.base }}>
										{flag.key}
									</code>
								</h2>
								<p css={{ margin: 0, color: colors.textMuted }}>
									{summarizeEffectiveSource(flag)}
								</p>
							</div>
							<p css={descriptionCss}>
								{flag.description ?? 'No description provided.'}
							</p>
						</div>
						{flag.successMetric ? (
							<div
								data-testid={`success-metric-${flag.key}`}
								css={{
									border: `1px solid ${colors.border}`,
									borderRadius: '0.75rem',
									padding: spacing.md,
									marginBottom: spacing.lg,
									display: 'grid',
									gap: spacing.sm,
								}}
							>
								<h3
									css={{
										margin: 0,
										fontSize: typography.fontSize.base,
										fontWeight: typography.fontWeight.semibold,
									}}
								>
									Success metric:{' '}
									<code css={{ fontSize: typography.fontSize.sm }}>
										{flag.successMetric.eventType}
									</code>{' '}
									{formatMeasureLabel(flag.successMetric.measure)} should{' '}
									{flag.successMetric.goal}
								</h3>
								<p css={descriptionCss}>{flag.successMetric.hypothesis}</p>
								{flag.metricReadout?.status === 'ok' ? (
									<>
										<MetadataGrid
											items={[
												{
													label: 'On cohort',
													value: summarizeMetricCohort(
														flag.successMetric.measure,
														flag.metricReadout.on,
													),
												},
												{
													label: 'Off cohort',
													value: summarizeMetricCohort(
														flag.successMetric.measure,
														flag.metricReadout.off,
													),
												},
												{
													label: 'Override (excluded)',
													value: summarizeMetricCohort(
														flag.successMetric.measure,
														flag.metricReadout.override,
													),
												},
												{
													label: 'Excluded',
													value: `${flag.metricReadout.overrideUsers} override · ${flag.metricReadout.mixedUsers} mixed-exposure`,
												},
											]}
										/>
										<p
											css={{
												margin: 0,
												color: colors.textMuted,
												fontSize: typography.fontSize.sm,
											}}
										>
											Window: {flag.metricReadout.windowStart.slice(0, 10)} to{' '}
											{flag.metricReadout.windowEnd.slice(0, 10)} (current month
											to date). Override users are excluded from on/off because
											they are hand-picked (their usage is still shown above).
											Mixed-exposure users saw both fair values inside the
											window and are excluded so month-level usage is not
											mis-attributed across the switch.
										</p>
									</>
								) : flag.metricReadout?.status === 'unavailable' ? (
									<p
										css={{
											margin: 0,
											color: colors.textMuted,
											fontSize: typography.fontSize.sm,
										}}
									>
										{flag.metricReadout.reason}
									</p>
								) : null}
							</div>
						) : (
							<p
								data-testid={`success-metric-notice-${flag.key}`}
								css={{
									margin: 0,
									marginBottom: spacing.lg,
									padding: spacing.sm,
									border: `1px solid ${colors.border}`,
									borderRadius: '0.75rem',
									background: colors.primarySoftest,
									color: colors.textMuted,
									fontSize: typography.fontSize.sm,
								}}
							>
								{missingSuccessMetricNotice}
							</p>
						)}
						<form
							method="post"
							onSubmit={(event) => handleSaveGlobalSubmit(event, flag.key)}
							css={{
								display: 'grid',
								gap: spacing.md,
								marginBottom: spacing.lg,
							}}
						>
							<div
								css={{
									display: 'grid',
									gridTemplateColumns:
										'auto minmax(0, 8rem) minmax(0, 12rem) minmax(0, 1fr) auto',
									gap: spacing.md,
									alignItems: 'end',
									[mq.tablet]: {
										gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
									},
									[mq.mobile]: {
										gridTemplateColumns: 'minmax(0, 1fr)',
										alignItems: 'stretch',
									},
								}}
							>
								<label
									css={{
										...fieldCss,
										alignContent: 'end',
									}}
								>
									<span css={fieldLabelCss}>Enabled</span>
									<input
										name="enabled"
										type="checkbox"
										defaultChecked={flag.global?.enabled ?? false}
										disabled={isMutating}
										css={{
											width: '1.25rem',
											height: '1.25rem',
											accentColor: colors.primary,
										}}
									/>
								</label>
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Rollout %</span>
									<input
										data-field-ring
										name="rolloutPercent"
										type="number"
										min="0"
										max="100"
										step="1"
										placeholder="All users"
										defaultValue={
											flag.global?.rolloutPercent == null
												? ''
												: String(flag.global.rolloutPercent)
										}
										disabled={isMutating}
										css={accountInputCss}
									/>
								</label>
								{renderAdminFeatureFlagAudienceField({
									audience:
										flag.global?.audience ?? flag.defaultAudience ?? undefined,
									disabled: isMutating,
								})}
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Note</span>
									<input
										data-field-ring
										name="note"
										type="text"
										placeholder="Optional operator note"
										defaultValue={flag.global?.note ?? ''}
										disabled={isMutating}
										css={accountInputCss}
									/>
								</label>
								<button
									type="submit"
									disabled={isMutating}
									css={primaryButtonCss}
								>
									{actionState === 'saving-global' ? 'Saving…' : 'Save'}
								</button>
							</div>
							{flag.global ? (
								<MetadataGrid
									items={[
										{
											label: 'Last updated',
											value: (
												<TimestampValue
													value={flag.global.updatedAt}
													fallback="Never"
												/>
											),
										},
										{
											label: 'Updated by',
											value:
												flag.global.updatedByStableUserId == null ? (
													'Unknown'
												) : (
													<IdValue
														value={flag.global.updatedByStableUserId}
														label="updater id"
													/>
												),
										},
										{
											label: 'Audience',
											value:
												flag.global.audience === 'experiments_opt_in'
													? 'Experiments opt-in'
													: 'Everyone',
										},
										{
											label: 'Note',
											value: flag.global.note || 'None',
										},
									]}
								/>
							) : (
								<p css={{ margin: 0, color: colors.textMuted }}>
									No global row yet — saving creates one. Empty rollout means
									all users when enabled. Audience starts from the flag's
									registry default; choose Experiments opt-in to limit the flag
									to `/account/experiments` members.
								</p>
							)}
						</form>
						<AccountManagementPanel
							title="User overrides"
							description="Per-user overrides win over global state and percentage rollouts."
						>
							{flag.overrides.length === 0 ? (
								<p css={{ margin: 0, color: colors.textMuted }}>
									No overrides.
								</p>
							) : (
								<div css={{ display: 'grid', gap: spacing.sm }}>
									{flag.overrides.map((override) => (
										<div
											key={`${flag.key}:${override.stableUserId}`}
											css={{
												display: 'flex',
												justifyContent: 'space-between',
												gap: spacing.md,
												flexWrap: 'wrap',
												alignItems: 'center',
												border: `1px solid ${colors.border}`,
												borderRadius: '0.75rem',
												padding: spacing.sm,
											}}
										>
											<div>
												<strong>{override.username}</strong>
												<p
													css={{
														margin: 0,
														color: colors.textMuted,
														fontSize: typography.fontSize.sm,
													}}
												>
													{override.enabled ? 'Forced on' : 'Forced off'} ·
													updated {formatNullableTimestamp(override.updatedAt)}
												</p>
											</div>
											<button
												type="button"
												disabled={isMutating}
												onClick={() =>
													void submitAdminAction(
														() =>
															clearOverrideMutation.mutateAsync({
																data: {
																	key: flag.key,
																	stableUserId: override.stableUserId,
																},
															}),
														`Removed override for ${override.username}.`,
													)
												}
												css={secondaryButtonCss}
											>
												{actionState === 'clearing-override'
													? 'Removing…'
													: 'Remove'}
											</button>
										</div>
									))}
								</div>
							)}
							<form
								method="post"
								onSubmit={(event) => handleAddOverrideSubmit(event, flag.key)}
								css={{
									display: 'grid',
									gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 8rem) auto',
									gap: spacing.md,
									alignItems: 'end',
									marginTop: spacing.md,
									[mq.mobile]: {
										gridTemplateColumns: 'minmax(0, 1fr)',
										alignItems: 'stretch',
									},
								}}
							>
								<label css={fieldCss}>
									<span css={fieldLabelCss}>Username</span>
									<input
										data-field-ring
										name="username"
										type="text"
										required
										placeholder="username"
										disabled={isMutating}
										css={accountInputCss}
									/>
								</label>
								<label css={fieldCss}>
									<span css={fieldLabelCss}>State</span>
									<select
										data-field-ring
										name="enabled"
										defaultValue="true"
										disabled={isMutating}
										css={selectCss}
									>
										<option value="true">On</option>
										<option value="false">Off</option>
									</select>
								</label>
								<button
									type="submit"
									disabled={isMutating}
									css={primaryButtonCss}
								>
									{actionState === 'saving-override'
										? 'Adding…'
										: 'Add override'}
								</button>
							</form>
						</AccountManagementPanel>
					</section>
				))}
			</div>
			{staleFlags.length > 0 ? (
				<section css={{ ...cardCss, marginTop: spacing.lg }}>
					<h2
						css={{
							fontSize: typography.fontSize.lg,
							fontWeight: typography.fontWeight.semibold,
							margin: 0,
						}}
					>
						Stale flags
					</h2>
					<p css={descriptionCss}>
						These keys have database rows but are absent from the code registry.
					</p>
					<div css={{ display: 'grid', gap: spacing.md }}>
						{staleFlags.map((flag) => (
							<article
								key={flag.key}
								css={{
									border: `1px solid ${colors.border}`,
									borderRadius: '0.75rem',
									padding: spacing.md,
									display: 'grid',
									gap: spacing.md,
								}}
							>
								<div
									css={{
										display: 'flex',
										justifyContent: 'space-between',
										gap: spacing.md,
										flexWrap: 'wrap',
										alignItems: 'center',
									}}
								>
									<div>
										<code>{flag.key}</code>
										<p css={{ margin: 0, color: colors.textMuted }}>
											{summarizeEffectiveSource(flag)}
											{flag.overrides.length > 0
												? ` · ${flag.overrides.length} override(s)`
												: ''}
										</p>
									</div>
									<button
										type="button"
										disabled={isMutating}
										onClick={() =>
											void submitAdminAction(
												() =>
													deleteStaleMutation.mutateAsync({
														data: {
															key: flag.key,
														},
													}),
												`Deleted stale flag ${flag.key}.`,
											)
										}
										css={dangerButtonCss}
									>
										{actionState === 'deleting-stale' ? 'Deleting…' : 'Delete'}
									</button>
								</div>
							</article>
						))}
					</div>
				</section>
			) : null}
		</AccountManagementShell>
	)
}
