import { expect, test } from 'vitest'
import { isLocalUrl, refRevision, snapshotText } from './agentBrowser'

test('only pages on this computer can be driven, the private network too when the person allows it', () => {
  const here = ['http://localhost:5173/', 'http://127.0.0.1:8951/x', 'https://app.localhost/', 'http://[::1]:4000', 'http://127.1.2.3']
  const lan = ['http://192.168.0.1', 'http://192.168.0.7:3000', 'http://10.1.2.3', 'http://172.20.0.2', 'http://mac.local:3000']
  const never = ['https://github.com', 'http://172.32.0.1', 'http://8.8.8.8', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']
  for (const url of here) expect([isLocalUrl(url), isLocalUrl(url, true)], url).toEqual([true, true])
  for (const url of lan) expect([isLocalUrl(url), isLocalUrl(url, true)], url).toEqual([false, true])
  for (const url of never) expect([isLocalUrl(url), isLocalUrl(url, true)], url).toEqual([false, false])
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
