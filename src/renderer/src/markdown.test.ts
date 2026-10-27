import { describe, expect, test } from 'vitest'
import { escapeHtml, inline, renderMarkdown } from './markdown'

describe('renderMarkdown', () => {
  test('escapes every tag and quote', () => {
    expect(escapeHtml(`<img src=x onerror="a">&'`)).toBe('&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;')
    const html = renderMarkdown('<script>alert(1)</script>\n- <b>x</b>\n`<i>`')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<b>x</b>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('<code>&lt;i&gt;</code>')
  })

  test('paragraphs split on blank lines, lines inside one join with a break', () => {
    expect(renderMarkdown('하나\n둘\n\n셋')).toBe('<p>하나<br>둘</p><p>셋</p>')
  })

  test('bullet and numbered lists, with indented continuation', () => {
    expect(renderMarkdown('- 가\n  이어서\n* 나')).toBe('<ul><li>가<br>이어서</li><li>나</li></ul>')
    expect(renderMarkdown('1. 가\nb) 나')).toBe('<ol><li>가</li><li>나</li></ol>')
  })

  test('bold and inline code; no bold inside code', () => {
    expect(inline('**굵게** 와 `**코드**`')).toBe('<b>굵게</b> 와 <code>**코드**</code>')
  })

  test('recommendation lines stand out', () => {
    expect(renderMarkdown('본문\n➡️ (a). 이유')).toBe('<p>본문</p><p class="md-rec">➡ (a). 이유</p>')
  })
})
