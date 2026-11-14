/**
 * dsh-qq —— 把 QQ（NapCat / OneBot11）接到 DeepSeek Harness。
 *
 * 进：QQ 私聊 → 投进 agent 会话（文字/图片/表情/语音转写）
 * 出：assistant 的回话 → NapCat send_private_msg（文字/图片/表情/语音条）
 *
 * 不引 @deepseek-ai/* 依赖，服务一律走 ctx.get("...") 并判空。
 * 配置项见 README。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSplitter } from "./splitter.mjs";

export const name = "dsh-qq";
export const inject = [];

// ── 出站图片引用展开（2026-11-13）────────────────────────────
// 模型有时把图片写成 markdown：`![自画像](<D:/.../x.jpg>)`，或者单独一行甩一个本机图片路径。
// QQ 不认 markdown —— 不处理就会把字面量原样发出去（对方看到的是一串链接，不是图）。
// 这里统一折成出站标记 `[[img:路径]]`，再由 buildSegments 读成 base64 图片段发出去。
const IMG_FILE_RE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

function tryImagePath(raw) {
  const s = String(raw ?? "").trim().replace(/^<+/, "").replace(/>+$/, "");
  if (!s) return "";
  const noScheme = s.replace(/^file:\/\/\/?/i, "");
  const candidates = [noScheme];
  if (/^\/[A-Za-z]:[\\/]/.test(noScheme)) candidates.push(noScheme.slice(1));
  for (const c of candidates) {
    const norm = c.replace(/\\/g, "/");
    if (!/^[A-Za-z]:\//.test(norm) && !norm.startsWith("/")) continue;
    if (!IMG_FILE_RE.test(norm)) continue;
    try {
      if (fs.existsSync(norm)) return norm;
    } catch {
      /* 路径读不了就当不是图 */
    }
  }
  return "";
}

// 正文里的 markdown 图片 / 裸图片路径 → [[img:…]]；不是本机图片文件就原样留着。导出供自测。
export function expandImageRefs(raw) {
  let out = String(raw ?? "");
  // ① markdown 图片：![alt](<路径>) / ![alt](路径)
  out = out.replace(/!\[[^\]]*\]\(\s*([^)\r\n]+?)\s*\)/g, (full, p) => {
    const f = tryImagePath(p);
    return f ? `[[img:${f}]]` : full;
  });
  // ② 单独一行就是一个本机图片路径（允许 <…> 包裹）
  out = out.replace(/^[ \t]*(?:<([^>\r\n]+)>|([A-Za-z]:[\\/][^\r\n]*?))[ \t]*$/gm, (full, anchored, plain) => {
    const f = tryImagePath(anchored ?? plain);
    return f ? `[[img:${f}]]` : full;
  });
  return out;
}

// ── 出站文件标记 [[file:路径]] / [[file:路径|显示名]]（2026-11-14）────────────
// 和 [[img:…]] 同一套写法：写在一行里，发出前会被读成真正的 QQ 文件，剩下的字才当文字发。
// 单独一行 = 一个文件气泡；想说的话另起一行。
const FILE_MARKER_RE = /\[\[file:\s*([^\]|\r\n]+?)\s*(?:\|\s*([^\]\r\n]*?)\s*)?\]\]/g;

// 从一段回复里抽出文件标记。导出供自测。
export function parseFileMarkers(raw) {
  const files = [];
  const text = String(raw ?? "").replace(FILE_MARKER_RE, (_all, p, n) => {
    const filePath = String(p ?? "").trim();
    if (filePath) {
      const fallback = filePath.split(/[\\/]/).pop() || "file";
      files.push({ path: filePath, name: String(n ?? "").trim() || fallback });
    }
    return "";
  });
  return { files, text: text.replace(/\n{3,}/g, "\n\n").trim() };
}

// 不该往外发的路径：凭据、profile、记忆库。导出供自测。
const BLOCKED_FILE_RE = /(?:\.credentials\.ya?ml|\.dsh[\\/]|companion-memory|1Deepseek memory)/i;

// 能不能发这个文件：必须在允许目录里、存在、是普通文件、不超上限。导出供自测。
export function resolveSendableFile(rawPath, roots, maxBytes = 0) {
  const input = String(rawPath ?? "")
    .trim()
    .replace(/^<+/, "")
    .replace(/>+$/, "")
    .replace(/^file:\/\/\/?/i, "");
  if (!input) return { ok: false, reason: "路径是空的" };
  let candidate = input.replace(/\\/g, "/");
  if (/^\/[A-Za-z]:\//.test(candidate)) candidate = candidate.slice(1);
  const abs = path.resolve(candidate);
  if (BLOCKED_FILE_RE.test(abs)) return { ok: false, reason: "这个路径看着像凭据/记忆库，拒发" };
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return { ok: false, reason: `文件不存在：${abs}` };
  }
  if (!st.isFile()) return { ok: false, reason: `不是文件：${abs}` };
  const allow = (Array.isArray(roots) && roots.length ? roots : [])
    .map((r) => {
      try {
        return path.resolve(String(r));
      } catch {
        return "";
      }
    })
    .filter(Boolean);
  if (allow.length) {
    const norm = abs.replace(/\\/g, "/").toLowerCase();
    const inside = allow.some((root) => {
      const r = root.replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
      return norm === r || norm.startsWith(`${r}/`);
    });
    if (!inside) return { ok: false, reason: `不在允许目录里（${allow.join(" / ")}）：${abs}` };
  }
  if (maxBytes > 0 && st.size > maxBytes) {
    return {
      ok: false,
      reason: `文件太大（${(st.size / 1048576).toFixed(1)}MB），上限 ${(maxBytes / 1048576).toFixed(0)}MB`,
    };
  }
  return { ok: true, path: abs, bytes: st.size, name: path.basename(abs) };
}

// 收件落盘用的安全文件名：去掉路径和 Windows 不允许的字符，最多 120 字。导出供自测。
const SAFE_NAME_RE = /[\\/:*?"<>|\u0000-\u001f]/g;
export function safeFileName(raw, fallback = "file") {
  const base = String(raw ?? "")
    .replace(/^.*[\\/]/, "")
    .replace(SAFE_NAME_RE, "_")
    .trim();
  const cut = base.length > 120 ? base.slice(0, 120) : base;
  return cut || fallback;
}

// 收到文件时给一句「怎么读」：照着工具名说，别让 agent 自己猜。
// 2026-11-14 验过：ops_read_docx 能直接读收件里那份 809 段的 docx（含表格坐标），ops_read_pdf 同理。
const READ_HINT_DOCX_RE = /\.(docx?)$/i;
const READ_HINT_PDF_RE = /\.pdf$/i;
const READ_HINT_TEXT_RE = /\.(md|markdown|txt|log|csv|tsv|json|ya?ml|xml|html?|js|mjs|cjs|ts|tsx|py|sh|ps1|bat|ini|toml)$/i;
const READ_HINT_SHEET_RE = /\.(xlsx?|pptx?|rtf|odt|ods|odp)$/i;
const READ_HINT_ARCHIVE_RE = /\.(zip|7z|rar|gz|tgz|tar|bz2|xz)$/i;
export function readHintFor(fileName) {
  const name = String(fileName ?? "");
  if (READ_HINT_DOCX_RE.test(name)) return "读内容用 ops_read_docx；";
  if (READ_HINT_PDF_RE.test(name)) return "读内容用 ops_read_pdf；";
  if (READ_HINT_TEXT_RE.test(name)) return "读内容直接 read 这个路径；";
  if (READ_HINT_SHEET_RE.test(name)) return "读内容先 ops_discover_tools 找 reader，或者走 office 技能/Univer；";
  if (READ_HINT_ARCHIVE_RE.test(name)) return "这是压缩包，先解开再看；";
  return "";
}

// 把收到的文件拷进「收件/YYYY-MM-DD/」，重名就加个后缀。导出供自测。
export function saveReceivedFile(localPath, fileName, receiveDir) {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(String(receiveDir), day);
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, safeFileName(fileName));
  if (fs.existsSync(dest)) {
    const ext = path.extname(dest);
    const stem = dest.slice(0, dest.length - ext.length);
    dest = `${stem}-${Date.now().toString().slice(-6)}${ext}`;
  }
  fs.copyFileSync(localPath, dest);
  return dest;
}

// 进程级实例登记表：跨 re-import 共享。apply 若被 loader 调用多次（僵尸实例），
// 新实例接管前先关掉旧实例，避免累积多条 WS 连接导致重复回复。
const registry = (globalThis[Symbol.for("dsh-qq.registry")] ||= new Set());

const DEFAULTS = {
  // NapCat 的 OneBot11 WebSocket 服务端地址（NapCat 里开「WebSocket 服务器」）
  wsUrl: "ws://127.0.0.1:3001",
  // 和 NapCat 那边填的 token 一致；没设 token 就留空
  token: "",
  // 机器人自己的 QQ 号；事件里带 self_id 时优先用事件的，这里只做兜底。
  // 用在「群里有没有 @ 我」的判断上，留 0 就只信事件自带的值。
  selfId: 0,
  // 只接这些 QQ 号发来的私聊。必填，空数组 = 谁都不接（防止陌生人把你的 bot 当免费助手）
  owners: [],
  // 会话工作目录；留空用环境变量 DSH_WORKSPACE，再没有就用进程当前目录
  cwd: "",
  // 本地转写脚本（可选）。填了才处理语音；留空则收到语音只记一行占位
  // 约定：执行 `node <脚本> <wav路径>`，stdout 第一行是转写文本，可选的以 [语气] 开头的行是语气描述
  earScript: "",
  // 临时文件目录（收图/收语音都落这里）；默认系统临时目录下的 dsh-qq
  tmpDir: path.join(os.tmpdir(), "dsh-qq"),
  // 状态目录；留空用 <DSH_HOME>/qq
  stateDir: "",
  // 回一句话最多多少字（超了切段发）
  maxChars: 1800,
  // 会话用哪个模型。留空 = 跟 agent-default-model 走。
  // 注意：如果默认模型指向本地服务而那个服务没起，QQ 这边会回 503，建议显式填云端
  provider: "",
  model: "",
  // 推理等级（off/low/high/max）。留空 = 用该模型自己的默认档。
  reasoningEffort: "",
  // 把 QQ 接到指定的那间会话（填 sessionId 就一直用它，不新建）。
  // 留空 = 第一句话时自己新建一个会话
  sessionId: "",
  // 新建会话用哪个 agent preset；留空 = 跟随全局默认（agentPresets.defaultId）
  // 例：memory（聊天模式）。只作用于本插件新建的会话，不动全局默认。
  agentPreset: "",
  // 群消息：false = 只记日志不投递
  groupMessages: false,
  // 【2026-11-14】出站文件上限（MB）。超过就不发，把原因写在日志里，不让它悄悄失败。
  maxFileMB: 50,
  // 收到 QQ 文件落到哪里；留空 = <cwd>/收件
  receiveDir: "",
  // 允许往外发的目录白名单。留空 = [cwd, 收件目录]。别处的文件一律不发。
  fileRoots: [],
};

function workdir(cfg) {
  return cfg.cwd || process.env.DSH_WORKSPACE || process.cwd();
}

function resolveStateDir(cfg) {
  if (cfg.stateDir) return cfg.stateDir;
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, "qq");
}

function loadState(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (raw.sessions && typeof raw.sessions === "object") return raw; // 新格式：每用户一会话
      // 旧格式 { sessionId, owner } → 迁移：旧会话归到 owner 名下
      const sessions = {};
      if (raw.sessionId && raw.owner) sessions[String(raw.owner)] = raw.sessionId;
      return { sessions, owner: raw.owner || 0 };
    }
    return { sessions: {}, owner: 0 };
  } catch {
    return { sessions: {}, owner: 0 };
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

function textOf(event) {
  const blocks = event?.data?.message?.content ?? [];
  return blocks
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export function apply(ctx, rawConfig = {}) {
  const cfg = { ...DEFAULTS, ...pickDefined(rawConfig) };
  const stateFile = path.join(resolveStateDir(cfg), "state.json");
  const state = loadState(stateFile);
  fs.mkdirSync(cfg.tmpDir, { recursive: true });

  // ── 收件目录 / 发件白名单（2026-11-14）──────────────────
  function receiveDirOf() {
    try {
      return path.resolve(cfg.receiveDir || path.join(workdir(cfg), "收件"));
    } catch {
      return path.join(workdir(cfg), "收件");
    }
  }
  function fileRootsOf() {
    const configured = Array.isArray(cfg.fileRoots)
      ? cfg.fileRoots.filter((x) => typeof x === "string" && x.trim())
      : [];
    if (configured.length) return configured;
    return [workdir(cfg), receiveDirOf()];
  }
  function maxFileBytes() {
    const mb = Number(cfg.maxFileMB);
    return Number.isFinite(mb) && mb > 0 ? Math.round(mb * 1024 * 1024) : 0;
  }

  // 【2026-11-12】诊断留底：可疑/被丢弃的原始事件原样写进 raw-events.jsonl（≤512KB，超了滚一份）。
  // 起因：QQ 偶尔推来一条「没有可读内容」的私聊事件，光看日志看不出 NapCat 到底推了什么。
  const rawLogFile = path.join(resolveStateDir(cfg), "raw-events.jsonl");
  function dumpRaw(kind, msg, extra) {
    try {
      fs.mkdirSync(path.dirname(rawLogFile), { recursive: true });
      try {
        if (fs.statSync(rawLogFile).size > 512 * 1024) fs.renameSync(rawLogFile, `${rawLogFile}.1`);
      } catch {}
      fs.appendFileSync(rawLogFile, `${JSON.stringify({ at: new Date().toISOString(), kind, extra, event: msg })}\n`, "utf8");
    } catch (err) {
      console.error(`[dsh-qq] 写原始事件失败: ${String(err)}`);
    }
  }

  // 【2026-11-13 诊断】桌面宿主把插件的 console 输出吞了：出故障时屏幕上只剩一句
  // 「本轮运行失败 …」，具体哪一步炸的全看不见。关键失败点都往 <stateDir>/dsh-qq.log 记一行。
  const diagLogFile = path.join(resolveStateDir(cfg), "dsh-qq.log");
  function diag(msg) {
    try {
      fs.mkdirSync(path.dirname(diagLogFile), { recursive: true });
      try {
        if (fs.statSync(diagLogFile).size > 1024 * 1024) fs.renameSync(diagLogFile, `${diagLogFile}.1`);
      } catch {}
      fs.appendFileSync(diagLogFile, `${new Date().toISOString()} ${msg}\n`, "utf8");
    } catch {}
  }
  diag(`apply 启动 pid=${process.pid} wsUrl=${cfg.wsUrl} owners=${JSON.stringify(cfg.owners)} cwd=${workdir(cfg)}`);
  diag("出站图片展开 v2026-11-13：markdown 图片 / 裸路径 → [[img:…]] 已启用");

  if (!Array.isArray(cfg.owners) || cfg.owners.length === 0) {
    console.error("[dsh-qq] 没配 owners：所有私聊都会被忽略。把允许的 QQ 号填进配置里的 owners。");
  }

  let ws = null;
  let connected = false;
  let closed = false;
  // 关闭本实例（含 socket），供新实例接管时调用
  const selfClose = () => {
    closed = true;
    try { ws?.close(); } catch {}
    registry.delete(selfClose);
  };
  // 接管：先关掉所有旧实例，让本实例成为唯一活跃者
  registry.add(selfClose);
  for (const other of registry) {
    if (other !== selfClose) {
      try { other(); } catch {}
    }
  }
  let seq = 0;
  const pending = new Map();
  // 当前消息来源：{ type: 'private'|'group', id: 用户号/群号 }，回复时按来源发回去
  let lastSource = null;
  const recentMsgIds = new Map(); // 最近处理过的消息 id，防 NapCat 对同一条消息重复上报
  const pendingFriendRequests = new Map(); // user_id -> { flag, comment, time }，待 owner 点头的好友申请
  const sessionSource = new Map(); // sessionId -> { type, id }，QQ 会话对应的来源（回推定位）
  const qqTurnBySession = new Map(); // sessionId -> 时间戳，每会话「这轮是否 QQ 发起」的窗口
  // [重建] 本段原文件未完整出现在会话日志里，按调用点与相邻代码复原。
  // call()：一次 OneBot 请求，靠 echo 在 connect() 的回包分支里兑现（pending/seq 在下面已声明）。
  function call(action, params = {}, timeoutMs = 20000) {
    return new Promise((resolve) => {
      try {
        if (!ws || ws.readyState !== 1) {
          resolve({ status: "closed" });
          return;
        }
      } catch {
        resolve({ status: "closed" });
        return;
      }
      const echo = `c${++seq}`;
      const timer = setTimeout(() => {
        pending.delete(echo);
        resolve({ status: "timeout" });
      }, timeoutMs);
      pending.set(echo, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(echo);
        resolve({ status: "error", message: String(err) });
      }
    });
  }

  // ── 出：把本机文件真发到 QQ（private → upload_private_file，群 → upload_group_file）──
  // 【2026-11-14】NapCat 的这两个接口是「读本机路径再上传」，所以传绝对路径就行，
  // 不用像图片那样读成 base64（NapCat 就在本机 Windows 上，盘符看得见）。
  async function sendFile(source, rawPath, nameOverride) {
    const target = source || lastSource || { type: "private", id: cfg.owners[0] };
    const toId = Number(target?.id);
    if (!Number.isFinite(toId) || toId <= 0) {
      return { ok: false, reason: "没有可用的 QQ 会话（不知道该发给谁）" };
    }
    if (target.type !== "group" && !cfg.owners.includes(toId)) {
      return { ok: false, reason: `目标 ${toId} 不在 owners 白名单里，不发` };
    }
    const checked = resolveSendableFile(rawPath, fileRootsOf(), maxFileBytes());
    if (!checked.ok) return checked;
    const name = String(nameOverride ?? "").trim() || checked.name;
    const isGroup = target.type === "group";
    const params = isGroup
      ? { group_id: toId, file: checked.path, name }
      : { user_id: toId, file: checked.path, name };
    const r = await call(isGroup ? "upload_group_file" : "upload_private_file", params, 120000);
    if (r?.status !== "ok") {
      const why = r?.message || r?.wording || r?.retcode || r?.status || "unknown";
      diag(`发文件失败 ${checked.path} → ${isGroup ? "群" : "私聊"}${toId}: ${JSON.stringify(r).slice(0, 300)}`);
      return { ok: false, reason: `上传失败：${String(why).slice(0, 200)}`, path: checked.path };
    }
    const fileId = r?.data?.file_id ?? r?.data?.fileId ?? "";
    diag(`发文件成功 ${checked.path}（${checked.bytes}B）→ ${isGroup ? "群" : "私聊"}${toId} file_id=${fileId}`);
    return {
      ok: true,
      path: checked.path,
      name,
      bytes: checked.bytes,
      file_id: String(fileId ?? ""),
      target: { type: isGroup ? "group" : "private", id: toId },
    };
  }

  // ── 入：QQ 文件消息落到本机（get_file 下到临时目录，再拷进收件目录）──
  async function downloadToTemp(url, fileName) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        console.error(`[dsh-qq] 文件下载失败: HTTP ${res.status}`);
        return "";
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) return "";
      fs.mkdirSync(cfg.tmpDir, { recursive: true });
      const file = path.join(cfg.tmpDir, `qq-file-${Date.now()}${path.extname(safeFileName(fileName))}`);
      fs.writeFileSync(file, buf);
      return file;
    } catch (err) {
      console.error(`[dsh-qq] 文件下载出错: ${String(err)}`);
      return "";
    }
  }
  async function receiveFile(d) {
    const data = d && typeof d === "object" ? d : {};
    const fileName = String(data.file_name || data.name || data.file || "未命名文件");
    const size = Number(data.file_size ?? data.size ?? 0);
    const sizeText = size > 0 ? `（${Math.max(1, Math.round(size / 1024))}KB）` : "";
    let local = "";
    // 实测（2026-11-14）：事件里的 data.file 是**文件名**，不是能直接喂给 get_file 的编码串；
    // data.file_id 才是。所以先试 file_id，再退回 file，最后才用 url 直接下。
    const tries = [];
    if (data.file_id) tries.push({ file_id: String(data.file_id) });
    if (data.file) tries.push({ file: String(data.file) });
    for (const params of tries) {
      const r = await call("get_file", params, 120000);
      const got = r?.status === "ok" ? String(r?.data?.file ?? "") : "";
      if (got && fs.existsSync(got)) {
        local = got;
        break;
      }
      if (r?.status === "ok" && r?.data?.url && /^https?:/i.test(String(r.data.url))) {
        local = await downloadToTemp(String(r.data.url), fileName);
        if (local) break;
      }
    }
    if (!local && data.url && /^https?:/i.test(String(data.url))) {
      local = await downloadToTemp(String(data.url), fileName);
    }
    if (!local) {
      diag(`收文件失败 ${fileName}${sizeText} file_id=${data.file_id ?? "-"}`);
      return `[收到文件「${fileName}」${sizeText}，但没能下载到本机]`;
    }
    const dest = saveReceivedFile(local, fileName, receiveDirOf());
    diag(`收到文件 ${fileName} → ${dest}`);
    return `[收到文件「${fileName}」${sizeText}，已存到本机：${dest}。${readHintFor(fileName)}要转给别人就把这个路径交给 qq_send_file。]`;
  }

  // [重建] transcribeVoice：同步拿 NapCat 的语音再转写。尾部（写 wav + earScript）是日志原文，
  // 头部（起子进程取语音、打印 base64）按尾部约定复原。
  function transcribeVoice(fileName) {
    const wavPath = path.join(resolveStateDir(cfg), `voice-${Date.now()}.wav`);
    let r;
    try {
      const script = [
        "const ws=new WebSocket(process.env.NQ);",
        "const done=(s,c)=>{try{ws.close()}catch{};process.exitCode=c;process.stdout.write(s||'')};",
        "ws.onopen=()=>ws.send(JSON.stringify({action:'get_record',params:{file:process.env.NF,out_format:'wav'},echo:'r1'}));",
        "ws.onmessage=(e)=>{let m;try{m=JSON.parse(e.data)}catch{return};",
        "  if(m.echo!=='r1')return;",
        "  if(m.status!=='ok'){console.error(m.message||m.wording||'get_record failed');return done('',2)}",
        "  const f=m.data&&(m.data.file||m.data.base64);",
        "  if(!f){return done('',3)}",
        "  if(f.startsWith('base64://'))return done(f.slice(9),0);",
        "  if(/^\/\//.test(f))return done(f.slice(2),0);",
        "  if(f.startsWith('http')){fetch(f).then(x=>x.arrayBuffer()).then(b=>done(Buffer.from(b).toString('base64'),0)).catch(()=>done('',4));return}",
        "  return done('',5);",
        "};",
        "ws.onerror=()=>{done('',6)};",
        "setTimeout(()=>{done('',7)},15000);",
      ].join("\n");
      r = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf8",
        timeout: 60000,
        env: { ...process.env, NQ: cfg.wsUrl, NF: fileName },
      });
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
    if (!r || r.status !== 0 || !(r.stdout || "").trim()) {
      return { ok: false, reason: (r && (r.stderr || r.stdout)) || "取语音失败" };
    }
    try {
      fs.writeFileSync(wavPath, Buffer.from(r.stdout.trim(), "base64"));
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
    if (!cfg.earScript) {
      return { ok: false, reason: "没配 earScript（转写脚本），这条语音只留了占位" };
    }
    const ear = spawnSync(process.execPath, [cfg.earScript, wavPath], { encoding: "utf8", timeout: 180000 });
    const out = (ear.stdout || "").trim();
    if (!out) return { ok: false, reason: ear.stderr || "转写没有输出" };
    const lines2 = out.split(/\r?\n/).filter(Boolean);
    const words = lines2.find((l) => !l.startsWith("[语气")) || "";
    const tone = lines2.find((l) => l.startsWith("[语气]")) || "";
    return { ok: true, words, tone };
  }

  // 【2026-11-13 防线 v3】宿主引擎（0.2.2-rc.1）有个 bug：记忆预设的上下文折叠
  // developer 消息（「更早的对话已不在本轮上下文中…」）发出时不带 turn/step，
  // 编码器直接炸 `developer/message turn must be a non-negative safe integer`，整批写盘失败，
  // 会话持久化队列从此堵死，每轮都报错。
  // v2 防线补 turn 后写入的位置仍在 step/end 之后，重启后读校验炸
  // `developer/message does not match an open turn and step`，反而把会话文件写坏。
  // v3 策略：缺 turn/step 的折叠 developer/message 一律转 ignorable 未知类型——
  // 写校验与读校验都跳过它，原始数据保留在日志里；代价是模型看不到这条折叠提示、
  // surface 不折叠（上下文略长）。带完整 turn/step 的原样放行。
  // 安装时机：冷启动时 sessionPersistence 可能还没就绪，apply 试一次，等 ready 再试。
  const PERSIST_ORIG = Symbol.for("dsh-qq.persistOrig");
  const PERSIST_VERSION = Symbol.for("dsh-qq.persistVersion");
  const PERSIST_V = 3;
  function installPersistDefense() {
    try {
      const sp = ctx.get("sessionPersistence");
      if (!sp || typeof sp.appendLines !== "function") return false;
      if (!sp[PERSIST_ORIG]) sp[PERSIST_ORIG] = sp.appendLines.bind(sp);
      if (sp[PERSIST_VERSION] === PERSIST_V) return true;
      sp[PERSIST_VERSION] = PERSIST_V;
      const origAppendLines = sp[PERSIST_ORIG];
      sp.appendLines = function patchedAppendLines(header, ...rest) {
        const maybe = rest[0];
        const events = Array.isArray(maybe) ? maybe : Array.isArray(header) ? header : null;
        if (events) {
          try {
            let changed = false;
            const out = [];
            for (const e of events) {
              if (e?.type === "developer/message" && (!Number.isFinite(e?.data?.turn) || !Number.isFinite(e?.data?.step))) {
                out.push({ ...e, type: "ignored/developer-fold", ignorable: true });
                diag("DEVREPAIR ignorable 化缺 turn/step 的 developer/message");
                changed = true;
              } else {
                out.push(e);
              }
            }
            if (changed) {
              try {
                events.splice(0, events.length, ...out);
              } catch {
                rest[0] = out;
              }
            }
          } catch (err) {
            diag(`DEVREPAIR 失败 ${String(err)}`);
          }
        }
        return origAppendLines(header, ...rest);
      };
      diag("防线已装 v3：缺 turn/step 的 developer/message 转 ignorable");
      return true;
    } catch (err) {
      diag(`防线安装失败 ${String(err)}`);
      return false;
    }
  }
  if (!installPersistDefense()) {
    diag("apply 时 sessionPersistence 未就绪，等 ready 再装");
    ctx.on("ready", () => {
      if (!installPersistDefense()) diag("ready 后防线仍未装上：sessionPersistence 拿不到");
    });
  }
  // ── 会话 ──────────────────────────────────────────────────
  async function ensureAgent(userId) {
    const agents = ctx.get("agents");
    if (!agents) return undefined;
    // 配置里绑了 sessionId 就一直用那一间（所有人共用，保持旧行为）；
    // 没绑定则按用户各开一间独立上下文。
    const bound = cfg.sessionId || "";
    const key = String(userId ?? state.owner ?? "");
    const target = bound || state.sessions[key];
    if (target) {
      const live = agents.get(target);
      if (live) {
        diag(`ensureAgent key=${key} 命中内存里的会话 ${target} status=${live.status} phase=${live.phase?.kind ?? "?"}`);
        return live;
      }
      try {
        const handle = await agents.resume({ resumeSessionId: target, setup: agentSetup });
        diag(`ensureAgent resume ${target} 成功 agent=${handle?.agent?.id ?? "无"} status=${handle?.agent?.status ?? "?"}`);
        return handle.agent;
      } catch (err) {
        diag(`ensureAgent resume ${target} 失败: ${String(err)}\n${err?.stack ?? ""}`);
        console.error(`[dsh-qq] resume ${target} 失败: ${String(err)}\n${err?.stack ?? ""}`);
        if (bound) {
          // 绑定的那间 resume 不上就放弃，绝不偷偷新建——否则又是两个我
          console.error("[dsh-qq] 绑定的会话拿不到，这条消息丢弃（不会另开新会话）");
          return undefined;
        }
        delete state.sessions[key];
        saveState(stateFile, state);
      }
    }
    try {
      const sessionId = `session-${crypto.randomUUID()}`;
      const presetId = cfg.agentPreset || ctx.get("agentPresets")?.defaultId;
      const handle = await agents.create({
        sessionId,
        meta: { cwd: workdir(cfg), ...(presetId ? { agentPreset: presetId } : {}) },
        agentOptions: cfg.provider && cfg.model
          ? { provider: cfg.provider, model: cfg.model, ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}) }
          : undefined,
        setup: agentSetup,
      });
      const sid = handle?.agent?.id || sessionId;
      diag(`ensureAgent create 新建会话 ${sid} (key=${key})`);
      state.sessions[key] = sid;
      saveState(stateFile, state);
      await attachToWorkspace(sid);
      console.log(`[dsh-qq] 为 ${key} 新建会话 ${sid}`);
      return handle.agent;
    } catch (err) {
      diag(`ensureAgent create 失败: ${String(err)}\n${err?.stack ?? ""}`);
      console.error(`[dsh-qq] 建会话失败: ${String(err)}\n${err?.stack ?? ""}`);
      return undefined;
    }
  }

  async function attachToWorkspace(sessionId) {
    const registry = ctx.get("workspaceRegistry");
    if (!registry || !sessionId) return;
    try {
      let workspace = await registry.resolveByPath(workdir(cfg));
      if (!workspace) workspace = await registry.create(workdir(cfg));
      await workspace.attachSession(sessionId);
    } catch (err) {
      console.error(`[dsh-qq] 会话挂工作区失败: ${String(err)}`);
    }
  }

  // 照 dsh-wechat 的写法来：setup 拿到的 agentCtx 是这次会话自己的作用域，
  // 所有服务都必须从 agentCtx 取（不能回落到插件自己的 ctx——插件一重载，
  // 那份 ctx 就是 inactive，mount 会报 cannot create effect on inactive context）。
  async function agentSetup(agentCtx, agent) {
    const live = agent ?? agentCtx?.agent;
    const presets = agentCtx?.get?.("agentPresets");
    if (presets) {
      try {
        await presets.mount(agentCtx, live?.session?.header?.agentPreset);
      } catch (err) {
        console.error(`[dsh-qq] preset mount 失败: ${String(err)}`);
      }
    }
    // 【模型变量】必须补上，否则第一轮直接报
    //   `prompt variable "{{model}}" has no value for this assembly`
    // 然后 turn 抛错、被引擎 kick() 的 catch 静默吃掉（症状：投递成功、没回复、没报错）。
    // 做法：setup 里用 agent.model.select() 固定模型（step preparation 之前），
    // 再用 system-prompt/assemble 给 {{provider}}/{{model}} 变量赋值。
    installModelSelection(agentCtx, live);
    // ⚠ 必须返回 undefined（或带 .commit() 的作用域句柄）。
    // 引擎侧是 `(await setup(prepared.agent.ctx, prepared.agent))?.commit()`
    // —— 返回 agent 本身就会报 `commit is not a function`，整个建会话失败。
    return undefined;
  }

  function installModelSelection(agentCtx, live) {
    const agent = live ?? agentCtx?.agent;
    const defaultModel = agentCtx?.get?.("agentDefaultModel");
    const fixed = cfg.provider && cfg.model
      ? { provider: cfg.provider, model: cfg.model, ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}) }
      : undefined;
    const currentSelection = () => {
      // 【顺序很重要】配置里写死的放最前。
      if (fixed) return fixed;
      const logged = live?.session?.requestHeader?.()?.config;
      if (logged?.provider && logged.model) {
        return {
          provider: logged.provider,
          model: logged.model,
          ...(logged.reasoningEffort ? { reasoningEffort: logged.reasoningEffort } : {}),
        };
      }
      return defaultModel?.currentSelection?.();
    };

    // 【正确时机】在 step preparation 之前用 agent.model.select() 固定模型。
    // 旧版用 agent/request 在 step preparation 之后改，引擎会告警「错位」且不生效。
    const selected = currentSelection();
    if (selected?.provider && selected.model && agent?.model?.select) {
      try {
        agent.model.select({
          provider: selected.provider,
          model: selected.model,
          ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
        });
        console.log(`[dsh-qq] 模型固定为 ${selected.provider}/${selected.model}`);
      } catch (err) {
        console.error(`[dsh-qq] 固定模型失败: ${String(err)}`);
      }
    }

    // 给 system prompt 的 {{provider}}/{{model}} 变量赋值（读同一份选择）
    agentCtx.on?.("system-prompt/assemble", async (_assembly, _context, next) => {
      const s = currentSelection();
      const assembled = await next();
      if (!s?.provider || !s.model) return assembled;
      return {
        ...assembled,
        variables: { ...assembled.variables, provider: s.provider, model: s.model },
      };
    });
  }

  // ── 收图：下载到本机（照 dsh-qq-onebot 的 downloadImage） ──────────
  const IMG_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp" };
  async function downloadImage(url) {
    try {
      fs.mkdirSync(cfg.tmpDir, { recursive: true });
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) {
        console.error(`[dsh-qq] 图片下载失败: HTTP ${res.status}`);
        return "";
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 12 * 1024 * 1024) {
        console.error(`[dsh-qq] 图片大小不对: ${buf.length} B`);
        return "";
      }
      const ext = IMG_EXT[(res.headers.get("content-type") ?? "").split(";")[0].trim()] ?? ".jpg";
      const file = path.join(cfg.tmpDir, `qq-${Date.now()}-${crypto.randomBytes(2).toString("hex")}${ext}`);
      fs.writeFileSync(file, buf);
      return file;
    } catch (err) {
      console.error(`[dsh-qq] 图片下载出错: ${String(err)}`);
      return "";
    }
  }

  // ── 出：assistant → QQ ────────────────────────────────────
  // 支持三种出站标记（写在回复正文里，发出前会被剥掉）：
  //   [[img:绝对路径]]                  → 发一张本机图片
  //   [[face:编号]]                     → 发 QQ 内置表情，如 [[face:178]]
  //   [[mface:emoji_id/package_id/名字]] → 发商城表情包
  const outBuffer = new Map();

  // 【本机补丁 2026-11-06】出站要按来源分流（花猫：「我在桌面就在桌面回，我在手机就在手机回」）。
  //   以前每一轮只要结束就往 QQ 推一遍，桌面聊天也会被镜像到手机，很吵。
  //   做法：QQ 投递进来时开一个窗口，只有这轮窗口内的 assistant/message 才回推 QQ；
  //   回一次就把窗口关掉，桌面发起的轮次自然落不进来。
  //   30 分钟是「一轮最长能跑多久」，正常几秒就回来了；窗口过期不影响桌面。
  //   多会话：每个 QQ 会话一个窗口，存在 qqTurnBySession 里。
  const QQ_TURN_WINDOW_MS = 30 * 60 * 1000;

  function buildSegments(raw) {
    const segs = [];
    // 【2026-11-13】先展开 markdown 图片 / 裸图片路径 → [[img:…]]，再按出站标记切段
    raw = expandImageRefs(raw);
    const re = /\[\[(img|face|mface):([^\]]+)\]\]/g;
    let last = 0;
    let m;
    const pushText = (t) => {
      if (!t) return;
      for (let i = 0; i < t.length; i += cfg.maxChars) {
        segs.push({ type: "text", data: { text: t.slice(i, i + cfg.maxChars) } });
      }
    };
    while ((m = re.exec(raw)) !== null) {
      pushText(raw.slice(last, m.index));
      const kind = m[1];
      const body = m[2].trim();
      if (kind === "img") {
        // ⚠ 实测：NapCat 若跑在 WSL 里，发 `file:///D:/...` 这类 Windows 路径会报
        //   `ENOENT`——它看不到 Windows 盘符，所以图片一律读成 base64 再发。
        //   `base64://` 能通（536 KB 的 png 一次 2 秒发出去），所以一律读成 base64 发。
        try {
          if (body && fs.existsSync(body)) {
            const b64 = fs.readFileSync(body).toString("base64");
            segs.push({ type: "image", data: { file: `base64://${b64}` } });
          } else {
            console.warn(`[dsh-qq] 图片不存在，跳过: ${body}`);
          }
        } catch (err) {
          console.error(`[dsh-qq] 读图片失败: ${String(err)}`);
        }
      } else if (kind === "face") {
        if (body) segs.push({ type: "face", data: { id: body } });
      } else if (kind === "mface") {
        const [emojiId = "", packageId = "", summary = ""] = body.split("/");
        if (emojiId) {
          segs.push({
            type: "mface",
            data: { emoji_id: emojiId, emoji_package_id: packageId || "1", summary: summary || "[表情]" },
          });
        }
      }
      last = m.index + m[0].length;
    }
    pushText(raw.slice(last));
    return segs;
  }

  // ── 发送：模型一次生成的完整回复，按配置随机切成 1~3 条独立消息发出去 ──
  let splitReply = null;
  function splitter() {
    if (!splitReply) {
      splitReply = createSplitter({
        maxParts: Number(cfg.maxParts ?? 3),
        weights: cfg.weights ?? { 1: 50, 2: 30, 3: 20 },
        minPartLength: Number(cfg.minPartLength ?? 8),
        followLines: cfg.followLines !== false,
      });
    }
    return splitReply;
  }

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendToQq(text, src) {
    let parts;
    try {
      parts = splitter()(String(text ?? "")).parts;
    } catch (err) {
      console.warn(`[dsh-qq] 切分失败，整条发送: ${String(err)}`);
      parts = [String(text ?? "")];
    }
    if (!parts.length) return;
    const source = src || lastSource;
    const isGroup = source?.type === "group";
    void (async () => {
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) await sleepMs(900 + Math.random() * 1300);
        // 【2026-11-14】先看这一条里有没有 [[file:路径]]：有就走上传，别当文字发出去。
        const parsed = parseFileMarkers(parts[i]);
        for (const f of parsed.files) {
          const sent = await sendFile(source, f.path, f.name);
          if (sent.ok) continue;
          diag(`回话里的文件没发出去 ${f.path}: ${sent.reason}`);
          const notice = buildSegments(`[文件没发出去：${f.name || f.path}，${sent.reason}]`);
          if (notice.length) {
            const p = isGroup
              ? { group_id: source.id, message: notice }
              : { user_id: source?.id || state.owner || cfg.owners[0], message: notice };
            await call(isGroup ? "send_group_msg" : "send_private_msg", p);
          }
        }
        const segs = buildSegments(parsed.text);
        if (!segs.length) continue;
        const params = isGroup
          ? { group_id: source.id, message: segs }
          : { user_id: source?.id || state.owner || cfg.owners[0], message: segs };
        const r = await call(isGroup ? "send_group_msg" : "send_private_msg", params);
        if (r?.status !== "ok") console.warn(`[dsh-qq] 发送失败: ${JSON.stringify(r).slice(0, 200)}`);
      }
    })();
  }

  // 给指定 QQ 号私发（不依赖 lastSource，用于好友申请通知 owner）
  function sendPrivateTo(userId, text) {
    const segs = buildSegments(text);
    if (!segs.length) return;
    void call("send_private_msg", { user_id: Number(userId), message: segs }).then((r) => {
      if (r?.status !== "ok") console.warn(`[dsh-qq] 私发失败: ${JSON.stringify(r).slice(0, 200)}`);
    });
  }

  ctx.on("session/event", (session, event) => {
    const sid = sessionIdOf(session);
    // 只回推「QQ 会话」：sessionSource 里登记过的会话才是 QQ 来的，桌面会话不回推。
    const src = sid ? sessionSource.get(sid) : undefined;
    if (!sid || !src) return;
    const type = event?.type;
    // 【诊断 2026-11-05】只打类型，不打内容：确认 assistant/message 到底有没有来。
    console.log(`[dsh-qq] 会话事件 ${type}`);
    if (type === "turn/start") {
      outBuffer.set(sid, []);
      return;
    }
    if (type === "assistant/message") {
      const t = textOf(event);
      if (t) {
        const buf = outBuffer.get(sid) ?? [];
        buf.push(t);
        outBuffer.set(sid, buf);
        // 只有「这轮是 QQ 发起的」才回推；每会话一个窗口。
        const windowUntil = qqTurnBySession.get(sid) || 0;
        if (!windowUntil || Date.now() > windowUntil) {
          console.log("[dsh-qq] 这轮不是 QQ 发起的，不回推");
          return;
        }
        qqTurnBySession.delete(sid); // 一条消息回一次，回完关窗
        sendToQq(t, src);
      }
      return;
    }
  });

  // 【诊断】引擎的 kick() 会用 catch 静默吃掉 turn 抛的错，agent/error 是唯一出口。
  ctx.on("agent/error", (payload) => {
    const raw = String(payload?.error?.message ?? payload?.error ?? payload ?? "");
    diag(`agent/error ${raw}\n${payload?.error?.stack ?? ""}`);
    console.error(`[dsh-qq] agent/error ${raw}`);
    // 上下文溢出兜底：明确提示主人自救，不静默失败。
    if (/context.?window|窗口|上下文.*(?:满|超|溢出)|CONTEXT|exceed|token.*(?:limit|上限)/i.test(raw)) {
      sendToQq("⚠ 上下文快满了 / 已溢出。回复 /compact 压缩历史，或 /new 开新话题继续。");
    }
  });

  // ── 上下文哨兵 / 自救命令 ────────────────────────────────
  function pressureOf(agent) {
    try {
      const meter = agent?.ctx?.get?.("tokenMeter") ?? ctx.get("tokenMeter");
      if (!meter || typeof meter.contextPressure !== "function") return undefined;
      const p = meter.contextPressure(agent.session);
      if (!p || !p.contextWindow) return undefined;
      return { pressureTokens: p.pressureTokens ?? 0, contextWindow: p.contextWindow };
    } catch (err) {
      console.error(`[dsh-qq] 读上下文压力失败: ${String(err)}`);
      return undefined;
    }
  }

  function compactionOf(agent) {
    try {
      return agent?.ctx?.get?.("compaction");
    } catch {
      return undefined;
    }
  }

  function describePressure(agent) {
    const p = pressureOf(agent);
    if (!p) return "（读不到上下文压力，可能 token-meter 未挂载）";
    const pct = Math.round((p.pressureTokens / p.contextWindow) * 1000) / 10;
    return `当前上下文 ${p.pressureTokens}/${p.contextWindow} tokens（约 ${pct}%），${pct >= 80 ? "偏满，建议 /compact 或 /new" : "健康"}`;
  }

  // 投递前哨兵：压力 ≥ 阈值就主动压一轮（防单条大消息把窗口顶爆）
  async function ensureHeadroom(agent, thresholdRatio = 0.7) {
    const compaction = compactionOf(agent);
    if (!compaction || typeof compaction.compactIfNeeded !== "function") return;
    const p = pressureOf(agent);
    if (!p) return;
    const ratio = p.pressureTokens / p.contextWindow;
    if (ratio < thresholdRatio) return;
    console.log(`[dsh-qq] 压力 ${Math.round(ratio * 100)}%，投递前主动压缩…`);
    try {
      const result = await compaction.compactIfNeeded(
        { session: agent.session, options: {} },
        "pressure",
        AbortSignal.timeout(90000),
      );
      if (result) console.log(`[dsh-qq] 压缩完成 shadowed=${result.shadowedSeqs?.length} tokens=${result.shadowedTokenCount}`);
    } catch (err) {
      console.error(`[dsh-qq] 主动压缩失败: ${String(err)}`);
    }
  }

  async function handleCtxCommand(agent) {
    sendToQq(`[上下文] ${describePressure(agent)}`);
  }

  async function handleCompactCommand(agent) {
    const compaction = compactionOf(agent);
    if (!compaction || typeof compaction.compactNow !== "function") {
      sendToQq("[压缩] 这个会话没有挂载压缩服务，无法手动压缩");
      return;
    }
    sendToQq("[压缩] 正在压缩较早的历史…");
    try {
      const result = await compaction.compactNow(
        { session: agent.session, options: {}, runMaintenance: (task) => agent.runMaintenance(task) },
        AbortSignal.timeout(120000),
      );
      if (result === null || result === undefined) {
        sendToQq("[压缩] 没有可压缩的历史（当前压力不高，或历史太短）");
      } else {
        sendToQq(`[压缩] 完成：压缩了 ${result.shadowedSeqs?.length ?? 0} 段历史，约释放 ${result.shadowedTokenCount ?? 0} tokens`);
      }
    } catch (err) {
      const code = err?.code ?? "";
      const msgMap = {
        busy: "压缩暂不可用：我正忙（有轮次在跑或已有压缩在进行），稍等再试",
        cancelled: "压缩被取消",
        changed: "历史在压缩前变了，本次没成功，可再试一次",
        summary: "没能生成有用的摘要，本次没压缩",
        commit: "压缩没干净收尾，会话可能部分变化，建议看一眼再继续",
        persistence: "压缩完成但没存上",
      };
      sendToQq(`[压缩] 失败${msgMap[code] ? `：${msgMap[code]}` : `（${String(err)}）`}`);
      console.error(`[dsh-qq] 手动压缩失败: ${String(err)}`);
    }
  }

  async function handleNewCommand(userId) {
    if (cfg.sessionId) {
      sendToQq("[新话题] 这个会话是配置里写死的（绑定了 sessionId），不能换新，请在配置里去掉绑定");
      return;
    }
    const agents = ctx.get("agents");
    if (!agents) {
      sendToQq("[新话题] 建会话服务不可用");
      return;
    }
    try {
      const sessionId = `session-${crypto.randomUUID()}`;
      const presetId = cfg.agentPreset || ctx.get("agentPresets")?.defaultId;
      const handle = await agents.create({
        sessionId,
        meta: { cwd: workdir(cfg), ...(presetId ? { agentPreset: presetId } : {}) },
        agentOptions: cfg.provider && cfg.model
          ? { provider: cfg.provider, model: cfg.model, ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}) }
          : undefined,
        setup: agentSetup,
      });
      const sid = handle?.agent?.id || sessionId;
      const key = String(userId ?? state.owner ?? "");
      state.sessions[key] = sid;
      saveState(stateFile, state);
      await attachToWorkspace(sid);
      sendToQq("[新话题] 已开新会话，之前的内容还在旧会话里（可在面板回溯）。现在接着聊。");
      console.log(`[dsh-qq] /new 为 ${key} 新建会话 ${sid}`);
    } catch (err) {
      console.error(`[dsh-qq] /new 建会话失败: ${String(err)}`);
      sendToQq("[新话题] 建新会话失败，稍后再试");
    }
  }

  // [重建] 好友申请：NapCat 的 request/friend 事件 → 记下来私发给 owner，owner 回 /yes 或 /no 放行。
  function handleFriendRequestEvent(m) {
    const qq = Number(m?.user_id);
    const flag = String(m?.flag ?? "");
    if (!qq || !flag) return;
    const comment = String(m?.comment ?? "").slice(0, 200);
    pendingFriendRequests.set(qq, { flag, comment, time: Date.now() });
    diag(`好友申请 qq=${qq} comment=${comment}`);
    const owner = cfg.owners?.[0];
    if (owner) {
      sendPrivateTo(owner, `好友申请：${qq}${comment ? `（${comment}）` : ""}\n回 /yes 或 /no，也可以 /yes ${qq} 指定`);
    }
  }

  function handleFriendApprove(verb, targetQq) {
    const isApprove = /^(y|yes|好|同意|通过|行)$/i.test(String(verb ?? "").trim());
    if (!isApprove && !/^(n|no|不|拒绝|别)$/i.test(String(verb ?? "").trim())) {
      sendPrivateTo(cfg.owners?.[0], "要么 /yes，要么 /no");
      return;
    }
    const qq = targetQq && pendingFriendRequests.has(targetQq) ? targetQq : [...pendingFriendRequests.keys()][0];
    const entry = pendingFriendRequests.get(qq);
    if (!entry) {
      sendPrivateTo(cfg.owners?.[0], "没有待处理的好友申请");
      return;
    }
    void call("set_friend_add_request", { flag: entry.flag, approve: isApprove }).then((r) => {
      if (r?.status === "ok") {
        pendingFriendRequests.delete(qq);
        sendPrivateTo(cfg.owners?.[0], `${isApprove ? "已通过" : "已拒绝"} ${qq}`);
      } else {
        sendPrivateTo(cfg.owners?.[0], `处理失败：${JSON.stringify(r).slice(0, 120)}`);
      }
    });
  }


  async function handleInbound(msg) {
    // 去重：NapCat 偶发对同一条消息重复上报，靠 message_id 兜底，避免连回两次
    const mid = msg?.message_id;
    if (mid && recentMsgIds.has(mid)) {
      console.log(`[dsh-qq] 重复消息跳过 message_id=${mid}`);
      return;
    }
    if (mid) {
      recentMsgIds.set(mid, Date.now());
      if (recentMsgIds.size > 300) recentMsgIds.delete(recentMsgIds.keys().next().value);
    }
    const from = Number(msg.user_id);
    const isGroup = msg.message_type === "group";
    const selfId = Number(msg.self_id || cfg.selfId || 0);
    const isOwner = cfg.owners.includes(from);
    if (isGroup) {
      const isAtSelf = (msg.message || []).some(
        (seg) => seg.type === "at" && Number(seg.data?.qq) === selfId,
      );
      if (!isOwner && !isAtSelf) {
        console.log(`[dsh-qq] 群消息忽略：陌生人 ${from} 未 @ 我`);
        return;
      }
      lastSource = { type: "group", id: Number(msg.group_id) };
    } else {
      if (!isOwner) {
        console.log(`[dsh-qq] 忽略非白名单私聊 ${from}`);
        return;
      }
      lastSource = { type: "private", id: from };
    }
    state.owner = from;
    saveState(stateFile, state);

    // 会话归属：私聊按人，群按群（一个群一间独立上下文）
    const sessionKey = isGroup ? `group-${Number(msg.group_id)}` : String(from);

    const blocks = [];
    const unknownSegs = []; // 没见过的段类型，攒起来写进诊断文件
    // 记下发送者，投递时标注（让 bot 知道谁发的），但不混进 textOnly（避免干扰命令判断）
    let senderNote = "";
    {
      const senderId = Number(msg.sender?.user_id || msg.user_id);
      const scope = isGroup ? "群消息" : "私聊";
      const isBoss = senderId === cfg.owners[0];
      const who = msg.sender?.card || msg.sender?.nickname || (isBoss ? "本人" : "");
      senderNote = who ? `[${scope} · ${who}（${senderId}）]` : `[${scope} · QQ ${senderId}]`;
    }
    for (const item of msg.message ?? []) {
      if (item.type === "text") {
        const t = item.data?.text;
        if (t) blocks.push({ type: "text", text: t });
      } else if (item.type === "record") {
        const fileName = item.data?.file;
        const r = fileName ? transcribeVoice(fileName) : { ok: false, reason: "没有 file 字段" };
        if (r.ok) {
          blocks.push({ type: "text", text: `[语音] ${r.words}` });
          if (r.tone) blocks.push({ type: "text", text: r.tone });
        } else {
          blocks.push({ type: "text", text: `[收到语音，转写失败：${r.reason}]` });
        }
      } else if (item.type === "image") {
        // 【2026-11-05】抄 dsh-qq-onebot：图片先下到本机，把路径当文字交给 agent，
        // agent 再用 read_image 打开——不占消息体积，也不依赖引擎支持图片块。
        const url = item.data?.url || item.data?.file || "";
        const file = url ? await downloadImage(url) : "";
        if (file) blocks.push({ type: "text", text: `[用户发了图片，已存到本机，可以直接用 read_image 打开：${file}]` });
        else blocks.push({ type: "text", text: "[收到图片，但没能下载下来]" });
      } else if (item.type === "face") {
        blocks.push({ type: "text", text: `[QQ表情 id=${item.data?.id ?? "?"}]` });
      } else if (item.type === "mface") {
        // 表情包：把「身份证」记下来，以后想发同一张就能发（出站用 [[mface:…]]）
        const d = item.data ?? {};
        blocks.push({
          type: "text",
          text: `[表情包 ${d.summary ? `「${d.summary}」` : ""}emoji_id=${d.emoji_id ?? "?"} package_id=${d.emoji_package_id ?? "?"}]`,
        });
      } else if (item.type === "file") {
        // 【2026-11-14】文件消息落地：get_file 下到本机，再拷进收件目录，把路径交给 agent。
        // 以前只写一句「[收到文件…]」，agent 打不开、也转不出去。
        blocks.push({ type: "text", text: await receiveFile(item.data ?? {}) });
      } else if (item.type === "video") {
        blocks.push({ type: "text", text: "[收到视频]" });
      } else if (item.type === "json" || item.type === "xml") {
        blocks.push({ type: "text", text: "[收到卡片消息（链接/小程序/红包之类）]" });
      } else if (item.type === "forward" || item.type === "node") {
        blocks.push({ type: "text", text: "[收到合并转发的聊天记录]" });
      } else if (item.type === "at" || item.type === "reply") {
        // 纯 @ / 引用本身不携带内容，跳过（@ 的判断在前面已经做过）
      } else {
        unknownSegs.push(item.type);
      }
    }
    // 【2026-11-12 修】没有可读内容的消息不再投给 agent。
    // 旧逻辑会塞一条「[空消息]」，agent 只能回「发过来是空的，没内容」——纯噪声，还打断上下文。
    // 现在：原始事件写进 raw-events.jsonl 留底，然后静默丢掉。
    if (!blocks.length) {
      dumpRaw("empty", msg, { unknownSegs });
      console.log(
        `[dsh-qq] 丢弃无内容消息 from=${from} message_id=${msg.message_id ?? "-"} ` +
          `段=${(msg.message ?? []).map((s) => s.type).join(",") || "空"}`,
      );
      return;
    }
    if (unknownSegs.length) dumpRaw("unknown-segments", msg, { unknownSegs });

    // 【自救命令】QQ 侧没有 UI 命令栏，这里拦截三条裸命令；/new 不依赖现有会话，最先处理
    const textOnly = blocks.map((b) => (b?.text ?? "")).join(" ").trim();
    if (/^\/new(?:\s|$)/i.test(textOnly) || textOnly === "/new" || textOnly === "新话题" || textOnly === "重开") {
      return await handleNewCommand(sessionKey);
    }

    // 好友申请审批：owner 回复「通过 <QQ号>」/「拒绝 <QQ号>」→ 处理待定申请
    const approveCmd = textOnly.match(/^(通过|同意|拒绝)\s*(\d+)?/i);
    if (approveCmd && from === cfg.owners[0] && pendingFriendRequests.size > 0) {
      return handleFriendApprove(approveCmd[1], approveCmd[2] ? Number(approveCmd[2]) : undefined);
    }

    const agent = await ensureAgent(sessionKey);
    if (!agent) {
      diag(`投递失败: 没有可用的 agent（key=${sessionKey} from=${from}）`);
      console.error("[dsh-qq] 投递失败: 没有可用的 agent（会话没建成）");
      return;
    }
    diag(
      `准备投递 from=${from} key=${sessionKey} agent=${agent.id} status=${agent.status} ` +
        `phase=${agent.phase?.kind ?? "?"} pending=${agent?.inbox?.hasPending} ` +
        `phaseTurn=${agent?.phase?.turn ?? "?"} phaseStep=${agent?.phase?.step ?? "?"}`,
    );
    if (/^\/ctx(?:\s|$)/i.test(textOnly) || textOnly === "/ctx" || textOnly === "上下文") {
      return await handleCtxCommand(agent);
    }
    if (/^\/compact(?:\s|$)/i.test(textOnly) || textOnly === "/compact" || textOnly === "压缩") {
      return await handleCompactCommand(agent);
    }
    // 【哨兵】投递前先看压力，接近上限就主动压一轮，别等溢出。
    await ensureHeadroom(agent);
    // 【投递】三步都试过，最后落在这条：
    //   ① `agent.followup(message)` 方法不存在（当时用可选链，异常被吞，静默不投）
    //   ② `agents.followup(agent, …)` 服务上没有这个方法 —— 那是我看错了，
    //      dsh-wechat 里的 `this.agents` 是它自己的 AgentStore 实例，
    //      AgentStore.followup 内部才去调 `agent.followup(message)`。
    //   ③ 于是回到 agent 自己的方法。引擎里真正的定义在
    //      `引擎\node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js:806`
    //        followup(input) { this.send(input, "next-turn", true); }
    //        steer(input)    { this.send(input, "next-step", true); }
    //      ⇒ 传一个「用户消息」对象即可，不需要 id 回调。
    const deliverBlocks = senderNote ? [{ type: "text", text: senderNote }, ...blocks] : blocks;
    const userMsg = { id: crypto.randomUUID(), role: "user", content: deliverBlocks, source: { kind: "user" } };
    const mode = agent.status === "running" ? "steer" : "queue";
    try {
      if (typeof agent.followup !== "function") {
        console.error(
          `[dsh-qq] 投递失败: agent 上没有 followup。原型上的方法：` +
            `${Object.getOwnPropertyNames(Object.getPrototypeOf(agent) ?? {}).join(",")}`,
        );
        return;
      }
      if (mode === "steer" && typeof agent.steer === "function") agent.steer(userMsg);
      else agent.followup(userMsg);
      // 投进去了才算「这轮是 QQ 发起的」：登记会话来源 + 打开该会话的回推窗口。
      sessionSource.set(agent.id, isGroup ? { type: "group", id: Number(msg.group_id) } : { type: "private", id: from });
      qqTurnBySession.set(agent.id, Date.now() + QQ_TURN_WINDOW_MS);
      // 【诊断】投进去之后立刻看状态：如果 status 还是 idle 且 inbox 空，
      // 说明消息被吞了（引擎 kick() 里的 catch 会静默吃掉 turn 抛的错）。
      console.log(
        `[dsh-qq] 已投递（${mode}）${userMsg.id} status=${agent.status} ` +
          `pending=${agent?.inbox?.hasPending} 阶段=${agent?.phase?.kind ?? "?"}`,
      );
      diag(`已投递（${mode}）${userMsg.id} status=${agent.status} pending=${agent?.inbox?.hasPending} 阶段=${agent?.phase?.kind ?? "?"}`);
    } catch (err) {
      diag(`投递失败: ${String(err)}\n${err?.stack ?? ""}`);
      console.error(`[dsh-qq] 投递失败: ${String(err)}\n${err?.stack ?? ""}`);
    }
  }

  // ── 工具：qq_send_file（2026-11-14）─────────────────────────
  // 给「聊天模式」和别的会话一个正经入口：把本机文件发到 owner 那边。
  // 走 Host 的 tools 登记表，profile 级注册 → 所有预设都能看见（聊天模式那个预设也看得到）。
  function registerSendFileTool() {
    let tools;
    try {
      tools = ctx.get("tools");
    } catch {
      tools = undefined;
    }
    if (!tools || typeof tools.register !== "function") return false;
    try {
      const offTool = tools.register({
        name: "qq_send_file",
        description:
          "把本机的一个文件（docx/xlsx/pdf/md/zip/图片都行）通过 QQ 发出去。只发允许目录里的文件（默认工作区和收件目录），单文件 50MB 上限。不填 to 就发到当前这轮 QQ 会话的来源；没有对应会话时直接报错，不猜。",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "本机文件路径，绝对路径最好（也认 D:/… 和 file:///D:/… 写法）。",
            },
            name: { type: "string", description: "QQ 里显示的文件名；不填就用原文件名。" },
            to: {
              type: "object",
              description: "可选：指定发给谁。不填就发给当前会话对应的 QQ。",
              properties: {
                type: { type: "string", enum: ["private", "group"], description: "private=私聊，group=群" },
                id: { type: "integer", description: "QQ 号或群号" },
              },
              required: ["type", "id"],
            },
          },
          required: ["path"],
        },
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: String(value ?? "") }],
        },
        execute: async (args, exec) => {
          const input = args && typeof args === "object" ? args : {};
          let source;
          if (input.to && input.to.id) {
            source = { type: input.to.type === "group" ? "group" : "private", id: Number(input.to.id) };
          } else {
            const sid = sessionIdOf(exec?.agent);
            source = (sid ? sessionSource.get(sid) : undefined) || lastSource || null;
          }
          const r = await sendFile(source, input.path, input.name);
          if (!r.ok) return `没发出去：${r.reason}`;
          const where = r.target.type === "group" ? `群 ${r.target.id}` : `私聊 ${r.target.id}`;
          return `已发给${where}：「${r.name}」（${(r.bytes / 1024).toFixed(0)}KB${
            r.file_id ? `，file_id=${r.file_id}` : ""
          }）`;
        },
      });
      ctx.on("dispose", () => {
        try {
          offTool();
        } catch {}
      });
      diag("qq_send_file 工具已注册");
      console.log("[dsh-qq] qq_send_file 工具已注册");
      return true;
    } catch (err) {
      diag(`qq_send_file 注册失败: ${String(err)}`);
      console.error(`[dsh-qq] qq_send_file 注册失败: ${String(err)}`);
      return false;
    }
  }
  // 服务还没就绪就过一会儿再试（最多 30 秒）。不因为加载顺序丢掉这个工具。
  if (!registerSendFileTool()) {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (registerSendFileTool()) {
        clearInterval(timer);
        return;
      }
      if (attempts >= 15) {
        clearInterval(timer);
        diag("等了 30 秒还没有 tools 服务，qq_send_file 未注册");
        console.error("[dsh-qq] 没有 tools 服务，qq_send_file 未注册");
      }
    }, 2000);
    timer.unref?.();
  }

  // ── NapCat 连接 ───────────────────────────────────────────
  function connect() {
    if (closed) return;
    try {
      ws = new WebSocket(cfg.wsUrl, { headers: { Authorization: `Bearer ${cfg.token}` } });
    } catch (err) {
      console.error(`[dsh-qq] 建 WS 失败: ${String(err)}`);
      return void setTimeout(connect, 5000).unref?.();
    }
    ws.onopen = () => {
      connected = true;
      diag(`已连上 NapCat ${cfg.wsUrl}`);
      console.log(`[dsh-qq] 已连上 NapCat ${cfg.wsUrl}`);
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.echo && pending.has(String(m.echo))) {
        const resolve = pending.get(String(m.echo));
        pending.delete(String(m.echo));
        resolve(m);
        return;
      }
      // 诊断用：每条非回包事件打一行（2026-11-05 排查「消息到了 NapCat 但插件没动静」）
      // 2026-11-05 晚：群消息不再逐条打——群里一直在刷，日志涨得比对话快。只认私聊。
      if (m.post_type && m.post_type !== "meta_event" && m.message_type !== "group") {
        console.log(`[dsh-qq] 事件 ${m.post_type}/${m.message_type ?? "-"} from=${m.user_id ?? "-"} 段=${(m.message ?? []).map((s) => s.type).join(",")}`);
        diag(`收到事件 ${m.post_type}/${m.message_type ?? "-"} from=${m.user_id ?? "-"} id=${m.message_id ?? "-"}`);
      }
      if (m.post_type === "message" && m.message_type === "private") {
        void handleInbound(m).catch((err) => console.error(`[dsh-qq] 处理私聊出错: ${String(err)}`));
      } else if (m.post_type === "message" && m.message_type === "group" && cfg.groupMessages) {
        void handleInbound(m).catch((err) => console.error(`[dsh-qq] 处理群消息出错: ${String(err)}`));
      } else if (m.post_type === "request" && m.request_type === "friend") {
        handleFriendRequestEvent(m);
      }
    };
    ws.onclose = () => {
      connected = false;
      if (!closed) setTimeout(connect, 5000).unref?.();
    };
    ws.onerror = () => {
      // onclose 会跟着来
    };
  }

  connect();

  ctx.on("dispose", () => {
    registry.delete(selfClose);
    selfClose();
  });

  console.log(`[dsh-qq] 已加载：${cfg.wsUrl}，白名单 ${cfg.owners.join(",")}，会话 ${cfg.sessionId ? `${cfg.sessionId}（已绑定）` : "按用户各开一间"}`);
}

function sessionIdOf(session) {
  if (!session || typeof session !== "object") return undefined;
  const s = session;
  for (const c of [s.id, s.header?.id, s.session?.header?.id, s.session?.id]) {
    if (typeof c === "string" && c) return c;
  }
  return undefined;
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v;
  return out;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
}
