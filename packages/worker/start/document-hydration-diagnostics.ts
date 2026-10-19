/**
 * Value-free counts for structural hydration mismatches (reconcile leftover /
 * adoptHostDom tag mismatch). Never report document text or attribute values.
 */
export function documentHydrationDiagnostics(doc: Document) {
	const bodyEmotion =
		doc.body?.querySelectorAll('style[data-emotion]').length ?? 0
	const headEmotion =
		doc.head?.querySelectorAll('style[data-emotion]').length ?? 0
	const bodyEmotionUnmarked =
		doc.body?.querySelectorAll('style[data-emotion]:not([data-s])').length ?? 0
	return {
		bodyEmotionStyleCount: bodyEmotion,
		headEmotionStyleCount: headEmotion,
		bodyEmotionUnmarkedCount: bodyEmotionUnmarked,
		pathname:
			typeof doc.defaultView?.location?.pathname === 'string'
				? doc.defaultView.location.pathname
				: null,
	}
}
