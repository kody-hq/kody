/** @jsxImportSource @emotion/react */
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import { Input } from './input.tsx'

export function Honeypot() {
	return (
		<Input
			type="text"
			name={honeypotFieldName}
			tabIndex={-1}
			aria-hidden="true"
			readOnly
			{...passwordManagerIgnoreProps}
			css={{
				position: 'absolute',
				left: '-10000px',
				width: '1px',
				height: '1px',
				overflow: 'hidden',
			}}
		/>
	)
}
