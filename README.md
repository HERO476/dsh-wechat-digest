# dsh-wechat-digest

一个**只读**的微信聊天摘要插件。

- 群聊默认开、可关；私聊默认关、可开
- **永久不具备发送能力**（代码里不存在发送路径，不是靠开关关掉）
- 定时与手动两个触发入口汇入同一道闸门；触发只决定「何时跑」，不携带任何范围
- 三种数据源：`fixture`（假数据）/ `file`（你手动导出）/ `wechat`（真实解密，未开放）

完整约束、数据流、拦截分层与验收清单见 [SPEC.md](./SPEC.md)。

## 三种数据源

| 源 | 状态 | 说明 |
|---|---|---|
| `fixture` | 可用 | 内置假数据，含群 + 私聊 + 公众号，用于验证链路 |
| `file` | **可用** | 读你手动导出的聊天记录。零权限、零 ToS 风险、零误发可能。格式见 [EXPORT-FORMAT.md](./docs/EXPORT-FORMAT.md) |
| `wechat` | 不可用 | 微信 4.x 库为 SQLCipher 加密，密钥只在 `Weixin.exe` 内存里；当前进程是 **Low 完整性级别**，读不了 Medium IL 进程内存。见 [PHASE2.md](./docs/PHASE2.md) |

> 换数据源**不改动任何保护逻辑**：策略、闸门、单漏斗、水位线、存储二次拒绝、双哨兵对三种源一视同仁。

## 目录

```
SPEC.md                       规格（约束 / 策略模型 / 接口铁律 / 验收）
docs/EXPORT-FORMAT.md         手动导出格式（推荐先走这条）
docs/PHASE2.md                真实取数的前置条件与代价
src/core/canonical.js         会话 id 归一化与分类（全系统唯一解析点）
src/core/policy.js            策略解析（字段白名单 / 损坏即全关 / 单会话覆盖）
src/core/gate.js              可见性闸门（唯一裁决点，纯函数）
src/core/funnel.js            单漏斗（两触发入口 + 水位线 + 互斥）
src/core/store.js             摘要存储（二次拒绝 + 强制 provenance）
src/core/lock.js              运行互斥
src/core/watermark.js         增量水位线
src/core/toolSurface.js       工具面（零写工具 / 零原始 id 入参）
src/adapters/fixture.js       假数据源
src/adapters/file.js          手动导出文件源
src/adapters/wechat.js        微信源（只读体检 + 显式 fail-closed，不含解密）
src/summarize.js              本地关键词摘要（不联网、不调模型）
src/service.js                装配层
src/tools.js                  工具处理器
src/mcp-server.js             MCP stdio 服务器（给 DSH 调用）
scripts/run-tests.mjs         测试入口
scripts/check-core-purity.mjs core 纯净性与零写能力静态检查
scripts/demo.mjs              fixture 端到端演示
scripts/file-demo.mjs         file 端到端演示
scripts/preflight.mjs         微信环境只读体检（不解密）
samples/export-template/      导出格式模板（一个群 + 一个私聊）
```

## 运行

```bash
npm run check          # core 纯净性 + 零写能力静态检查
npm run test           # 全部用例（当前 213 个）
npm run verify         # 两个都跑

node scripts/demo.mjs                                       # fixture 演示（本地关键词）
node scripts/file-demo.mjs samples/export-template          # file 演示（本地关键词）
node scripts/llm-smoke.mjs                                  # 模型链路连通性（会消耗少量额度）
node scripts/preflight.mjs <dataRoot> [wxid_xxx]            # 微信只读体检
node scripts/inspect-db.mjs <解密后的.db>                    # 解密库结构探查
node scripts/convert-decrypted-db.mjs <db> <输出目录> --dry-run  # 转为导出格式（先 dry-run）
node src/mcp-server.js                                      # MCP stdio 服务器
```

> 不用 `node --test test/`：该写法会为每个测试文件 spawn 子进程，在 DSH 沙箱里以
> `spawn EPERM` 失败（不是测试本身的问题）。`scripts/run-tests.mjs` 改为本进程内顺序 import，
> 由 `node:test` 在退出时汇总。

在 Node 24.20.0 上实测：212 passed / 0 failed / 1 skipped
（跳过的是 POSIX 专有的密钥文件权限位用例，Windows 上不适用）。

## 设置页

两个入口，读同一份配置（`~/.dsh/wechat-digest/config.json`）：

1. **DSH 设置界面 → 微信摘要**（原生分区，需重启 DSH 后出现）
2. 独立本地页：`npm run settings` → http://127.0.0.1:7199

可配置：

- **群聊总开关**（关掉 = 一个群都不读，优先于单群勾选）
- **要总结哪些群**（列表来自 `exports/`，逐个勾选）
- **自定义名字**：每个群 / 私聊后面有一个名字框，填了就按这个名字显示
  （列表和摘要结果都用它），留空则回落到 `room.json` 里的 `name`
- **私聊总开关**（默认关）+ **私聊白名单**（开总开关后再逐个勾选，没勾的一律不读）
- **提供方 / 模型**（两级下拉，见下）
- **定时时间与星期**
- **立即总结按钮**：按已保存的设置立刻跑一次，结果显示在面板里
  （与定时任务共用同一套策略、闸门与落盘文件）

三条行为必须知道：

- **群聊与开关改完立即生效**：MCP 每次调用都重新读配置，不需要重启。
- **总开关优先**：群聊或私聊的总开关一关，对应的单会话勾选立即失效——
  不会因为某条遗留勾选而漏读。
- **配置写坏 → 全关**（fail-closed），不会回退成"默认允许"。
- **定时真的会跑**：`config.schedule` 由插件自己消费（`lib/scheduler.mjs`，每 30 秒对一次表，
  同一分钟只跑一次，记账文件 `~/.dsh/wechat-digest/schedule-state.json`）。
  跑的时候走的是与「立即总结」完全相同的 `postRun` → 同一道策略闸门。
- **撤销立即生效**：取消勾选某个群之后，它的历史摘要也读不出来了
  （`get_summary` 会用当前策略复核，返回 `DENIED`）。

设置接口的访问控制：

- 只接受 **Host 为回环地址**（`127.0.0.1` / `localhost` / `[::1]`）的请求，
  挡 DNS rebinding；要用公网隧道必须先显式写进 `WECHAT_DIGEST_ALLOWED_HOSTS`。
- **写操作（POST）必须带同源 `Origin`**：浏览器一定带，`curl` 不带 → 403。
  所以「一条 curl 就能改配置」这条路已经关了。
- 读操作（GET）不要求 Origin，但同样受 Host 白名单约束。
- 独立设置页与 DSH 面板用同一套规则（`127.0.0.1:7199` 上也做同样的 Host/Origin 校验）。

### 支持的模型（多 provider）

设置页的「提供方 / 模型」两级下拉，覆盖 DSH 里出现的**全部** provider（见 `src/models.js`）：

| provider | baseURL | 密钥变量 | 模型数 | 插件可直调 |
|---|---|---|---|---|
| `deepseek-official` | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | 2 | ✅ 实测通过 |
| `commandcode`（Command Code GOAT） | `https://api.commandcode.ai/provider/v1` | `COMMAND_CODE_API_KEY` | 1 | ✅ 实测通过 |
| `opencode-go` | `https://opencode.ai/inference/go/openai/v1` | `OPENCODE_API_KEY` | 13 | ✅ 链路通（实测遇 429 限流，非配置问题） |
| `deepseek-account`（账号登录态） | — | — | 2 | ❌ OAuth 无 API Key，插件无法直接调用 |

密钥按 provider 的 `apiKeyEnv` 取名，优先环境变量，其次 `~/.dsh/.credentials.yaml` 的同名键。

**加模型不用改代码**：在 `~/.dsh/wechat-digest/models.json` 写一份覆盖表即可
（按 provider id 合并，`models` 数组整体替换），例如接本地 Ollama：

```json
{ "providers": [{ "id": "my-local", "label": "本地 Ollama",
  "baseUrl": "http://127.0.0.1:11434/v1", "apiKeyEnv": "OLLAMA_API_KEY",
  "callable": true, "models": [{ "id": "qwen3", "label": "Qwen3" }] }] }
```

`models.json` 是**白名单构造**，不是整体展开：

- `baseUrl` 只允许 `https:`；`http:` 仅放行 `127.0.0.1` / `localhost` / `::1`（本地模型）；
- `apiKeyEnv` 必须是合法环境变量名；
- `headers` 只保留已知头（`authorization` / `content-type` / `x-api-key` …），未知头与换行注入丢弃；
- 其余字段（`injectCommand` 之类）一律忽略，不进入注册表。

这样一份「能写 models.json」就不再等于「能把聊天内容 + DSH 凭证发到任意地址」。

查看当前可用性：`node scripts/llm-smoke.mjs --list`

### 作为 DSH bundle 安装

包声明了 `dsh.bundle.patch`（`cordis.patch.yml`，挂宿主行）与 `dsh.client`（`lib/client.js`，注册
`settings.section`）。接入步骤：

1. `node_modules/dsh-wechat-digest` → 本目录（junction）
2. profile `package.json` 的 `dsh.profile.bundles` 加入 `dsh-wechat-digest`
3. 重启 DSH

宿主半的路由契约有测试覆盖（`test/pluginHost.test.js`：假 ctx 捕获路由，直接验证 state/config/reset），
不需要重启就能发现"面板读不到数据"这类问题。

### 写客户端半 / 宿主半时踩过的三个坑（必看）

这三条都是实测踩出来的，重写时会一样中招：

1. **`webServer` 不能写进 `inject`。** 宿主行挂载早于 webServer 发布，`apply` 时一次性
   `ctx.get('webServer')` 会拿到 `undefined` 并永久放弃。必须用非阻塞的
   `ctx.inject(['webServer'], scope => …)`。
2. **客户端半必须 `exports.inject = ['slots']`。** 否则 `apply` 跑在槽位服务发布之前，
   设置页**静默不注册**——不报错，就是没有。
3. **不要靠 `req.url` 分派。** harness 如何向 handler 呈现 `req.url`（完整路径还是去前缀
   后的剩余部分）不在契约里。本插件的做法：只注册一个挂载点 `/wechat-digest`，
   分派只依赖 **HTTP method + `x-wechat-digest-op` 请求头**，URL 仅作兜底线索。

另外：路由前缀要带前导斜杠（`/wechat-digest`，与同机可用插件一致），
写成 `wechat-digest` 会 404。

### 兼容性说明

- `dsh.engines.dsh` = `>=0.2.0 <0.3.0`（只声明实测过的区间，不再用一长串互相吞并的区间）。
- **没有声明 `peerDependencies`**：宿主包名在不同版本间不稳定，猜错名字会让整个 bundle 被跳过
  （`skipping profile bundle`），比没有门控更糟。宁可留这条已知缺口，并在启动时打印能力自检。
- API 使用面是可用插件的**子集**（`ctx.slots` / `slots.inject` / `slots.register` /
  `ctx.inject` / `scope.effect` / `webServer.register`）。
- `dsh.client.inject` 里的两个 UI 包由 shell 运行时提供，**不在 node_modules 属正常**。
- **仍然没有运行时版本门控**：DSH 升级若改动 `settings.section` 契约，只会表现成面板 404 或分区消失。
  启动日志会打印路由注册结果，便于第一时间发现。

## 从聊天截图导入（不碰微信数据库）

微信 4.x 的库是 SQLCipher 加密的，第三方解密工具已被官方要求下架；
直接读进程内存会拖累账号安全。因此本插件**不直连微信**，但提供一条干净通道：

**你截图（在官方客户端里正常看），它只做识别与入库。**

```bash
node scripts/import-screenshot.mjs 截图.png --room 产品评审群
# 或
npm run import:ocr -- 截图.png --room 产品评审群 --append
```

| 参数 | 说明 |
|---|---|
| `--room` | 会话名（写进 room.json，可中文） |
| `--slug` | 目录名（字母数字下划线；不给则按名字生成稳定短哈希） |
| `--kind` | `group`（默认）/ `private` |
| `--append` | 追加到已有 `messages.txt`（默认覆盖） |
| `--out` | 导出根目录（默认 `<仓库>/exports`） |

它做的事：调 Windows 内置 OCR（`zh-Hans`）→ 去中文字间空格 / 归一冒号 → 按坐标分左右（右侧算"我"发的）→ 拼成 `[时间] 发送者: 内容` → 写进 `exports/<slug>/`。跑完刷新设置页就能看到这个会话。

**已知精度限制**（都是 OCR 的固有代价，不是实现漏洞）：

- 小号灰字（发送者名）容易漏认 → 会落到"未知发送者"；
- 日期可能读残（`2026年11月10日` → `2026年1110日`）；
- 只读**当前屏幕已渲染**的内容，需要你手动滚动后再截一次（`--append` 去重追加）；
- 表情/图片/引用消息只留占位文字。

它**不读进程内存、不碰微信数据库、不联网、不模拟输入**，所以对账号没有新增风险。

摘要会写入 `~/.dsh/wechat-digest/digests.jsonl`（可用 `WECHAT_DIGEST_DATA_DIR` 改），
**只存白名单字段**：`roomHandle` / `digest` / `provenance` / `trigger` / `createdAt`。

聊天原文与原始会话 id **不会落盘**——不是"过滤掉了"，是写入代码里没有这两条路（有测试断言）。
损坏行启动时跳过并计数，不会让服务起不来。

> **注意**：存储每次读都会先对齐磁盘（比较 mtime + size，变了就重读）。
> 因此设置页（宿主进程）写进去的摘要，MCP 子进程**立刻**就能读到；
> 手工编辑这个文件也会被下一次读取看到，不需要重启。

> 注意：MCP 子进程是**一次启动、长期运行**的。改了 `src/` 下的代码后，
> 正在跑的那个子进程不会重新加载——需要重启 DSH 才会用上新代码
> （工具注册本身会热加载，但已启动进程的代码不会）。

## 作为 MCP 服务器接进 DSH

本机已验证可行的插件形态是 **MCP stdio 子进程**（既有 QQ 桥接即如此），不需要 client 半。

环境变量：

| 变量 | 说明 |
|---|---|
| `WECHAT_DIGEST_SOURCE` | `fixture`（默认）/ `file` / `wechat` |
| `WECHAT_DIGEST_SECRET` | 句柄 HMAC 密钥，≥16 字符。**不给就自动用 `<dataDir>/secret`**（首次生成 32 字节随机值，两半共用） |
| `WECHAT_DIGEST_EXPORT_DIR` | `file` 模式的导出根目录 |
| `WECHAT_DIGEST_DATA_DIR` | 摘要落盘目录（默认 `~/.dsh/wechat-digest`） |
| `WECHAT_DIGEST_DATA_ROOT` | `wechat` 模式的数据根 |
| `WECHAT_DIGEST_ACCOUNT` | `wechat` 模式绑定的 `wxid_*`（多账号时必须显式指定） |
| `WECHAT_DIGEST_ALLOWED_HOSTS` | 逗号分隔的额外允许 Host（默认只有回环；要用隧道就写隧道域名） |
| `WECHAT_DIGEST_SCHEDULER` | `off` 可关掉宿主半的定时器（测试/排障用） |

暴露的工具：`list_rooms` / `run_summary` / `get_summary`——**没有任何发送类工具**。

工具语义与 `annotations` 一致（宿主据此判断副作用）：

| 工具 | `readOnlyHint` | 实际行为 |
|---|---|---|
| `list_rooms` | `true` | 只读导出目录 |
| `get_summary` | `true` | 只读本地摘要文件，并按当前策略复核 |
| `run_summary` | **`false`** | **读消息 → 调用模型（出网 + 计费）→ 写摘要文件** |

`run_summary` 的描述里不再出现「只读」；`test/toolSurface.test.js` 会断言文案与注解一致，
写反了直接测试失败。

> **安装状态：已写入 profile 并生效。**
> 条目 `mcp-wechat-digest` 已追加进 `C:\Users\<你的用户名>\.dsh\profiles\desktop\cordis.patch.yml`
> （追加前已备份为 `.bak.<时间戳>`），并通过 PyYAML 解析校验。
> 工具列表里应出现上面三个工具。撤回方式见 [INSTALL.md](./docs/INSTALL.md)（含 MCP 行与数据目录两处）。
>
> 摘要器默认已切到 `llm`（`deepseek-chat`），模型密钥**运行时从 `~/.dsh/.credentials.yaml`
> 的 `DEEPSEEK_API_KEY` 读取，不落仓库、不进日志**。想退回本地关键词规则：
> 把 `src/run-mcp.mjs` 里的默认值改成 `'heuristic'`。

## 一句话记住的铁律

**原始 chat id 的生命周期止于闸门。** 下游只见 HMAC 句柄，因此「读某个私聊」在接口形状上不可表达；
而「发一条消息」在代码里根本没有对应函数。
