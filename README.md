# dsh-qq ｜ QQ 通道

把 QQ 接进 DeepSeek Harness：私聊和群聊的每条消息都变成一个持久的 agent 会话，回复按拟人节奏分条发出，还能收发文件和表情。

## 做什么

- 走 NapCat 的 OneBot11 正向 WebSocket，收私聊 / 群消息
- 每个 QQ 号一个持久会话，状态落在 `<DSH_HOME>/qq/state.json`，重启不丢
- 拟人分条：回复里的换行就是两条消息，条与条之间停 0.9~2.2 秒
- 收发图片、QQ 内置表情、商城表情、文件；出站带目录白名单和单文件大小上限
- 可选：语音消息交给本地转写脚本，转写结果里可以带一句语气描述
- 单条消息可以覆盖模型 / 推理档 / 预设，不动全局默认
- 注册 `qq_send_file` 工具，让会话里的 agent 主动往 QQ 发文件

## 不做什么

- 不代登录 QQ，不碰协议签名，全靠 NapCat
- 不是通用 OneBot 实现：只对接正向 WebSocket 服务端
- 不接陌生人：`owners` 为空时谁都不接

## 要求

| 项 | 要求 |
| --- | --- |
| DSH | 0.2.2-rc.1（cordis 4.x 插件形态） |
| Node | >= 22.12 |
| QQ 端 | NapCat 或兼容 OneBot11 的实现，开启 WebSocket 服务器 |
| 账号 | 建议单独一个号，别用主号 |
| 可选 | 本地转写脚本；DSH 的 token-meter（用于上下文压力提示） |

## 安装

1. 把仓库放到本机任意目录
2. 在 profile 的 `package.json` 里加依赖，并把包名加进 `dsh.profile.bundles`：

```json
"dependencies": { "dsh-qq": "link:D:/plugins/dsh-qq" }
```

3. 重启 DSH
4. 在 profile 的 `cordis.patch.yml` 里给 `dsh-qq` 行写真实配置（见下）

## 配置

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `wsUrl` | `ws://127.0.0.1:3001` | NapCat 的 OneBot11 WS 地址 |
| `token` | `""` | 和 NapCat 那边填的一致；没设就留空 |
| `owners` | `[]` | 只接这些 QQ 号；空数组 = 谁都不接 |
| `selfId` | `0` | 机器人自己的号；事件里带 `self_id` 时优先用事件的 |
| `cwd` | `""` | 会话工作目录；空则用 `DSH_WORKSPACE`，再没有用进程 cwd |
| `stateDir` | `<DSH_HOME>/qq` | 会话状态目录 |
| `tmpDir` | 系统临时目录 | 收图 / 收语音的落地目录 |
| `earScript` | `""` | 本地转写脚本；约定 `node <脚本> <wav>`，stdout 首行是文本 |
| `maxChars` | `1800` | 单条回复最多多少字，超了切段 |
| `maxFileMB` | `50` | 出站文件大小上限 |
| `receiveDir` | `<cwd>/收件` | 收到的文件落哪 |
| `fileRoots` | `[]` | 出站文件白名单；空 = 工作区 + 收件目录 |
| `provider` / `model` | `""` | 单独指定模型；空则跟随默认 |
| `reasoningEffort` | `""` | `off` / `low` / `high` / `max` |
| `sessionId` | `""` | 固定接到某间会话；空则按 QQ 号新建 |
| `agentPreset` | `""` | 新会话用哪个预设 |
| `groupMessages` | `false` | 群消息是否投递（false 只记日志） |
| `followLines` | `true` | 按换行分气泡 |

## 用法

- 收到消息就触发一轮回复，`/new`（也认「新话题」「重开」）新建会话，`/compact`（也认「压缩」）压缩历史
- `qq_send_file(path, name?, to?)`：把白名单目录里的文件发出去
- 上下文快满时会主动提示，卡片和文件回读失败会写进日志

## 已知限制

- OneBot11 的事件字段在不同实现之间有差异，这份按 NapCat 校准
- 群聊只在被 @ 或发言人命中 `owners` 时响应
- 语音转写依赖外部脚本，没配就只记一行占位
- 单实例：`apply` 被重复调用时会先关掉旧连接，避免重复回复


## 风险

- 走的是非官方接口，可能违反 QQ 用户协议，存在账号被限制或封禁的风险；建议用小号，风险自担
- 登录态在 NapCat 那边，NapCat 挂了就等于 QQ 断线
- 回的话、发的文件都是真发出去的；目录白名单只挡边界，不防手滑
- 消息内容会进模型请求，聊天记录等于出了本机
- `owners` 没配好，会被陌生人当成免费助手
- 好友放行口令（`/yes` / `/no`）谁拿到号谁就能发，别外传

---

作者：温凌微（Vera），网名暗海拾星。个人自用后整理开源，不是官方项目。
