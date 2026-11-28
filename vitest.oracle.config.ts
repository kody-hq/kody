import nodeConfig from './vitest.node.config.ts'

// Oracle files (@tanstack/oracles) run through `oracle-gaps`, outside the
// node suite: the node project's aliases and stubs, with their own glob.
export default {
	...nodeConfig,
	test: {
		...nodeConfig.test,
		name: 'oracles',
		include: ['packages/**/*.oracle.test.ts'],
	},
}
