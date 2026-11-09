/** @jsxImportSource @emotion/react */
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import {
	loadFileInvitation,
	acceptFileInvitation,
} from '#start/server/file-invitations'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'
import { AccountManagementShell } from '../pages/account-management-components.tsx'
import { SiteLink } from '../components/site-link.tsx'
export const Route = createFileRoute('/files/invites/$token')({
	preload: false,
	staleTime: 0,
	loader: ({ params }) => loadFileInvitation({ data: { token: params.token } }),
	head: () => ({
		meta: [
			{ title: 'File invitation' },
			{ name: 'referrer', content: 'no-referrer' },
		],
	}),
	component: Page,
})
function Page() {
	const offer = Route.useLoaderData()
	const { token } = Route.useParams()
	const router = useRouter()
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState('')
	return (
		<AccountManagementShell layout="form">
			<h1>File invitation</h1>
			{offer.ok ? (
				<>
					<h2>{offer.name}</h2>
					<p>
						Shared by @{offer.orgSlug}.{' '}
						{offer.preset === 'manage'
							? 'You can manage access and edit this file.'
							: offer.preset === 'contribute'
								? 'You can view and edit this file.'
								: 'You can view and download this file.'}
					</p>
					{offer.accepted ? (
						<SiteLink href={offer.href}>Open file</SiteLink>
					) : (
						<button
							css={getPillButtonCss()}
							disabled={busy}
							onClick={async () => {
								setBusy(true)
								try {
									const result = await acceptFileInvitation({ data: { token } })
									if (result.ok) await router.navigate({ href: result.href })
									else setMessage(result.message)
								} catch {
									setMessage('Could not accept this invitation. Try again.')
								} finally {
									setBusy(false)
								}
							}}
						>
							{busy ? 'Accepting…' : 'Accept invitation'}
						</button>
					)}
				</>
			) : (
				<p>{offer.message}</p>
			)}
			{message && <p role="status">{message}</p>}
		</AccountManagementShell>
	)
}
