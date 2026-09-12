/** Lens uses labels such as "variable" that are not valid CSS font-style descriptors. */
export function cssFontStyle(style = ''): 'normal' | 'italic' | 'oblique' {
  if (/italic/i.test(style)) return 'italic'
  if (/oblique/i.test(style)) return 'oblique'
  return 'normal'
}
