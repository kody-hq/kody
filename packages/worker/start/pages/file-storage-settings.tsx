/** @jsxImportSource @emotion/react */
import { ModalDialog } from '../components/modal-dialog.tsx'
import { useEffect, useRef, useState } from 'react'
import type { z } from 'zod'
import type { fileStorageStatusSchema } from '#universal/file-storage.ts'
import { readFileStorage, setFileStorage } from '#start/server/file-storage'
import { accountInputCss } from './account-management-components.tsx'
import { colors } from '#universal/styles/tokens.ts'
import { LoadingIndicator } from '../components/loading-indicator.tsx'
export default function FileStorageSettings({
	orgSlug,
	onClose,
}: {
	orgSlug: string
	onClose: () => void
}) {
	const [status, setStatus] = useState<z.infer<
		typeof fileStorageStatusSchema
	> | null>(null)
	const [endpoint, setEndpoint] = useState(''),
		[bucket, setBucket] = useState(''),
		[region, setRegion] = useState('auto'),
		[credentialName, setCredentialName] = useState(''),
		[busy, setBusy] = useState(false),
		[error, setError] = useState('')
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
						<p css={{ margin: '0 0 12px' }}>
							{status.active
								? `${status.active.bucket} · ${new URL(status.active.endpoint).hostname}`
								: 'Included storage'}
						</p>
						<p css={{ fontSize: 12, color: colors.textMuted }}>
							New revisions use this connection. Older versions stay in their
							original storage. Disconnecting does not move or delete files.
						</p>
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
								<input
									required
									css={accountInputCss}
									value={credentialName}
									onChange={(e) => setCredentialName(e.target.value)}
								/>
							</label>
						</div>
						<p css={{ fontSize: 12, color: colors.textMuted }}>
							Use a dedicated credential with JSON accessKeyId and
							secretAccessKey, approved for this endpoint.{' '}
							<a
								href={`/@${orgSlug}/-/credentials`}
								target="_blank"
								rel="noreferrer"
							>
								Manage credentials
							</a>
						</p>
						<div css={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
							<button type="button" css={button} onClick={onClose}>
								Close
							</button>
							<button type="submit" css={button} disabled={busy}>
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
