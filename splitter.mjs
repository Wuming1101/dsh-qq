/**
 * dsh-qq 的回复切分器（按原插件的调用约定复原）。
 *
 * 调用点（index.js 的 splitter()）：
 *   createSplitter({ maxParts, weights, minPartLength, followLines })(text).parts
 *
 * 手感规则来自两处硬证据：
 *   1. 原插件 patch 的注释：「两句就换行 = 两个气泡」——按行数定条数，不掷骰子；
 *   2. 脚本库 qq-lib.mjs 的同源实现：换行切条、最多 3 条、条间 900 + rand*1300ms。
 *
 * followLines = true（默认）：一行一个气泡；不足 minPartLength 的并进相邻条；
 * 超过 maxParts 时，前面各占一条，剩下的并成最后一条（用空格接，和 qq-lib 一致）。
 * followLines = false：按 weights 随机挑 1..maxParts 条，按句末标点切。
 */

const SENTENCE_END = /[。！？!?；;…]/

function normalize(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function capParts(parts, maxParts) {
  if (parts.length <= maxParts) return parts
  const head = parts.slice(0, maxParts - 1)
  head.push(parts.slice(maxParts - 1).join(' '))
  return head
}

function mergeShort(parts, minPartLength) {
  // 只在随机切分模式下用来合并过短碎片；followLines 模式不合并——
  // 「两句就换行 = 两个气泡」是硬规矩，短句也得单独成条。
  if (!minPartLength || minPartLength <= 0) return parts
  const out = []
  for (const p of parts) {
    if (out.length && p.length < minPartLength) {
      out[out.length - 1] = `${out[out.length - 1]} ${p}`.trim()
      continue
    }
    out.push(p)
  }
  return out
}

function pickWeighted(weights) {
  const entries = Object.entries(weights ?? {})
    .map(([k, v]) => [Number(k), Number(v)])
    .filter(([k, v]) => Number.isFinite(k) && Number.isFinite(v) && k >= 1 && v > 0)
  if (!entries.length) return 1
  const total = entries.reduce((a, [, v]) => a + v, 0)
  let r = Math.random() * total
  for (const [k, v] of entries) {
    r -= v
    if (r <= 0) return k
  }
  return entries[entries.length - 1][0]
}

function splitBySentence(text, target) {
  const chunks = []
  let buf = ''
  for (const ch of text) {
    buf += ch
    if (SENTENCE_END.test(ch) && buf.trim()) {
      chunks.push(buf.trim())
      buf = ''
    }
  }
  if (buf.trim()) chunks.push(buf.trim())
  if (chunks.length < target) {
    // 句子不够就按长度硬切，保证条数
    const out = []
    const size = Math.ceil(text.length / target)
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size).trim())
    return out.filter(Boolean)
  }
  // 句子多了就往 target 条里均摊
  const per = Math.ceil(chunks.length / target)
  const out = []
  for (let i = 0; i < chunks.length; i += per) out.push(chunks.slice(i, i + per).join(''))
  return out
}

export function createSplitter(options = {}) {
  const maxParts = Math.max(1, Math.min(9, Number(options.maxParts ?? 3) || 3))
  const minPartLength = Number(options.minPartLength ?? 0) || 0
  const followLines = options.followLines !== false
  const weights = options.weights ?? { 1: 50, 2: 30, 3: 20 }

  return function split(raw) {
    const text = String(raw ?? '').trim()
    if (!text) return { parts: [] }
    if (followLines) {
      const lines = normalize(text)
      if (lines.length <= 1) {
        return { parts: [text] }
      }
      return { parts: capParts(lines, maxParts) }
    }
    const want = Math.max(1, Math.min(maxParts, pickWeighted(weights)))
    if (want === 1) return { parts: [text] }
    return { parts: splitBySentence(text, want) }
  }
}

export default { createSplitter }
