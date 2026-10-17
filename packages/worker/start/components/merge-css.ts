import { type CSSObject } from '@emotion/react'

export function mergeCss(...objects: Array<CSSObject>): CSSObject {
	const result: CSSObject = {}
	for (const object of objects)
		for (const [key, value] of Object.entries(object)) {
			const previous = result[key]
			result[key] =
				value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				previous &&
				typeof previous === 'object' &&
				!Array.isArray(previous)
					? mergeCss(previous as CSSObject, value as CSSObject)
					: value
		}
	return result
}
