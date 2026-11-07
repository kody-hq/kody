/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useState } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { TimestampValue } from './account-management-components.tsx'
import { useCredentialMutation } from '../credential-mutation.ts'
import { saveCredentialRawSigning } from '#start/server/credential-raw-signing'
import type { CredentialRawSigningView } from '#universal/credentials-list.ts'
import {
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, radius, spacing } from '#universal/styles/tokens.ts'

const rawSigningAnchor = 'raw-signing'

const mutedCss = css({ margin: 0, color: colors.textMuted })
const warningCss = css({
	display: 'grid',
	gap: spacing.xs,
	margin: 0,
	padding: spacing.sm,
	border: `1px solid ${colors.danger}`,
	borderRadius: radius.md,
	color: colors.text,
})
const tableCss = css({
	width: '100%',
	borderCollapse: 'collapse',
	fontSize: '0.875rem',
	'th, td': {
		textAlign: 'left',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderBottom: `1px solid ${colors.border}`,
		verticalAlign: 'top',
	},
})

const warningText =
	'This key can sign anything, including impersonating identities outside allowed-host restrictions.'

/** Turn raw signing on or off; the server checks the website session and ownership. */
function useRawSigningSwitch(input: {
	orgSlug: string
	credentialId: string
	enabled: boolean
}) {
	const [saved, setSaved] = useState<{ from: boolean; to: boolean } | null>(
		null,
	)
	const [error, setError] = useState<string | null>(null)
	const mutation = useCredentialMutation(
		{ orgSlug: input.orgSlug },
		(enabled: boolean) =>
			saveCredentialRawSigning({
				data: {
					orgSlug: input.orgSlug,
					credentialId: input.credentialId,
					enabled,
				},
			}),
	)
	const enabled =
		saved && saved.from === input.enabled ? saved.to : input.enabled
	async function change(next: boolean) {
		setError(null)
		try {
			const result = await mutation.mutateAsync(next)
			setSaved({ from: input.enabled, to: result.enabled })
		} catch (caught) {
			setError(
				caught instanceof Error
					? caught.message
					: 'Kody could not change raw signing.',
			)
		}
	}
	return { enabled, change, error, pending: mutation.isPending }
}

export function CredentialRawSigningSection(props: {
	view: CredentialRawSigningView
	orgSlug: string
}) {
	const { view } = props
	const toggle = useRawSigningSwitch({
		orgSlug: props.orgSlug,
		credentialId: view.credentialId,
		enabled: view.enabled,
	})
	const [confirming, setConfirming] = useState(false)
	return (
		<div css={fieldCss} id={rawSigningAnchor}>
			<span css={fieldLabelCss}>Raw signing</span>
			<div css={{ display: 'grid', gap: spacing.sm }}>
				<p
					css={{ margin: 0, color: colors.text }}
					data-testid="raw-signing-state"
				>
					{toggle.enabled ? 'On.' : 'Off.'}{' '}
					{view.lastSignedAt ? (
						<>
							Last raw signature <TimestampValue value={view.lastSignedAt} />.
						</>
					) : (
						'Never used for a raw signature.'
					)}
				</p>
				<p css={mutedCss}>
					Request signing (http-signature) always works and covers only requests
					to this credential&apos;s hosts. Raw signing lets code sign any string
					with this key, for APIs whose signatures Kody cannot build for them.
				</p>
				<div css={warningCss} role="note" data-testid="raw-signing-warning">
					<strong css={{ color: colors.danger }}>Warning</strong>
					<span>
						{warningText} Anyone who can use this credential could get
						signatures for any request or identity, not only for this
						credential&apos;s hosts. Turn it on only if you trust every person,
						agent, and package that can use it.
					</span>
				</div>
				{view.canChange ? (
					toggle.enabled ? (
						<div>
							<button
								type="button"
								css={getGhostButtonCss({ size: 'sm' })}
								disabled={toggle.pending}
								onClick={() => void toggle.change(false)}
								data-testid="raw-signing-toggle"
							>
								Turn off raw signing
							</button>
						</div>
					) : (
						<div css={{ display: 'grid', gap: spacing.xs }}>
							<label
								css={{
									display: 'flex',
									gap: spacing.xs,
									alignItems: 'flex-start',
								}}
							>
								<input
									type="checkbox"
									checked={confirming}
									onChange={(event) => setConfirming(event.target.checked)}
									data-testid="raw-signing-confirm"
								/>
								<span>
									I understand this key can sign anything, including
									impersonating identities outside allowed-host restrictions.
								</span>
							</label>
							<div>
								<button
									type="button"
									css={getPillButtonCss({ size: 'sm' })}
									disabled={toggle.pending || !confirming}
									onClick={() => void toggle.change(true)}
									data-testid="raw-signing-toggle"
								>
									Turn on raw signing
								</button>
							</div>
						</div>
					)
				) : view.manageHref ? (
					<p css={mutedCss}>
						This is your personal credential.{' '}
						<SiteLink href={view.manageHref}>
							Change raw signing on your own credentials page
						</SiteLink>
						.
					</p>
				) : (
					<p css={mutedCss}>
						Only an owner of this account or org can change raw signing, on the
						website.
					</p>
				)}
				{toggle.error ? (
					<p role="alert" css={{ margin: 0, color: colors.danger }}>
						{toggle.error}
					</p>
				) : null}
				<p css={mutedCss}>
					Turning raw signing off stops new signatures right away. Signatures
					already made stay valid wherever they were sent.
				</p>
				{view.signatures ? (
					<RawSignaturesList signatures={view.signatures} />
				) : null}
			</div>
		</div>
	)
}

function RawSignaturesList(props: {
	signatures: NonNullable<CredentialRawSigningView['signatures']>
}) {
	if (props.signatures.length === 0) {
		return <p css={mutedCss}>No raw signatures in the last 90 days.</p>
	}
	return (
		<div css={{ overflowX: 'auto' }}>
			<table css={tableCss} aria-label="Raw signatures">
				<thead>
					<tr>
						<th>When</th>
						<th>Who</th>
						<th>Via</th>
						<th>Package</th>
						<th>Message size</th>
						<th>Result</th>
					</tr>
				</thead>
				<tbody>
					{props.signatures.map((signature) => (
						<tr key={signature.id}>
							<td>
								<TimestampValue value={signature.createdAt} />
							</td>
							<td>{signature.who ?? 'Unknown'}</td>
							<td>{signature.via ?? 'Unknown'}</td>
							<td>{signature.packageId ?? 'None'}</td>
							<td>
								{signature.messageBytes === null
									? 'Not signed'
									: `${signature.messageBytes} bytes`}
							</td>
							<td>
								{signature.signed
									? 'Signed'
									: `Refused: ${signature.refusal ?? 'Refused'}`}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<p css={mutedCss}>
				Kody keeps raw signatures for 90 days. Keys, messages, and signatures
				are never recorded.
			</p>
		</div>
	)
}
