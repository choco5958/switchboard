import { expect, test } from 'vitest'
import { isLocalUrl, refRevision, snapshotText } from './agentBrowser'

test('only pages on this computer or the private network can be driven', () => {
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8951/x', 'https://app.localhost/', 'http://192.168.0.7:3000', 'http://10.1.2.3', 'http://172.20.0.2', 'http://[::1]:4000', 'http://mac.local:3000'])
    expect(isLocalUrl(url), url).toBe(true)
  for (const url of ['https://github.com', 'http://172.32.0.1', 'http://8.8.8.8', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url'])
    expect(isLocalUrl(url), url).toBe(false)
})

test('a ref names the reading it came from', () => {
  expect(refRevision('3:12')).toBe(3)
  expect(refRevision('12')).toBe(null)
})

test('a reading becomes lines the session can act on', () => {
  const text = snapshotText({
    url: 'http://localhost:5173/',
    title: '주문',
    elements: [
      { ref: '2:1', role: 'button', name: '저장' },
      { ref: '2:2', role: 'textbox', name: '' },
    ],
    text: '주문 목록\n3건',
    truncated: true,
  })
  expect(text).toBe('URL: http://localhost:5173/\nTitle: 주문\n\nElements (ref role "name"):\n[2:1] button "저장"\n[2:2] textbox\n\nText:\n주문 목록\n3건\n\n(truncated)')
})
