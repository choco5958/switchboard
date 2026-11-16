import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../../../shared/i18n'
import { usageText } from './AccountsSection'

describe('usageText', () => {
  beforeEach(() => setLang('en'))
  afterEach(() => setLang('ko'))

  it('shows the two windows a plan reports, with a dash for one it left out', () => {
    expect(usageText({ five: 40.4, week: 20 })).toBe('5 hours 40%, week 20%')
    expect(usageText({ five: 12 })).toBe('5 hours 12%, week -')
    expect(usageText(undefined)).toBe('')
  })

  it('shows a spending cap alone for a seat with no other window, and after the windows otherwise', () => {
    expect(usageText({ spend: 62.4 })).toBe('spend limit 62%')
    expect(usageText({ five: undefined, week: undefined, spend: 100 })).toBe('spend limit 100%')
    expect(usageText({ five: 5, week: 9, spend: 30 })).toBe('5 hours 5%, week 9%, spend limit 30%')
  })
})
