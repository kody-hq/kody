/** @jsxImportSource @emotion/react */
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'

export function Honeypot() {
	return (
		<input
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
