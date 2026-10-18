/* oxlint-disable no-undef -- classic browser script served from public/;
   the lint config's browser env does not apply here. */
// Emotion SSR emits <style data-emotion="css …"> as Insertion siblings in the
// body. The client Insertion returns null, so those nodes are not in the
// hydrate tree. Emotion's createCache also hoists them, but only after the
// Emotion module evaluates — which can race hydrateRoot. Run this classic
// script at the end of <body> (before deferred module Scripts) so styles are
// already in <head> when hydration starts.
;(function () {
	var styles = document.querySelectorAll('style[data-emotion]:not([data-s])')
	for (var i = 0; i < styles.length; i++) {
		var el = styles[i]
		var attr = el.getAttribute('data-emotion')
		if (!attr || attr.indexOf(' ') === -1) continue
		document.head.appendChild(el)
		el.setAttribute('data-s', '')
	}
})()
