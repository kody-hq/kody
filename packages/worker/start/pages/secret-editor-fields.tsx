/** @jsxImportSource @emotion/react */
import {
	fromDatetimeLocalValue,
	toDatetimeLocalValue,
} from '@kody-internal/shared/secret-expires-at.ts'
import { type CSSObject } from '@emotion/react'
import { useEffect, useRef, useId } from 'react'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { colors, mq, spacing, typography } from '#universal/styles/tokens.ts'
import { accountDisclosureCss } from './account-management-components.tsx'
import {
	fieldCss,
	fieldLabelCss,
	getSecondaryButtonCss,
	inputCss,
	textareaCss,
} from '#universal/styles/style-primitives.ts'

type SecretEditorFieldsProps = {
	autoFocusKey?: string
	description: string
	onDescriptionChange: (value: string) => void
	expiresAt: string
	onExpiresAtChange: (value: string) => void
	value: string
	onValueChange: (value: string) => void
	showSecretValue: boolean
	onToggleShowSecretValue: () => void
	allowedHosts: Array<string>
	onUpdateAllowedHost: (index: number, value: string) => void
	onAddAllowedHost: () => void
	onRemoveAllowedHost: (index: number) => void
	valuePlaceholder?: string
	allowedHostsListName?: string
}

function focusSecretValueInput(root: Element) {
	const input = root.querySelector('input[data-field="secret-value"]')
	if (!(input instanceof HTMLInputElement)) return false
	input.focus({ preventScroll: true })
	input.scrollIntoView({ block: 'center', inline: 'nearest' })
	return true
}

export function SecretEditorFields(props: SecretEditorFieldsProps) {
	const valueId = useId()
	const valueField = useRef<HTMLDivElement>(null)
	const autoFocusKey = props.autoFocusKey ?? ''
	useEffect(() => {
		if (autoFocusKey && valueField.current)
			focusSecretValueInput(valueField.current)
	}, [autoFocusKey])

	return (
		<>
			<label css={fieldCss}>
				<span css={fieldLabelCss}>Description</span>
				<textarea
					value={props.description}
					rows={3}
					placeholder="What this secret is used for"
					onInput={(event) => {
						props.onDescriptionChange(event.currentTarget.value)
					}}
					css={textareaCss}
				/>
			</label>

			<label css={fieldCss}>
				<span css={fieldLabelCss}>Expires</span>
				<input
					type="datetime-local"
					value={toDatetimeLocalValue(props.expiresAt || null)}
					onInput={(event) => {
						try {
							props.onExpiresAtChange(
								fromDatetimeLocalValue(event.currentTarget.value),
							)
						} catch {
							props.onExpiresAtChange('')
						}
					}}
					css={inputCss}
				/>
				<p css={{ margin: 0, color: colors.textMuted }}>
					Optional. Leave this empty and Kody keeps the secret until you delete
					it. This is Kody’s cutoff, separate from the provider’s own
					expiration.
				</p>
			</label>

			<div css={fieldCss}>
				<label htmlFor={valueId} css={fieldLabelCss}>
					Secret value
				</label>
				<div
					ref={valueField}
					css={{
						position: 'relative',
						display: 'flex',
						alignItems: 'center',
					}}
				>
					{props.showSecretValue ? (
						<input
							type="text"
							required
							autoFocus={Boolean(autoFocusKey)}
							id={valueId}
							data-field="secret-value"
							{...passwordManagerIgnoreProps}
							value={props.value}
							placeholder={props.valuePlaceholder ?? 'Enter the secret value'}
							onInput={(event) => {
								props.onValueChange(event.currentTarget.value)
							}}
							css={{
								...inputCss,
								paddingRight: '4.5rem',
							}}
						/>
					) : (
						<input
							type="password"
							required
							autoFocus={Boolean(autoFocusKey)}
							id={valueId}
							data-field="secret-value"
							{...passwordManagerIgnoreProps}
							value={props.value}
							placeholder={props.valuePlaceholder ?? 'Enter the secret value'}
							onInput={(event) => {
								props.onValueChange(event.currentTarget.value)
							}}
							css={{
								...inputCss,
								paddingRight: '4.5rem',
							}}
						/>
					)}
					<button
						type="button"
						aria-label={
							props.showSecretValue ? 'Hide secret value' : 'Show secret value'
						}
						title={
							props.showSecretValue ? 'Hide secret value' : 'Show secret value'
						}
						onClick={() => props.onToggleShowSecretValue()}
						css={iconButtonCss}
					>
						{props.showSecretValue ? 'Hide' : 'Show'}
					</button>
				</div>
			</div>

			<details css={advancedDetailsCss} data-testid="secret-editor-advanced">
				<summary>Advanced details</summary>
				<div css={{ display: 'grid', gap: spacing.lg }}>
					<div css={{ display: 'grid', gap: spacing.sm }}>
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<span css={fieldLabelCss}>Where this secret can be sent</span>
							<p css={{ margin: 0, color: colors.textMuted }}>
								Leave this empty to ask before Kody sends this secret to a site.
								Self-authored packages do not skip host approval.
							</p>
						</div>
						<div
							data-repeat-list={props.allowedHostsListName}
							css={{ display: 'grid', gap: spacing.sm }}
						>
							{props.allowedHosts.map((host, index) => (
								<div key={index} css={repeatedRowCss}>
									<input
										type="text"
										value={typeof host === 'string' ? host : ''}
										placeholder="api.example.com"
										onInput={(event) => {
											props.onUpdateAllowedHost(
												index,
												event.currentTarget.value,
											)
										}}
										css={inputCss}
									/>

									<button
										type="button"
										onClick={() => props.onRemoveAllowedHost(index)}
										css={secondaryButtonCss}
									>
										Remove
									</button>
								</div>
							))}
						</div>
						<div>
							<button
								type="button"
								onClick={() => props.onAddAllowedHost()}
								css={secondaryButtonCss}
							>
								Add host
							</button>
						</div>
					</div>
				</div>
			</details>
		</>
	)
}

const secondaryButtonCss = getSecondaryButtonCss()

const advancedDetailsCss: CSSObject = {
	...accountDisclosureCss,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const iconButtonCss: CSSObject = {
	position: 'absolute' as const,
	right: spacing.sm,
	top: '50%',
	transform: 'translateY(-50%)',
	background: 'none',
	border: 'none',
	borderRadius: '999px',
	padding: spacing.xs,
	width: '3.5rem',
	height: '2rem',
	color: colors.text,
	cursor: 'pointer',
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	fontSize: '0.75rem',
	fontWeight: 600,
	'&:hover': {
		background: colors.primarySoft,
	},
}

const repeatedRowCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	gap: spacing.sm,
	[mq.mobile]: {
		gridTemplateColumns: '1fr',
	},
}
