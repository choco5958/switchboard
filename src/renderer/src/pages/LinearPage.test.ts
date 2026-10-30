import { expect, test } from 'vitest'
import { linearPrompt } from './LinearPage'

test('a Linear issue becomes a task prompt with its key, title, link and description', () => {
  const text = linearPrompt({ identifier: 'ENG-12', title: '예약 취소 규칙', url: 'https://linear.app/x/issue/ENG-12', description: '당일 취소 수수료' })
  expect(text).toContain('Linear 이슈를 작업으로 시작해 주세요: ENG-12')
  expect(text).toContain('제목: 예약 취소 규칙')
  expect(text).toContain('주소: https://linear.app/x/issue/ENG-12')
  expect(text).toContain('설명:\n당일 취소 수수료')
  expect(text).toContain('set_task로 "ENG-12 예약 취소 규칙"')
})
