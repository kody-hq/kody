/**
 * Pure helpers for installed apps that run in the background: menu-bar
 * popovers, global shortcuts, and start at login.
 */
const maxShortcuts = 8
const modifiers = new Set([
	'Command',
	'Cmd',
	'Control',
	'Ctrl',
	'CommandOrControl',
	'CmdOrCtrl',
	'Alt',
	'Option',
	'AltGr',
	'Shift',
	'Super',
	'Meta',
])
const keyPattern =
	/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Plus|[-=[\];',./`\\])$/

/** A global shortcut needs at least one modifier and exactly one key. */
function validAccelerator(value) {
	if (typeof value !== 'string' || value.length > 60) return null
	const parts = value.split('+')
	const key = parts.pop()
	if (!parts.length || !parts.every((part) => modifiers.has(part))) return null
	if (new Set(parts).size !== parts.length) return null
	return keyPattern.test(key) ? value : null
}

const defaultPopover = { width: 360, height: 480 }

/** `<meta name="kody-menubar-size" content="360x480">`, clamped to screen-friendly sizes. */
function popoverSize(content) {
	const match =
		typeof content === 'string' &&
		/^\s*(\d{2,4})\s*x\s*(\d{2,4})\s*$/.exec(content)
	if (!match) return defaultPopover
	const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
	return {
		width: clamp(Number(match[1]), 200, 800),
		height: clamp(Number(match[2]), 120, 900),
	}
}

/** Places the popover under a top tray (macOS) or above a bottom one, inside the work area. */
function popoverBounds(tray, size, workArea) {
	const clamp = (value, min, max) => Math.min(Math.max(value, min), max)
	const centered = Math.round(tray.x + tray.width / 2 - size.width / 2)
	const x = clamp(
		centered,
		workArea.x,
		workArea.x + workArea.width - size.width,
	)
	const below = tray.y + tray.height / 2 < workArea.y + workArea.height / 2
	const y = below
		? Math.max(tray.y + tray.height, workArea.y)
		: Math.min(tray.y, workArea.y + workArea.height) - size.height
	return { x, y, ...size }
}

const startHiddenArgument = '--kody-start-hidden'

/** Linux has no login-item API; an XDG autostart entry does the same. */
function linuxAutostartEntry(executable) {
	const quoted = `"${executable.replace(/(["`$\\])/g, '\\$1')}"`
	return [
		'[Desktop Entry]',
		'Type=Application',
		'Name=Kody Apps',
		`Exec=${quoted} ${startHiddenArgument}`,
		'X-GNOME-Autostart-enabled=true',
		'NoDisplay=true',
		'',
	].join('\n')
}

module.exports = {
	linuxAutostartEntry,
	maxShortcuts,
	popoverBounds,
	popoverSize,
	startHiddenArgument,
	validAccelerator,
}
