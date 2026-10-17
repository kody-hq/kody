/** @jsxImportSource @emotion/react */
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { PasswordRevealInput } from '../components/password-reveal-input.tsx'
import {
	isMaskedLoginField,
	type KeyFormState,
	loginFieldNames,
} from '#client/routes/connect-credential-shared.ts'
import {
	fieldCss,
	fieldLabelCss,
	inputCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
const mutedCss = { margin: 0, color: colors.textMuted }
const labelHintCss = {
	fontWeight: typography.fontWeight.normal,
	color: colors.textMuted,
}
export function renderLoginFields(input: {
	state: KeyFormState
	update: (patch: Partial<KeyFormState>) => void
}) {
	const { state, update } = input
	return (
		<fieldset
			css={{
				display: 'grid',
				gap: spacing.sm,
				border: 'none',
				margin: 0,
				padding: 0,
			}}
		>
			<legend css={{ ...fieldLabelCss, padding: 0 }}>Login</legend>
			{loginFieldNames(state.loginExchange).map((field, index) => {
				const id = `connect-credential-login-${field}`
				const setField = (value: string) =>
					update({ loginFields: { ...state.loginFields, [field]: value } })
				return (
					<div key={field} css={fieldCss}>
						<label htmlFor={id} css={fieldLabelCss}>
							{field.charAt(0).toUpperCase() + field.slice(1)}
						</label>
						{isMaskedLoginField(field) ? (
							<PasswordRevealInput
								id={id}
								required
								{...passwordManagerIgnoreProps}
								value={state.loginFields[field] ?? ''}
								revealNoun={field}
								css={inputCss}
								onChange={(event) => setField(event.currentTarget.value)}
							/>
						) : (
							<input
								id={id}
								required
								autoFocus={index === 0 && Boolean(state.name)}
								{...passwordManagerIgnoreProps}
								value={state.loginFields[field] ?? ''}
								css={inputCss}
								onChange={(event) => setField(event.currentTarget.value)}
							/>
						)}
					</div>
				)
			})}
			<span css={mutedCss}>
				Only Kody sees these. Agents and package code get a session token, never
				your login.
			</span>
		</fieldset>
	)
}
export function renderLoginExchange(input: {
	state: KeyFormState
	update: (patch: Partial<KeyFormState>) => void
}) {
	const { state, update } = input
	const exchange = state.loginExchange
	const setExchange = (patch: Partial<KeyFormState['loginExchange']>) =>
		update({ loginExchange: { ...exchange, ...patch } })
	let exchangeHost: string | null = null
	try {
		exchangeHost = exchange.url ? new URL(exchange.url).host : null
	} catch {
		exchangeHost = null
	}
	return (
		<details
			open={state.loginExchangeOpen}
			data-testid="connect-credential-login-exchange"
			css={{ display: 'grid', gap: spacing.sm }}
			onToggle={(event) => {
				const open = event.currentTarget.open
				if (open !== state.loginExchangeOpen) {
					update({ loginExchangeOpen: open })
				}
			}}
		>
			<summary css={{ cursor: 'pointer' }}>
				{exchangeHost && exchange.tokenPath ? (
					<>
						Kody sends your login to <code>{exchangeHost}</code> and reads the
						session token from <code>{exchange.tokenPath}</code>.
					</>
				) : (
					'How Kody logs in'
				)}
			</summary>
			<div css={{ display: 'grid', gap: spacing.md, paddingTop: spacing.sm }}>
				<div css={fieldCss}>
					<label htmlFor="connect-credential-exchange-url" css={fieldLabelCss}>
						Login URL
					</label>
					<input
						id="connect-credential-exchange-url"
						type="url"
						required
						value={exchange.url}
						placeholder="https://api.example.com/login"
						css={inputCss}
						onChange={(event) =>
							setExchange({ url: event.currentTarget.value })
						}
					/>
				</div>
				<div css={fieldCss}>
					<label
						htmlFor="connect-credential-exchange-format"
						css={fieldLabelCss}
					>
						Sent as
					</label>
					<select
						id="connect-credential-exchange-format"
						value={exchange.bodyFormat}
						css={inputCss}
						onChange={(event) =>
							setExchange({
								bodyFormat:
									event.currentTarget.value === 'form' ? 'form' : 'json',
							})
						}
					>
						<option value="json">JSON</option>
						<option value="form">Form fields</option>
					</select>
				</div>
				<div css={fieldCss}>
					<label htmlFor="connect-credential-exchange-body" css={fieldLabelCss}>
						Request body{' '}
						<span css={labelHintCss}>
							(JSON; <code>{'{username}'}</code> is replaced by that login
							field)
						</span>
					</label>
					<textarea
						id="connect-credential-exchange-body"
						rows={2}
						required
						value={exchange.body}
						css={inputCss}
						onChange={(event) =>
							setExchange({ body: event.currentTarget.value })
						}
					/>
				</div>
				<div css={fieldCss}>
					<label
						htmlFor="connect-credential-exchange-token"
						css={fieldLabelCss}
					>
						Token path{' '}
						<span css={labelHintCss}>(where the response holds it)</span>
					</label>
					<input
						id="connect-credential-exchange-token"
						required
						value={exchange.tokenPath}
						placeholder="data.token"
						css={inputCss}
						onChange={(event) =>
							setExchange({ tokenPath: event.currentTarget.value })
						}
					/>
				</div>
			</div>
		</details>
	)
}
