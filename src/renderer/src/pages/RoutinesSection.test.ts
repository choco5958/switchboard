import { expect, test } from 'vitest'
import { setLang } from '../../../shared/i18n'
import { whyNotAdd, whyNotSave } from './RoutinesSection'

const ready = { name: '아침 점검', project: 'web', prompt: '의존성을 점검하세요', kind: 'daily' as const, time: '09:00', every: '60', at: '' }
const NOW = new Date(2026, 9, 30, 12, 0).getTime()

test('a complete draft can be saved', () => {
  expect(whyNotSave(ready, NOW)).toBeNull()
  expect(whyNotSave({ ...ready, kind: 'interval', every: '5' }, NOW)).toBeNull()
  expect(whyNotSave({ ...ready, kind: 'once', at: '2026-10-31T09:00' }, NOW)).toBeNull()
})

test('a draft that cannot be saved says the first thing missing', () => {
  setLang('ko')
  expect(whyNotSave({ ...ready, name: ' ' }, NOW)).toBe('이름을 적으세요.')
  expect(whyNotSave({ ...ready, project: '' }, NOW)).toBe('프롬프트를 받을 프로젝트를 고르세요.')
  expect(whyNotSave({ ...ready, prompt: '' }, NOW)).toBe('세션에 넣을 프롬프트를 적으세요.')
  expect(whyNotSave({ ...ready, kind: 'interval', every: '4' }, NOW)).toBe('간격은 5분 이상이어야 합니다.')
  expect(whyNotSave({ ...ready, kind: 'once', at: '' }, NOW)).toBe('실행할 날짜와 시각을 고르세요.')
  expect(whyNotSave({ ...ready, kind: 'once', at: '2026-10-29T09:00' }, NOW)).toBe('지난 시각입니다. 앞으로 올 시각을 고르세요.')
  expect(whyNotSave({ ...ready, time: '' }, NOW)).toBe('실행 시각을 정하세요.')
})

test('adding needs the background server and a project folder', () => {
  setLang('ko')
  expect(whyNotAdd(true, 2)).toBeNull()
  expect(whyNotAdd(false, 2)).toContain('백그라운드 서버')
  expect(whyNotAdd(true, 0)).toContain('프로젝트')
})
