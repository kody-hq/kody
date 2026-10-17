import {
	documentActorMetaName,
	parseDocumentActor,
} from './session-identity.ts'

// A browser module belongs to one document. SSR never reads or assigns this.
let captured: string | undefined
export function readDocumentActor() {
	if (typeof document === 'undefined')
		throw new Error('Document identity is only available in the browser')
	if (captured === undefined) {
		const marker = document.querySelector<HTMLMetaElement>(
			`meta[name="${documentActorMetaName}"]`,
		)
		if (!marker) throw new Error('Missing document identity')
		captured = JSON.stringify(parseDocumentActor(marker.content))
	}
	return captured
}
