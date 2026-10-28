/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useEffect, useState } from 'react'
import {
	loadAutomationExecution,
	setAutomationExecution,
} from '#start/server/execution-contexts'
import {
	type AutomationExecutionForm,
	type AutomationExecutionSettingView,
	type AutomationExecutionValue,
	automationChainMaxContexts,
	automationExecutionFormFrom,
	automationExecutionFromForm,
	automationQueueMaxMinutes,
	describeAutomationExecution,
} from '#universal/automation-execution.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import { AccountManagementMessage } from '../pages/account-management-components.tsx'
import { selectCss } from '../pages/package-collaborators-parts.tsx'

export type AutomationExecutionTarget = {
	kind: 'job' | 'webhook' | 'subscription'
	jobId?: string
	packageId?: string
	name?: string
}

type Setting = AutomationExecutionSettingView

type Loaded = {
	ok: true
	setting: Setting
	contexts: Array<{ id: string; name: string }>
}
type Failure = { ok: false; error: string; message?: string }

const sectionCss = css({
	display: 'grid',
	gap: spacing.sm,
	paddingTop: spacing.md,
	borderTop: `1px solid ${colors.border}`,
})
const rowCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.sm,
	alignItems: 'center',
})

/**
 * Where an automation runs. Renders nothing when the execution-contexts flag
 * is off for the viewer, so the surface stays unchanged for everyone else.
 */
export function AutomationExecutionSettings(props: {
	orgSlug: string
	target: AutomationExecutionTarget
}) {
	const [loaded, setLoaded] = useState<Loaded | null>(null)
	const [form, setForm] = useState<AutomationExecutionForm | null>(null)
	const [status, setStatus] = useState<{
		tone: 'error' | 'info'
		text: string
	} | null>(null)
	const [saving, setSaving] = useState(false)
	const targetKey = JSON.stringify(props.target)

	useEffect(() => {
		let cancelled = false
		void (
			loadAutomationExecution({
				data: { orgSlug: props.orgSlug, target: props.target },
			}) as Promise<Loaded | Failure>
		)
			.then((result) => {
				if (cancelled || !result.ok) return
				setLoaded(result)
				setForm(
					automationExecutionFormFrom(
						result.setting.effective,
						result.contexts,
					),
				)
			})
			.catch(() => {})
		return () => {
			cancelled = true
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.orgSlug, targetKey])

	if (!loaded || !form) return null
	const nameFor = (ref: string) =>
		loaded.contexts.find(
			(context) => context.id === ref || context.name === ref,
		)?.name ?? ref
	const { setting } = loaded

	async function save(execution: AutomationExecutionValue | null) {
		setSaving(true)
		setStatus(null)
		const result = (await setAutomationExecution({
			data: {
				orgSlug: props.orgSlug,
				target: props.target,
				execution,
			},
		}).catch((): Failure => ({ ok: false, error: 'unexpected' }))) as
			| { ok: true; setting: Setting }
			| Failure
		setSaving(false)
		if (!result.ok) {
			setStatus({
				tone: 'error',
				text: result.message ?? 'Could not save where this runs. Try again.',
			})
			return
		}
		setLoaded({ ...loaded!, setting: result.setting })
		setForm(
			automationExecutionFormFrom(result.setting.effective, loaded?.contexts),
		)
		setStatus({ tone: 'info', text: 'Saved.' })
	}

	const update = (patch: Partial<AutomationExecutionForm>) =>
		setForm({ ...form, ...patch })
	const contextOptions = loaded.contexts.map((context) => (
		<option key={context.id} value={context.id}>
			{context.name}
		</option>
	))

	return (
		<section css={sectionCss} aria-labelledby="automation-execution-title">
			<h3 id="automation-execution-title" css={cardTitleCss}>
				Where it runs
			</h3>
			<p css={descriptionCss}>
				Now: {describeAutomationExecution(setting.effective, nameFor)}
				{setting.override
					? ' (set here, overriding the package)'
					: setting.declared
						? ' (from the package manifest)'
						: ''}
				. Runs use the access of the person this automation runs as, and
				contexts never see credential values.
			</p>
			{setting.contextRunnable ? null : (
				<AccountManagementMessage tone="error">
					Its handler is not a package export, so it can only run on Kody cloud.
				</AccountManagementMessage>
			)}
			<label css={fieldCss}>
				<span css={fieldLabelCss}>Run on</span>
				<select
					css={selectCss}
					value={form.mode}
					disabled={!setting.contextRunnable}
					onChange={(event) =>
						update({
							mode: event.target.value as AutomationExecutionForm['mode'],
						})
					}
				>
					<option value="cloud">
						Kody cloud (your chain if it needs fs or lan)
					</option>
					<option value="context">One context</option>
					<option value="chain">Its own chain</option>
				</select>
			</label>
			{form.mode === 'context' ? (
				<div css={rowCss}>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Context</span>
						<select
							css={selectCss}
							value={form.context}
							onChange={(event) => update({ context: event.target.value })}
						>
							<option value="">Choose a context</option>
							{contextOptions}
						</select>
					</label>
					<label css={rowCss}>
						<input
							type="checkbox"
							checked={form.fallbackToChain}
							onChange={(event) =>
								update({ fallbackToChain: event.target.checked })
							}
						/>
						Fall back to your chain if it can't run
					</label>
				</div>
			) : null}
			{form.mode === 'chain' ? (
				<div css={rowCss}>
					{Array.from({ length: automationChainMaxContexts }, (_, index) => (
						<label key={index} css={fieldCss}>
							<span css={fieldLabelCss}>{index + 1}.</span>
							<select
								css={selectCss}
								value={form.chain[index] ?? ''}
								aria-label={`Chain entry ${index + 1}`}
								onChange={(event) => {
									const chain = [...form.chain]
									chain[index] = event.target.value
									update({ chain: chain.filter(Boolean) })
								}}
							>
								<option value="">None</option>
								{contextOptions}
							</select>
						</label>
					))}
					<label css={rowCss}>
						<input
							type="checkbox"
							checked={form.cloudLast}
							onChange={(event) => update({ cloudLast: event.target.checked })}
						/>
						Kody cloud last
					</label>
				</div>
			) : null}
			<fieldset css={[rowCss, { border: 0, padding: 0, margin: 0 }]}>
				<legend css={fieldLabelCss}>Needs</legend>
				{(['fs', 'lan'] as const).map((requirement) => (
					<label key={requirement} css={rowCss}>
						<input
							type="checkbox"
							checked={form.requires.includes(requirement)}
							onChange={(event) =>
								update({
									requires: event.target.checked
										? [...form.requires, requirement]
										: form.requires.filter((entry) => entry !== requirement),
								})
							}
						/>
						{requirement === 'fs' ? 'Local files (fs)' : 'Local network (lan)'}
					</label>
				))}
			</fieldset>
			<div css={rowCss}>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>When offline</span>
					<select
						css={selectCss}
						value={form.whenOffline}
						onChange={(event) =>
							update({
								whenOffline: event.target.value === 'queue' ? 'queue' : 'fail',
							})
						}
					>
						<option value="fail">Fail the run</option>
						<option value="queue">Queue until it reconnects</option>
					</select>
				</label>
				{form.whenOffline === 'queue' ? (
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Queue for (minutes)</span>
						<input
							type="number"
							min={1}
							max={automationQueueMaxMinutes}
							value={form.queueMinutes}
							onChange={(event) =>
								update({ queueMinutes: Number(event.target.value) || 1 })
							}
						/>
					</label>
				) : null}
			</div>
			<div css={rowCss}>
				<button
					type="button"
					css={getPillButtonCss()}
					disabled={saving || !setting.contextRunnable}
					onClick={() => {
						const execution = automationExecutionFromForm(form)
						if (!execution) {
							setStatus({
								tone: 'error',
								text: 'Pick a context, or at least one chain entry, before saving.',
							})
							return
						}
						void save(execution)
					}}
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
				{setting.override ? (
					<button
						type="button"
						css={getGhostButtonCss()}
						disabled={saving}
						onClick={() => void save(null)}
					>
						Use the package setting
					</button>
				) : null}
			</div>
			{status ? (
				<AccountManagementMessage tone={status.tone}>
					{status.text}
				</AccountManagementMessage>
			) : null}
		</section>
	)
}
