// Minimal typing for the dependency-free QR encoder inside `qrcode`. The
// package entry also loads PNG and file helpers that Workers do not need.
declare module 'qrcode/lib/core/qrcode.js' {
	export function create(
		text: string,
		options?: { errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' },
	): {
		modules: { size: number; data: Uint8Array | Array<boolean | number> }
	}
}
