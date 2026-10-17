import { useServerFn } from '@tanstack/react-start'
import { useCallback } from 'react'
import { parseSessionInfo } from '#client/session.ts'
import { readWebsiteSessionInfo } from '#start/server/session-info'
export function useSessionInfo({
	throwOnError = false,
}: { throwOnError?: boolean } = {}) {
	const send = useServerFn(readWebsiteSessionInfo)
	return useCallback(
		async function fetchSessionInfo(signal?: AbortSignal) {
			try {
				const session = await send({ signal })
				if (session === undefined) return undefined
				return !session || signal?.aborted
					? null
					: parseSessionInfo({ ok: true, session })
			} catch (error) {
				if (throwOnError) throw error
				return null
			}
		},
		[send, throwOnError],
	)
}
