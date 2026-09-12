import { expect, it } from 'vitest'
import { cssFontStyle } from '../src/font-style'

it('maps service labels to valid CSS styles, including variable font candidates', () => {
  expect(cssFontStyle('variable')).toBe('normal')
  expect(cssFontStyle('Regular')).toBe('normal')
  expect(cssFontStyle('Bold Italic')).toBe('italic')
  expect(cssFontStyle('oblique')).toBe('oblique')
})
