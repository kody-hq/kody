/** @jsxImportSource @emotion/react */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
	readAdminFileStorageQuota,
	updateAdminFileStorageQuota,
} from '#start/server/admin-controls'
import {
	fieldCss,
	fieldLabelCss,
	getAuthInputCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'

const bytesPerMiB = 1024 * 1024
const inputCss = getAuthInputCss()
const buttonCss = getPillButtonCss({ size: 'sm' })

export function AdminFileStorageQuota({ orgId }: { orgId?: string }) {
	const client = useQueryClient()
	const queryKey = ['admin-file-storage-quota', orgId] as const
	const quota = useQuery({
		queryKey,
		queryFn: () => readAdminFileStorageQuota({ data: { orgId } }),
	})
	const [reason, setReason] = useState('')
	const save = useMutation({
		mutationFn: (bytes: number | null) =>
			updateAdminFileStorageQuota({ data: { orgId, bytes, reason } }),
		onSuccess: (result) => {
			client.setQueryData(queryKey, result)
			setReason('')
			void client.invalidateQueries({ queryKey: ['admin-file-storage-quota'] })
		},
	})
	const data = quota.data
	return (
		<AccountManagementPanel
			title={orgId ? 'File storage quota' : 'Default file storage quota'}
		>
			{quota.isPending && <p role="status">Loading quota…</p>}
			{quota.isError && (
				<p role="alert">Could not load the file storage quota.</p>
			)}
			{data && (
				<form
					aria-label={
						orgId
							? 'Organization file storage quota'
							: 'Default file storage quota'
					}
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						alignItems: 'end',
						gap: 12,
					}}
					onSubmit={(event) => {
						event.preventDefault()
						const value = new FormData(event.currentTarget).get('quota')
						if (typeof value !== 'string' || !value) return
						save.mutate(Math.round(Number(value) * bytesPerMiB))
					}}
				>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Included storage (MiB)</span>
						<input
							key={data.includedBytes}
							name="quota"
							type="number"
							min="0"
							max={Math.floor(Number.MAX_SAFE_INTEGER / bytesPerMiB)}
							step="any"
							required
							defaultValue={data.includedBytes / bytesPerMiB}
							css={inputCss}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Reason</span>
						<input
							required
							maxLength={500}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
							css={inputCss}
						/>
					</label>
					<button type="submit" css={buttonCss} disabled={save.isPending}>
						{orgId ? 'Save override' : 'Save default'}
					</button>
					{orgId && data.overrideBytes !== null && (
						<button
							type="button"
							css={buttonCss}
							disabled={save.isPending || !reason.trim()}
							onClick={() => save.mutate(null)}
						>
							Use default ({data.defaultBytes / bytesPerMiB} MiB)
						</button>
					)}
					{save.isSuccess && <span role="status">Quota saved.</span>}
				</form>
			)}
			{save.isError && (
				<AccountManagementMessage tone="error">
					{save.error.message}
				</AccountManagementMessage>
			)}
		</AccountManagementPanel>
	)
}
