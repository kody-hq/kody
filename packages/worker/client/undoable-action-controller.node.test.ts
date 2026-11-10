import { expect, test, vi } from 'vitest'
import { createUndoableActionController } from './undoable-action-controller.ts'
test('empty settlement, undo, racing replacements and disposal settle each action once', async () => {
	const controller = createUndoableActionController()
	await controller.commit()
	const undo = vi.fn()
	await controller.start({ message: 'Undo', onCommit: vi.fn(), onUndo: undo })
	await controller.undo()
	expect(undo).toHaveBeenCalledTimes(1)
	const first = vi.fn(),
		last = vi.fn()
	await Promise.all([
		controller.start({ message: 'First', onCommit: first }),
		controller.start({ message: 'Last', onCommit: last }),
	])
	expect(first).toHaveBeenCalledTimes(1)
	expect(last).not.toHaveBeenCalled()
	expect(controller.getSnapshot().status).toBe('waiting')
	await controller.dispose()
	expect(last).toHaveBeenCalledTimes(1)
	expect(controller.actor.getSnapshot().status).toBe('stopped')
})
test('settlement errors propagate and release the fence for another action', async () => {
	const controller = createUndoableActionController()
	await controller.start({
		message: 'Fails',
		onCommit: () => {
			throw new Error('failed')
		},
	})
	await expect(controller.commit()).rejects.toThrow('failed')
	expect(controller.getSnapshot()).toEqual({ status: 'idle' })
	await controller.start({ message: 'Next', onCommit() {} })
	await controller.dispose()
})

test('effect cleanup followed by immediate activation keeps the actor alive without restarting it', async () => {
	const controller = createUndoableActionController()
	const actor = controller.actor
	const cleanup = controller.dispose()
	expect(controller.activate()).toBe(true)
	await cleanup
	expect(controller.actor).toBe(actor)
	const commit = vi.fn()
	await controller.start({ message: 'Again', onCommit: commit })
	await controller.dispose()
	expect(commit).toHaveBeenCalledOnce()
	expect(controller.actor.getSnapshot().status).toBe('stopped')
	expect(controller.activate()).toBe(false)
})
