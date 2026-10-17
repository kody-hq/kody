import { type Query } from '@tanstack/react-query'

/** Router owns route failures. Failed queries can contain nonserializable Responses. */
export function shouldDehydrateAppQuery(query: Query) {
	return query.state.status !== 'error'
}
