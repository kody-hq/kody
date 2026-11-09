/** @jsxImportSource @emotion/react */
import { useState } from 'react'
import type { ReferredByState } from '#universal/referral-program.ts'
import { spacing } from '#universal/styles/tokens.ts'
import {
	descriptionCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { requestAddReferrer } from '../billing-checkout.ts'
import {
	accountFieldCss,
	accountFieldLabelCss,
	accountInputCss,
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'

/**
 * "Referred by" for an existing account. A referral, not a discount: it
 * credits whoever sent you once your first invoice is paid. Hidden after the
 * 72-hour signup window or once the person has paid (`closed`) so it never
 * implies a retroactive reward.
 */
export function ReferredByPanel(props: {
	orgSlug: string
	referredBy: ReferredByState
}) {
	const [state, setState] = useState<ReferredByState>(props.referredBy)
	const [referrer, setReferrer] = useState('')
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	if (state.state === 'closed') return null

	if (state.state === 'attributed') {
		const who = state.referrerUsername
			? `@${state.referrerUsername}`
			: 'Another Kody user'
		return (
			<AccountManagementPanel title="Referred by">
				<p css={descriptionCss}>
					{state.status === 'rewarded'
						? `${who} referred you. You both received one month of Pro.`
						: `${who} referred you. Once both of your emails are verified and your first invoice is paid, you each get one month of Pro.`}
				</p>
			</AccountManagementPanel>
		)
	}

	async function submit() {
		if (!referrer.trim() || pending) return
		setPending(true)
		setError(null)
		const result = await requestAddReferrer({
			orgSlug: props.orgSlug,
			referrer,
		})
		setPending(false)
		if (!result.ok) {
			setError(result.error)
			return
		}
		setState({
			state: 'attributed',
			referrerUsername: result.referrerUsername,
			status: 'pending',
		})
	}

	return (
		<AccountManagementPanel
			title="Referred by"
			description="Did someone send you to Kody? Add their username or referral link within 72 hours of signing up, before your first paid invoice. This credits them: once you both verify your email and that invoice is paid, you each get one month of Pro. It is not a promo code and takes nothing off your price. It can be set once."
		>
			<form
				css={{ display: 'grid', gap: spacing.sm }}
				onSubmit={(event) => {
					event.preventDefault()
					void submit()
				}}
			>
				<div css={accountFieldCss}>
					<label htmlFor="referred-by" css={accountFieldLabelCss}>
						Referrer's username or link
					</label>
					<div
						css={{
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.sm,
							alignItems: 'center',
						}}
					>
						<input
							id="referred-by"
							type="text"
							name="referred-by"
							autoComplete="off"
							spellCheck={false}
							maxLength={256}
							placeholder="@username or kody.codes/?ref=username"
							value={referrer}
							data-field-ring
							css={{ ...accountInputCss, flex: '1 1 16rem' }}
							onChange={(event) => setReferrer(event.currentTarget.value)}
						/>
						<button
							type="submit"
							disabled={pending || !referrer.trim()}
							css={getPillButtonCss({ size: 'sm' })}
						>
							{pending ? 'Saving…' : 'Save referrer'}
						</button>
					</div>
				</div>
				{error ? (
					<AccountManagementMessage tone="error">
						{error}
					</AccountManagementMessage>
				) : null}
			</form>
		</AccountManagementPanel>
	)
}
