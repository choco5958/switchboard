// An input method (Korean, Japanese, Chinese) uses Enter to commit the syllable it is
// composing. That Enter must not also send or pick: the text would go out half-typed.
// Chromium marks it with isComposing; Safari-style engines report keyCode 229 instead.
export function composing(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean } }): boolean {
  return event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229
}
