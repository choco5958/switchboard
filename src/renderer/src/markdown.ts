// A tiny markdown renderer for question bodies: paragraphs, bullet and numbered lists, **bold**,
// `code`, and "➡" recommendation lines. Every character of the source is escaped first, so the
// result is safe to set as HTML.

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

export function inline(text: string): string {
  return text
    .split(/(`[^`]+`)/)
    .map(part =>
      part.startsWith('`') && part.endsWith('`') && part.length > 1
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>'),
    )
    .join('')
}

const BULLET = /^\s*[-*•]\s+(.*)$/
const NUMBERED = /^\s*(?:\d+|[a-z])[.)]\s+(.*)$/
const RECOMMEND = /^\s*(➡️?|=>|->)\s*(.*)$/

export function renderMarkdown(source: string): string {
  const out: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  let para: string[] = []
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map(item => `<li>${item}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  for (const line of source.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = BULLET.exec(line)
    const numbered = bullet ? null : NUMBERED.exec(line)
    const recommend = RECOMMEND.exec(line)
    if (line.trim() === '') {
      flushPara()
      flushList()
    } else if (recommend) {
      flushPara()
      flushList()
      out.push(`<p class="md-rec">➡ ${inline(recommend[2] ?? '')}</p>`)
    } else if (bullet || numbered) {
      flushPara()
      const tag = bullet ? 'ul' : 'ol'
      if (list && list.tag !== tag) flushList()
      list ??= { tag, items: [] }
      list.items.push(inline((bullet ?? numbered)![1] ?? ''))
    } else if (list && /^\s{2,}\S/.test(line)) {
      // An indented line continues the item above it.
      list.items[list.items.length - 1] += `<br>${inline(line.trim())}`
    } else {
      flushList()
      para.push(line.trim())
    }
  }
  flushPara()
  flushList()
  return out.join('')
}
