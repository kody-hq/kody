/* oxlint-disable no-undef -- classic browser script served from public/;
   the lint config's browser env does not apply here. */
// Runs as a blocking classic script in <head> so enhance-only motion can
// gate on `html.js` before first paint. Start embeds this static source with
// its request nonce, other documents can load this file. Color scheme is CSS-only
// (`prefers-color-scheme`); this script does not set a theme.
;(function () {
	document.documentElement.classList.add('js')

	// Smooth scrolling is for anchors clicked while you're already on the page.
	// Arriving at a #hash must land instantly, so opt in only after the
	// browser's initial jump has settled.
	addEventListener('load', function () {
		requestAnimationFrame(function () {
			document.documentElement.classList.add('is-settled')
		})
	})
})()
