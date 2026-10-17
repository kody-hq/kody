/** @jsxImportSource @emotion/react */
import { css } from '@emotion/react'
import { useState, type FormEvent } from 'react'
import {
	accountActionsCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'
import { saveCredentialHosts } from '#start/server/credential-hosts'
import { useCredentialMutation } from '../credential-mutation.ts'
import { type CredentialHostSettings } from '#universal/credentials-list.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
type CredentialHostsEditorProps = {
	credentialId: string
	credentialName: string
	settings: CredentialHostSettings
	orgSlug: string
}
const listCss = css({
	margin: 0,
	padding: 0,
	listStyle: 'none',
	display: 'grid',
	gap: spacing.xs,
})

const rowCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	alignItems: 'center',
	gap: spacing.sm,
})

const hostCss = css({
	fontFamily: 'monospace',
	fontSize: typography.fontSize.sm,
	overflowWrap: 'anywhere',
	color: colors.text,
})

const fixedNoteCss = css({
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
})

const addFormCss = css({
	display: 'flex',
	flexWrap: 'wrap',
	gap: spacing.sm,
	alignItems: 'center',
})

const inputCss = css({ ...accountInputCss, flex: '1 1 16rem' })

const errorCss = css({
	margin: 0,
	color: colors.error,
	fontSize: typography.fontSize.sm,
})

/** Lowercases and drops `https://` and a trailing slash; the server validates. */
function normalizeTypedHost(raw: string) {
	return raw
		.trim()
		.toLowerCase()
		.replace(/^https:\/\//, '')
		.replace(/\/$/, '')
}

export function CredentialHostsEditor(props: CredentialHostsEditorProps) {
	const { credentialName } = props
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState<string[]>([])
	const [typed, setTyped] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [status, setStatus] = useState<string | null>(null)
	const [saved, setSaved] = useState<{
		settings: CredentialHostSettings
		from: CredentialHostSettings
	} | null>(null)
	const settings =
		saved && saved.from === props.settings ? saved.settings : props.settings
	const mutation = useCredentialMutation(
		{ orgSlug: props.orgSlug },
		(hosts: string[]) => {
			const orgSlug = props.orgSlug
			if (!orgSlug) throw new Error('Organization not found.')
			return saveCredentialHosts({
				data: { orgSlug, credentialId: props.credentialId, hosts },
			})
		},
	)
	const saving = mutation.isPending
	function startEditing() {
		setEditing(true)
		setDraft([...settings.hosts])
		setTyped('')
		setError(null)
		setStatus(null)
	}
	function cancel() {
		setEditing(false)
		setError(null)
	}
	function addTyped(event: FormEvent) {
		event.preventDefault()
		const raw = typed.trim()
		if (!raw) return
		if (raw.toLowerCase().startsWith('http://')) {
			setError(
				'Kody sends credentials only over HTTPS. Enter the host without http://.',
			)
			return
		}
		const host = normalizeTypedHost(raw)
		if (draft.includes(host) || settings.fixedHosts.includes(host)) {
			setError(`${host} is already allowed.`)
			return
		}
		setDraft([...draft, host])
		setTyped('')
		setError(null)
	}
	function remove(host: string) {
		setDraft(draft.filter((entry) => entry !== host))
		setError(null)
	}
	async function save() {
		if (saving) return
		setError(null)
		const pending = normalizeTypedHost(typed)
		try {
			const result = await mutation.mutateAsync(
				pending ? [...draft, pending] : draft,
			)
			setSaved({
				settings: { hosts: result.hosts, fixedHosts: result.fixedHosts },
				from: props.settings,
			})
			setTyped('')
			setEditing(false)
			setStatus(result.changed ? 'Hosts saved.' : 'No changes to save.')
		} catch (caught) {
			setError(
				caught instanceof Error ? caught.message : 'Could not save the hosts.',
			)
		}
	}
	if (!editing) {
		return (
			<div css={css({ display: 'grid', gap: spacing.xs })}>
				<div>
					<button
						type="button"
						data-testid="credential-hosts-edit"
						css={getGhostButtonCss({ size: 'sm' })}
						onClick={startEditing}
					>
						Edit hosts
					</button>
				</div>
				{status ? (
					<p role="status" css={css(accountFieldNoteCss)}>
						{status}
					</p>
				) : null}
			</div>
		)
	}
	return (
		<div
			data-testid="credential-hosts-editor"
			css={css({ display: 'grid', gap: spacing.sm })}
		>
			<p css={css(accountFieldNoteCss)}>
				Kody places this credential only on HTTPS requests to these hosts. Enter
				each host name, such as api.example.com. Wildcards, ports, and paths are
				not allowed.
			</p>
			<ul aria-label={`Hosts for ${credentialName}`} css={listCss}>
				{settings.fixedHosts.map((host) => (
					<li key={`fixed:${host}`} css={rowCss}>
						<span css={hostCss}>{host}</span>
						<span css={fixedNoteCss}>Always allowed</span>
					</li>
				))}
				{draft.map((host) => (
					<li key={host} css={rowCss}>
						<span css={hostCss}>{host}</span>
						<button
							type="button"
							aria-label={`Remove ${host}`}
							css={getGhostButtonCss({ size: 'sm' })}
							onClick={() => remove(host)}
						>
							Remove
						</button>
					</li>
				))}
			</ul>
			<form css={addFormCss} onSubmit={addTyped}>
				<input
					type="text"
					name="host"
					data-field-ring
					data-testid="credential-hosts-input"
					aria-label="Host to allow"
					placeholder="api.example.com"
					autoComplete="off"
					spellCheck={false}
					value={typed}
					css={inputCss}
					onChange={(event) => setTyped(event.currentTarget.value)}
				/>
				<button type="submit" css={css(getGhostButtonCss({ size: 'sm' }))}>
					Add host
				</button>
			</form>
			{error ? (
				<p role="alert" css={errorCss}>
					{error}
				</p>
			) : null}
			<div css={css(accountActionsCss)}>
				<button
					type="button"
					data-testid="credential-hosts-save"
					disabled={saving}
					css={getPillButtonCss({ size: 'sm' })}
					onClick={() => void save()}
				>
					{saving ? 'Saving…' : 'Save hosts'}
				</button>
				<button
					type="button"
					disabled={saving}
					css={getGhostButtonCss({ size: 'sm' })}
					onClick={cancel}
				>
					Cancel
				</button>
			</div>
		</div>
	)
}
