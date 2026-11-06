/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useState } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { TimestampValue } from './account-management-components.tsx'
import { useCredentialMutation } from '../credential-mutation.ts'
import { saveCredentialLocalReads } from '#start/server/credential-local-reads'
import type { CredentialLocalReadsView } from '#universal/credentials-list.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'

const localReadsAnchor = 'local-reads'

const mutedCss = css({ margin: 0, color: colors.textMuted })
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

function localReadsExplanation(vault: boolean) {
	return vault
		? 'While local reads are on, anyone who can use this secret provider can read every value it returns on their own machine with kody secret get or kody run. Kody fetches each value from the provider at read time.'
		: 'While local reads are on, anyone who can use this secret can read its value on their own machine with kody secret get or kody run. Agents need a token that allows local reads.'
}

function commandLabel(command: 'run' | 'get') {
	return command === 'run' ? 'kody run' : 'kody secret get'
}

/** Turn local reads on or off; the server checks the website session and write access. */
function useLocalReadsSwitch(input: {
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
			saveCredentialLocalReads({
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
					: 'Kody could not change local reads.',
			)
		}
	}
	return { enabled, change, error, pending: mutation.isPending }
}

export function CredentialLocalReadsSection(props: {
	view: CredentialLocalReadsView
	orgSlug: string
	vault: boolean
}) {
	const { view } = props
	const toggle = useLocalReadsSwitch({
		orgSlug: props.orgSlug,
		credentialId: view.credentialId,
		enabled: view.enabled,
	})
	return (
		<div css={fieldCss} id={localReadsAnchor}>
			<span css={fieldLabelCss}>Local reads</span>
			<div css={{ display: 'grid', gap: spacing.sm }}>
				<p
					css={{ margin: 0, color: colors.text }}
					data-testid="local-reads-state"
				>
					{toggle.enabled ? 'On.' : 'Off.'}{' '}
					{view.lastReadAt ? (
						<>
							Last local read <TimestampValue value={view.lastReadAt} />.
						</>
					) : (
						'Never read locally.'
					)}
				</p>
				<p css={mutedCss}>{localReadsExplanation(props.vault)}</p>
				{view.canChange ? (
					<div>
						<button
							type="button"
							css={
								toggle.enabled
									? getGhostButtonCss({ size: 'sm' })
									: getPillButtonCss({ size: 'sm' })
							}
							disabled={toggle.pending}
							onClick={() => void toggle.change(!toggle.enabled)}
							data-testid="local-reads-toggle"
						>
							{toggle.enabled ? 'Turn off local reads' : 'Turn on local reads'}
						</button>
					</div>
				) : view.manageHref ? (
					<p css={mutedCss}>
						This is your personal secret.{' '}
						<SiteLink href={view.manageHref}>
							Change local reads on your own credentials page
						</SiteLink>
						.
					</p>
				) : (
					<p css={mutedCss}>
						Only a person with write access to this secret can change local
						reads.
					</p>
				)}
				{toggle.error ? (
					<p role="alert" css={{ margin: 0, color: colors.danger }}>
						{toggle.error}
					</p>
				) : null}
				<p css={mutedCss}>
					Turning local reads off stops new reads. Programs that already read a
					value keep it.
				</p>
				{view.reads ? <LocalReadsList reads={view.reads} /> : null}
			</div>
		</div>
	)
}

function LocalReadsList(props: {
	reads: NonNullable<CredentialLocalReadsView['reads']>
}) {
	if (props.reads.length === 0) {
		return <p css={mutedCss}>No local reads in the last 90 days.</p>
	}
	return (
		<div css={{ overflowX: 'auto' }}>
			<table css={tableCss} aria-label="Local reads">
				<thead>
					<tr>
						<th>When</th>
						<th>Who</th>
						<th>Device or token</th>
						<th>Command</th>
						<th>IP</th>
						<th>Result</th>
					</tr>
				</thead>
				<tbody>
					{props.reads.map((read) => (
						<tr key={read.id}>
							<td>
								<TimestampValue value={read.createdAt} />
							</td>
							<td>
								{read.who ?? 'Unknown'}
								{read.profile ? ` as profile ${read.profile}` : ''}
							</td>
							<td>{read.device ?? 'Unknown'}</td>
							<td>{commandLabel(read.command)}</td>
							<td>{read.ip ?? 'Unknown'}</td>
							<td>
								{read.allowed
									? 'Read'
									: `Refused: ${read.refusal ?? 'Refused'}`}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<p css={mutedCss}>
				Kody keeps local reads for 90 days. Values are never recorded.
			</p>
		</div>
	)
}

export type LocalReadsApprovalProps = {
	orgSlug: string
	approval:
		| {
				ok: true
				credentialId: string
				name: string
				vault: boolean
				enabled: boolean
				canChange: boolean
				detailHref: string
		  }
		| { ok: false; message: string }
}

/** The page a refused CLI read links to: one button turns local reads on. */
export function LocalReadsApprovalPage(props: LocalReadsApprovalProps) {
	const { approval } = props
	if (!approval.ok) {
		return (
			<section css={{ display: 'grid', gap: spacing.sm, maxWidth: '40rem' }}>
				<h1 css={cardTitleCss}>Turn on local reads</h1>
				<p css={descriptionCss}>{approval.message}</p>
			</section>
		)
	}
	return <LocalReadsApprovalForm orgSlug={props.orgSlug} approval={approval} />
}

function LocalReadsApprovalForm(props: {
	orgSlug: string
	approval: Extract<LocalReadsApprovalProps['approval'], { ok: true }>
}) {
	const { approval } = props
	const toggle = useLocalReadsSwitch({
		orgSlug: props.orgSlug,
		credentialId: approval.credentialId,
		enabled: approval.enabled,
	})
	return (
		<section
			css={{ display: 'grid', gap: spacing.md, maxWidth: '40rem' }}
			data-testid="local-reads-approval"
		>
			<h1 css={cardTitleCss}>
				Turn on local reads for{' '}
				{approval.vault ? 'the secret provider' : 'the secret'}{' '}
				<code>{approval.name}</code>?
			</h1>
			<p css={descriptionCss}>{localReadsExplanation(approval.vault)}</p>
			<p css={mutedCss}>
				Local reads stay on until a person turns them off. Every read is listed
				on the secret&apos;s page, without the value.
			</p>
			{toggle.enabled ? (
				<p css={{ margin: 0, color: colors.text }} role="status">
					Local reads are on for <code>{approval.name}</code>. Run your command
					again.
				</p>
			) : approval.canChange ? (
				<div>
					<button
						type="button"
						css={getPillButtonCss()}
						disabled={toggle.pending}
						onClick={() => void toggle.change(true)}
						data-testid="local-reads-approve"
					>
						Turn on local reads
					</button>
				</div>
			) : (
				<p css={mutedCss}>
					You can use this secret, but only a person with write access to it can
					turn on local reads. Ask one of them to open this page.
				</p>
			)}
			{toggle.error ? (
				<p role="alert" css={{ margin: 0, color: colors.danger }}>
					{toggle.error}
				</p>
			) : null}
			<div>
				<SiteLink
					href={approval.detailHref}
					css={getGhostButtonCss({ size: 'sm' })}
				>
					Open the secret&apos;s page
				</SiteLink>
			</div>
		</section>
	)
}
