// dsh-qq 文件传输自测（2026-11-14）
// 只测纯函数：出站标记解析 + 发件路径白名单。不起 WS、不发任何消息。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseFileMarkers, readHintFor, resolveSendableFile, safeFileName, saveReceivedFile } from './index.js'

const results = []
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail })
}

// ── 1. 出站标记 ─────────────────────────────────────────
{
  const r = parseFileMarkers('[[file:D:/0Deepseek Harness/Work/1Talk/四级高频词-Day2-2026-11-14.docx]]\n给你')
  check('单个标记：抽出一个文件', r.files.length === 1, JSON.stringify(r.files))
  check('单个标记：文件名取 basename', r.files[0]?.name === '四级高频词-Day2-2026-11-14.docx', r.files[0]?.name)
  check('单个标记：剩下的字里没有标记', !r.text.includes('[[file:'), JSON.stringify(r.text))
  check('单个标记：剩下的字还在', r.text.includes('给你'), JSON.stringify(r.text))
}
{
  const r = parseFileMarkers('[[file:D:/a/b.docx|日报.docx]]')
  check('带显示名：name 用指定值', r.files[0]?.name === '日报.docx', r.files[0]?.name)
  check('带显示名：path 只取路径', r.files[0]?.path === 'D:/a/b.docx', r.files[0]?.path)
}
{
  const r = parseFileMarkers('看这两份\n[[file:D:/a/1.docx]]\n[[file:D:/a/2.pdf]]\n发你了')
  check('两个标记：都抽出来', r.files.length === 2, String(r.files.length))
  check('两个标记：文字保留前后', r.text.includes('看这两份') && r.text.includes('发你了'), JSON.stringify(r.text))
}
{
  const r = parseFileMarkers('没有标记的一句话')
  check('无标记：files 为空', r.files.length === 0)
  check('无标记：文字不动', r.text === '没有标记的一句话', r.text)
}

// ── 2. 发件白名单 ───────────────────────────────────────
const root = process.cwd()
const inside = path.join(root, 'selftest-files.mjs')
const outside = path.join(root, '..', 'package.json')

check('白名单内：能发', resolveSendableFile(inside, [root]).ok === true, JSON.stringify(resolveSendableFile(inside, [root])))
check('白名单外：拒发', resolveSendableFile(outside, [root]).ok === false, JSON.stringify(resolveSendableFile(outside, [root])))
check('不存在：拒发', resolveSendableFile(path.join(root, 'no-such-file.docx'), [root]).ok === false)
check(
  '凭据路径：拒发',
  resolveSendableFile(path.join(root, '.credentials.yaml'), [root], 0).ok === false,
  JSON.stringify(resolveSendableFile(path.join(root, '.credentials.yaml'), [root], 0)),
)
check('超上限：拒发', resolveSendableFile(inside, [root], 10).ok === false, JSON.stringify(resolveSendableFile(inside, [root], 10)))
check('windows 反斜杠写法：能发', resolveSendableFile(inside.replace(/\//g, '\\'), [root]).ok === true, inside.replace(/\//g, '\\'))
check('file:/// 写法：能发', resolveSendableFile(`file:///${inside.replace(/\//g, '/')}`, [root]).ok === true)

// ── 3. 收件落盘 ─────────────────────────────────────────
{
  check('安全名：去掉路径', safeFileName('D:/x/y/报告.docx') === '报告.docx', safeFileName('D:/x/y/报告.docx'))
  check('安全名：Windows 非法字符换掉', safeFileName('a:b*c?.docx') === 'a_b_c_.docx', safeFileName('a:b*c?.docx'))
  check('安全名：空名给兜底', safeFileName('') === 'file', safeFileName(''))
  check('安全名：超长截断', safeFileName('x'.repeat(300)).length === 120)

  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-qq-inbox-'))
  const src = path.join(box, 'src.docx')
  fs.writeFileSync(src, 'fake docx bytes')
  const first = saveReceivedFile(src, '四级高频词.docx', box)
  check('落盘：按 日期/文件名 建路径', first.includes(path.join('收件', '')) === false && fs.existsSync(first), first)
  check('落盘：内容一致', fs.readFileSync(first, 'utf8') === 'fake docx bytes')
  const second = saveReceivedFile(src, '四级高频词.docx', box)
  check('落盘：重名不覆盖', second !== first && fs.existsSync(first) && fs.existsSync(second), second)
  fs.rmSync(box, { recursive: true, force: true })
}

// ── 4. 回执里的「怎么读」 ───────────────────────────────
{
  check('提示：docx 点 ops_read_docx', readHintFor('报告.docx').includes('ops_read_docx'), readHintFor('报告.docx'))
  check('提示：DOC 大写也认', readHintFor('老文档.DOC').includes('ops_read_docx'), readHintFor('老文档.DOC'))
  check('提示：pdf 点 ops_read_pdf', readHintFor('a.pdf').includes('ops_read_pdf'), readHintFor('a.pdf'))
  check('提示：txt 说直接 read', readHintFor('notes.txt').includes('read'), readHintFor('notes.txt'))
  check('提示：md 说直接 read', readHintFor('a.md').includes('read'), readHintFor('a.md'))
  check('提示：zip 说先解开', readHintFor('a.zip').includes('压缩包'), readHintFor('a.zip'))
  check('提示：xlsx 指向 reader/office', readHintFor('表.xlsx').includes('reader'), readHintFor('表.xlsx'))
  check('提示：无扩展名给空串', readHintFor('没有后缀') === '', JSON.stringify(readHintFor('没有后缀')))
  check('提示：空名不炸', readHintFor(undefined) === '', JSON.stringify(readHintFor(undefined)))
}

// ── 输出 ────────────────────────────────────────────────
const bad = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  → ${r.detail}`}`)
console.log(`\n${results.length - bad.length}/${results.length} passed`)
process.exit(bad.length ? 1 : 0)
