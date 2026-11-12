/** Read ZIP32's central directory without inflating file bodies. ZIP64, split,
 * and encrypted archives require a different reader and are rejected explicitly. */
export function zipDirectory(bytes: ArrayBuffer) {
	const view = new DataView(bytes),
		data = new Uint8Array(bytes)
	let end = -1
	for (
		let offset = bytes.byteLength - 22;
		offset >= Math.max(0, bytes.byteLength - 65557);
		offset--
	) {
		if (
			view.getUint32(offset, true) === 0x06054b50 &&
			offset + 22 + view.getUint16(offset + 20, true) === bytes.byteLength
		) {
			end = offset
			break
		}
	}
	if (end < 0) throw new Error('Invalid ZIP archive.')
	const count = view.getUint16(end + 10, true),
		size = view.getUint32(end + 12, true),
		start = view.getUint32(end + 16, true)
	if (
		view.getUint16(end + 4, true) ||
		view.getUint16(end + 6, true) ||
		view.getUint16(end + 8, true) !== count ||
		count === 65535 ||
		start === 0xffffffff ||
		size === 0xffffffff
	)
		throw new Error('This archive format is not supported.')
	if (count > 4000 || start + size > end)
		throw new Error('Archive exceeds preview limits.')
	const entries: Array<{
		name: string
		bytes: number
		compressedBytes: number
	}> = []
	let cursor = start,
		total = 0
	for (let i = 0; i < count; i++) {
		if (
			cursor + 46 > start + size ||
			view.getUint32(cursor, true) !== 0x02014b50
		)
			throw new Error('Invalid ZIP directory.')
		const flags = view.getUint16(cursor + 8, true),
			compressedBytes = view.getUint32(cursor + 20, true),
			bytes = view.getUint32(cursor + 24, true),
			length = view.getUint16(cursor + 28, true),
			extra = view.getUint16(cursor + 30, true),
			comment = view.getUint16(cursor + 32, true),
			offset = view.getUint32(cursor + 42, true)
		if (
			flags & 1 ||
			compressedBytes === 0xffffffff ||
			bytes === 0xffffffff ||
			offset >= start
		)
			throw new Error('This archive format is not supported.')
		if (
			!length ||
			length > 4096 ||
			cursor + 46 + length + extra + comment > start + size
		)
			throw new Error('Invalid ZIP entry.')
		total += bytes
		if (bytes > 32 * 1024 * 1024 || total > 64 * 1024 * 1024)
			throw new Error('Archive exceeds preview limits.')
		const name = new TextDecoder().decode(
			data.subarray(cursor + 46, cursor + 46 + length),
		)
		entries.push({ name, bytes, compressedBytes })
		cursor += 46 + length + extra + comment
	}
	return entries
}
