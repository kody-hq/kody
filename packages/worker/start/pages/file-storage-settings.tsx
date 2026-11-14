/** @jsxImportSource @emotion/react */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { ModalDialog } from '../components/modal-dialog.tsx'
import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import type { fileStorageStatusSchema } from '#universal/file-storage.ts'
import {
	readFileStorage,
	readFileStorageCredentials,
	setFileStorage,
} from '#start/server/file-storage'
import { accountInputCss } from './account-management-components.tsx'
import { colors } from '#universal/styles/tokens.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
const bucketSetupPrompts = {
	'Cloudflare R2':
		'Help me create a private Cloudflare R2 bucket for Kody Files. Show me how to create an Object Read & Write key scoped to that bucket and find its S3 API endpoint. Use region auto.',
	'Amazon S3':
		'Help me create a private Amazon S3 bucket for Kody Files. Show me how to create a dedicated access key with permission to read, write, and delete objects in that bucket and find its regional HTTPS S3 endpoint and region.',
} as const

export default function FileStorageSettings({
	orgSlug,
	onClose,
}: {
	orgSlug: string
	onClose: () => void
}) {
	const queryClient = useQueryClient()
	const router = useRouter()
	const [status, setStatus] = useState<z.infer<
		typeof fileStorageStatusSchema
	> | null>(null)
	const [endpoint, setEndpoint] = useState(''),
		[bucket, setBucket] = useState(''),
		[region, setRegion] = useState('auto'),
		[credentialName, setCredentialName] = useState(''),
		[busy, setBusy] = useState(false),
		[error, setError] = useState('')
	const credentials = useQuery({
		queryKey: ['file-storage-credentials', orgSlug],
		queryFn: () => readFileStorageCredentials({ data: { orgSlug } }),
	})
	const [copyStatus, setCopyStatus] = useState('')
	async function copySetup(provider: keyof typeof bucketSetupPrompts) {
		try {
			await navigator.clipboard.writeText(
				`${bucketSetupPrompts[provider]} Have me save the accessKeyId and secretAccessKey as JSON directly in Kody Credentials and approve the bucket endpoint host. Then walk me through entering the endpoint, bucket and region in Files → Storage settings and selecting that credential. Keep the key out of chat.`,
			)
			setCopyStatus(`${provider} setup prompt copied.`)
		} catch {
			setCopyStatus('Could not copy the setup prompt.')
		}
	}
	const operation = useRef<string>(crypto.randomUUID())
	const [reconnecting, setReconnecting] = useState(false)
	useEffect(() => {
		let active = true
		void readFileStorage({ data: { orgSlug } }).then(
			(value) => {
				if (active) setStatus(value)
			},
			(e) => {
				if (active)
					setError(e instanceof Error ? e.message : 'Could not load storage.')
			},
		)
		return () => {
			active = false
		}
	}, [orgSlug])
	async function refreshFiles() {
		await queryClient.invalidateQueries({
			predicate: ({ queryKey: [resource, scope, loader] }) =>
				(resource === 'page' && loader === 'loadFilesPage') ||
				((resource === 'workspace-document' ||
					resource === 'workspace-embed') &&
					scope === orgSlug),
		})
		await router.invalidate()
	}
	const button = {
		border: 0,
		borderRadius: 5,
		padding: '7px 10px',
		font: 'inherit',
		background: colors.borderSubtle,
		color: colors.text,
		cursor: 'pointer',
		'&:disabled': { opacity: 0.5 },
	}
	return (
		<ModalDialog label="File storage" onClose={onClose} width={480}>
			<form
				onSubmit={async (event) => {
					event.preventDefault()
					setBusy(true)
					setError('')
					try {
						setStatus(
							await setFileStorage({
								data: {
									orgSlug,
									configuration: {
										id: operation.current,
										endpoint,
										bucket,
										region,
										credentialName,
									},
								},
							}),
						)
						operation.current = crypto.randomUUID()
						setReconnecting(false)
						await refreshFiles()
					} catch (e) {
						setError(
							e instanceof Error ? e.message : 'Could not connect storage.',
						)
					} finally {
						setBusy(false)
					}
				}}
			>
				<div
					css={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
					}}
				>
					<h2 css={{ margin: '0 0 16px' }}>File storage</h2>
					<button
						type="button"
						aria-label="Close storage settings"
						css={button}
						onClick={onClose}
					>
						×
					</button>
				</div>
				{!status && !error ? (
					<LoadingIndicator label="Opening storage settings" />
				) : null}
				{status && (
					<>
						{status.active && (
							<p css={{ margin: '0 0 12px' }}>
								{status.active.bucket} ·{' '}
								{new URL(status.active.endpoint).hostname}
							</p>
						)}
						{status.active && (
							<p css={{ fontSize: 12, color: colors.textMuted }}>
								New revisions use this bucket. Older revisions stay in their
								original storage.
							</p>
						)}
						{status.active && (
							<button
								type="button"
								css={button}
								disabled={busy}
								onClick={async () => {
									setBusy(true)
									setError('')
									try {
										setStatus(
											await setFileStorage({
												data: { orgSlug, configuration: null },
											}),
										)
										await refreshFiles()
									} catch (e) {
										setError(
											e instanceof Error
												? e.message
												: 'Could not change storage.',
										)
									} finally {
										setBusy(false)
									}
								}}
							>
								Use included storage
							</button>
						)}
						{status.providers.length > 0 && (
							<div
								css={{
									display: 'flex',
									gap: 6,
									flexWrap: 'wrap',
									marginTop: 14,
								}}
							>
								{status.providers.map((provider) => (
									<button
										type="button"
										css={button}
										key={provider.id}
										onClick={() => {
											operation.current = provider.id
											setReconnecting(true)
											setEndpoint(provider.endpoint)
											setBucket(provider.bucket)
											setRegion(provider.region)
											setCredentialName(provider.credentialName)
										}}
									>
										Reconnect {provider.bucket}
									</button>
								))}
								{reconnecting && (
									<button
										type="button"
										css={button}
										onClick={() => {
											operation.current = crypto.randomUUID()
											setReconnecting(false)
											setEndpoint('')
											setBucket('')
											setCredentialName('')
										}}
									>
										New connection
									</button>
								)}
							</div>
						)}
						<div
							css={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 18 }}
						>
							{(
								Object.keys(bucketSetupPrompts) as Array<
									keyof typeof bucketSetupPrompts
								>
							).map((provider) => (
								<button
									key={provider}
									type="button"
									css={button}
									onClick={() => void copySetup(provider)}
								>
									Copy {provider === 'Cloudflare R2' ? 'R2' : 'S3'} setup prompt
								</button>
							))}
						</div>
						{copyStatus && <p role="status">{copyStatus}</p>}
						<div css={{ display: 'grid', gap: 12, marginTop: 18 }}>
							<label>
								R2 or S3 endpoint
								<input
									required
									type="url"
									css={accountInputCss}
									placeholder="https://account-id.r2.cloudflarestorage.com"
									value={endpoint}
									onChange={(e) => setEndpoint(e.target.value)}
								/>
							</label>
							<label>
								Bucket
								<input
									required
									css={accountInputCss}
									value={bucket}
									onChange={(e) => setBucket(e.target.value)}
								/>
							</label>
							<label>
								Region
								<input
									required
									css={accountInputCss}
									value={region}
									onChange={(e) => setRegion(e.target.value)}
								/>
							</label>
							<label>
								Workspace credential
								<select
									required
									css={accountInputCss}
									value={credentialName}
									onChange={(e) => setCredentialName(e.target.value)}
								>
									<option value="">
										{credentials.isPending
											? 'Loading credentials…'
											: 'Select a credential'}
									</option>
									{credentials.data?.map((name) => (
										<option key={name} value={name}>
											{name}
										</option>
									))}
								</select>
							</label>
						</div>
						<p css={{ fontSize: 12, color: colors.textMuted }}>
							Use a dedicated credential with JSON accessKeyId and
							secretAccessKey, approved for this endpoint.{' '}
							<a
								href={`/@${orgSlug}/-/credentials/new?kind=secret`}
								target="_blank"
								rel="noreferrer"
							>
								Create credential
							</a>
						</p>
						{credentials.isError && (
							<button
								type="button"
								css={button}
								onClick={() => void credentials.refetch()}
							>
								Retry loading credentials
							</button>
						)}
						<div css={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
							<button
								type="submit"
								css={button}
								disabled={busy || !credentials.data?.includes(credentialName)}
							>
								{busy
									? 'Checking connection…'
									: reconnecting
										? 'Reconnect storage'
										: 'Connect storage'}
							</button>
						</div>
					</>
				)}
				{error && (
					<p role="alert" css={{ color: colors.danger }}>
						{error}
					</p>
				)}
			</form>
		</ModalDialog>
	)
}
