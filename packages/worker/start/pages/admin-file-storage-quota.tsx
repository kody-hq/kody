/** @jsxImportSource @emotion/react */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import {
	readAdminFileStorageQuota,
	updateAdminFileStorageQuota,
} from '#start/server/admin-controls'
import { fieldCss, fieldLabelCss } from '#universal/styles/style-primitives.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
} from './account-management-components.tsx'

import { Input } from '../components/input.tsx'
import { Button } from '../components/button.tsx'

const bytesPerMiB = 1024 * 1024

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
						<Input
							key={data.includedBytes}
							name="quota"
							type="number"
							min="0"
							max={Math.floor(Number.MAX_SAFE_INTEGER / bytesPerMiB)}
							step="any"
							required
							defaultValue={data.includedBytes / bytesPerMiB}
						/>
					</label>
					<label css={fieldCss}>
						<span css={fieldLabelCss}>Reason</span>
						<Input
							required
							maxLength={500}
							value={reason}
							onChange={(event) => setReason(event.target.value)}
						/>
					</label>
					<Button
						variant="secondary"
						size="sm"
						type="submit"
						disabled={save.isPending}
					>
						{orgId ? 'Save override' : 'Save default'}
					</Button>
					{orgId && data.overrideBytes !== null && (
						<Button
							variant="secondary"
							size="sm"
							type="button"

							disabled={save.isPending || !reason.trim()}
							onClick={() => save.mutate(null)}
						>
							Use default ({data.defaultBytes / bytesPerMiB} MiB)
						</Button>
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
