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

  // What a body may hold that a page must not run or link: each comes out as text, and the
  // only tags in the result are the renderer's own.
  const OWN_TAG = /^<\/?(p|br|ul|ol|li|b|code)( class="md-rec")?>$/
  const tagsOf = (html: string) => html.match(/<[^>]*>/g) ?? []

  test('markup in a body stays text', () => {
    expect(renderMarkdown('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
    expect(renderMarkdown('<img src=x onerror="alert(1)">')).toBe('<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>')
    expect(renderMarkdown('**<b>**')).toBe('<p><b>&lt;b&gt;</b></p>')
    expect(renderMarkdown('`**x**`')).toBe('<p><code>**x**</code></p>')
    expect(renderMarkdown('`</code><script>`')).toBe('<p><code>&lt;/code&gt;&lt;script&gt;</code></p>')
  })

  test('javascript: links are not links', () => {
    for (const source of ['[a](javascript:alert(1))', '<a href="javascript:alert(1)">a</a>', '- **[a](javascript:alert(1))**']) {
      const html = renderMarkdown(source)
      expect(html, source).not.toMatch(/<a[\s>]|href="/)
      for (const tag of tagsOf(html)) expect(tag, source).toMatch(OWN_TAG)
    }
  })

  test('nested or unbalanced emphasis still closes every tag it opens', () => {
    expect(renderMarkdown('**a **b** c**')).toBe('<p><b>a </b>b<b> c</b></p>')
    expect(renderMarkdown('***x***')).toBe('<p><b>*x</b>*</p>')
    expect(renderMarkdown('**a `b` c**')).toBe('<p>**a <code>b</code> c**</p>')
    for (const source of ['**a **b** c**', '***x***', '**a\nb**', '- **a\n  b**', '➡ **<i>**']) {
      const html = renderMarkdown(source)
      const tags = tagsOf(html)
      for (const tag of tags) expect(tag, source).toMatch(OWN_TAG)
      const opened = tags.filter(tag => !tag.startsWith('</') && tag !== '<br>').length
      expect(tags.filter(tag => tag.startsWith('</')).length, source).toBe(opened)
    }
  })

  test('recommendation lines stand out', () => {
    expect(renderMarkdown('본문\n➡️ (a). 이유')).toBe('<p>본문</p><p class="md-rec">➡ (a). 이유</p>')
  })
})
