/* oxlint-disable no-undef -- classic browser script served from public/;
   the lint config's browser env does not apply here. */
// Wires the static "Copy prompt for your agent" block
// (`renderErrorAgentPromptStaticHtml`). Static error documents load no app
// bundle and CSP blocks inline scripts, hence this file. The button copies
// the <pre>'s rendered text and stays hidden when this script cannot run.
;(function () {
	var resetMs = { copied: 2000, error: 4000 }

	function copyWithExecCommand(text) {
		var textArea = document.createElement('textarea')
		textArea.value = text
		textArea.setAttribute('readonly', '')
		textArea.style.position = 'fixed'
		textArea.style.opacity = '0'
		document.body.appendChild(textArea)
		textArea.select()
		try {
			return (
				typeof document.execCommand === 'function' &&
				document.execCommand('copy')
			)
		} catch {
			return false
		} finally {
			document.body.removeChild(textArea)
		}
	}

	function copyText(text, done) {
		var clipboard = navigator.clipboard
		if (clipboard && typeof clipboard.writeText === 'function') {
			clipboard.writeText(text).then(
				function () {
					done(true)
				},
				function () {
					done(copyWithExecCommand(text))
				},
			)
			return
		}
		done(copyWithExecCommand(text))
	}

	function selectText(element) {
		var selection = window.getSelection && window.getSelection()
		if (!selection || !document.createRange) return
		var range = document.createRange()
		range.selectNodeContents(element)
		selection.removeAllRanges()
		selection.addRange(range)
	}

	function wire(block) {
		var button = block.querySelector('[data-error-agent-prompt-copy]')
		var text = block.querySelector('[data-error-agent-prompt-text]')
		var status = block.querySelector('[data-error-agent-prompt-status]')
		if (!button || !text) return
		var timer = null

		function show(state) {
			var labels = button.querySelectorAll('[data-label]')
			for (var index = 0; index < labels.length; index += 1) {
				if (labels[index].getAttribute('data-label') === state) {
					labels[index].setAttribute('data-active', '')
				} else {
					labels[index].removeAttribute('data-active')
				}
			}
			button.setAttribute('data-state', state)
			if (status) {
				status.textContent =
					state === 'copied'
						? 'Copied prompt to clipboard'
						: state === 'error'
							? 'Copy failed. The prompt is selected so you can copy it manually.'
							: ''
			}
		}

		button.addEventListener('click', function (event) {
			event.preventDefault()
			copyText(text.textContent || '', function (copied) {
				var state = copied ? 'copied' : 'error'
				if (!copied) selectText(text)
				show(state)
				if (timer) clearTimeout(timer)
				timer = setTimeout(function () {
					timer = null
					show('idle')
				}, resetMs[state])
			})
		})
		button.removeAttribute('hidden')
	}

	var blocks = document.querySelectorAll('[data-error-agent-prompt]')
	for (var index = 0; index < blocks.length; index += 1) wire(blocks[index])
})()
