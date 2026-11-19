/** @jsxImportSource @emotion/react */
import { fieldDescriptionCss } from '#universal/styles/style-primitives.ts'
import { Button } from '../components/button.tsx'
import { css } from '@emotion/react'
import { useState, type FormEvent } from 'react'
import { accountActionsCss } from './account-management-components.tsx'
import { saveCredentialHosts } from '#start/server/credential-hosts'
import { useCredentialMutation } from '../credential-mutation.ts'
import type { CredentialHostSettings } from '#universal/credentials-list.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import { Input } from '../components/input.tsx'
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
					<Button
						type="button"
						data-testid="credential-hosts-edit"
						variant="secondary"
						onClick={startEditing}
					>
						Edit hosts
					</Button>
				</div>
				{status ? (
					<p role="status" css={css(fieldDescriptionCss)}>
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
			<p css={css(fieldDescriptionCss)}>
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
						<Button
							type="button"
							aria-label={`Remove ${host}`}
							variant="secondary"
							onClick={() => remove(host)}
						>
							Remove
						</Button>
					</li>
				))}
			</ul>
			<form css={addFormCss} onSubmit={addTyped}>
				<Input
					type="text"
					name="host"
					data-testid="credential-hosts-input"
					aria-label="Host to allow"
					placeholder="api.example.com"
					autoComplete="off"
					spellCheck={false}
					value={typed}
					onChange={(event) => setTyped(event.currentTarget.value)}
				/>
				<Button type="submit" variant="secondary">
					Add host
				</Button>
			</form>
			{error ? (
				<p role="alert" css={errorCss}>
					{error}
				</p>
			) : null}
			<div css={css(accountActionsCss)}>
				<Button
					type="button"
					data-testid="credential-hosts-save"
					disabled={saving}
					variant="primary"
					onClick={() => void save()}
				>
					{saving ? 'Saving…' : 'Save hosts'}
				</Button>
				<Button
					type="button"
					disabled={saving}
					variant="secondary"
					onClick={cancel}
				>
					Cancel
				</Button>
			</div>
		</div>
	)
}
