import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { recordSkillPageRead } from '#start/server/skills'

export function SkillReadAcknowledgement({
	orgSlug,
	receipt,
	identity,
}: {
	identity: string
	orgSlug: string
	receipt: string | null
}) {
	return receipt ? (
		<Acknowledge key={identity} orgSlug={orgSlug} receipt={receipt} />
	) : null
}
function Acknowledge({
	orgSlug,
	receipt,
}: {
	orgSlug: string
	receipt: string
}) {
	const [eventId] = useState(() => crypto.randomUUID())
	const [retry, setRetry] = useState(0)
	const client = useQueryClient()
	const read = useQuery({
		queryKey: ['skill-page-read', orgSlug, receipt, eventId, retry],
		queryFn: async () => {
			await recordSkillPageRead({ data: { orgSlug, receipt, eventId } })
			void client.invalidateQueries({
				predicate: (query) =>
					query.queryKey[2] === 'loadSkillsPage' ||
					query.queryKey[2] === 'loadOrgOverview',
				refetchType: 'none',
			})
			return true
		},
		staleTime: Infinity,
		retry: false,
		refetchOnWindowFocus: false,
	})
	return read.isError ? (
		<p role="status">
			This read couldn't be recorded.{' '}
			<button type="button" onClick={() => setRetry((n) => n + 1)}>
				Retry
			</button>
		</p>
	) : null
}
