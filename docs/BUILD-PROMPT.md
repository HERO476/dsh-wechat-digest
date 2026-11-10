# 复刻提示词：微信聊天摘要 DSH 插件

> 把下面整段内容作为提示词交给任意一个具备文件读写与命令执行能力的 AI 编码助手，
> 它应当能产出一个与本项目**功能等价、约束等价、踩坑点已规避**的插件。
>
> 不是要求逐字符相同，而是要求：同一套硬约束、同一套架构分层、同一批已证实的坑全部绕过。

---

## 任务

在 DSH（DeepSeek Harness）生态里从零实现一个**只读的微信聊天摘要插件**，包含三个用户可见部分：

1. **DSH 设置界面里的「微信摘要」分区**（原生设置项，不是外挂网页）
2. **三个 MCP 只读工具**：`list_rooms` / `run_summary` / `get_summary`
3. **一个独立的本地设置页**（兜底路径，DSH 面板出问题时仍可配置）

产出物必须可 `npm publish` 成公开包，并能在本机通过 junction 挂进 DSH profile 后正常加载。

---

## 一、硬约束（不可协商，任何设计取舍都不得违反）

| # | 约束 | 含义 |
|---|---|---|
| C1 | 摘要微信聊天内容，抽出**重点活动 / 任务待办 / @提及** | 核心价值 |
| C2 | **群聊默认开**，且有一个**总开关**可以一键关闭全部群读取 | 单群还需能逐个勾选/取消 |
| C3 | **私聊默认关**，且为**白名单语义**：开总开关后，仍只读被逐个勾选的私聊；一个都没勾 = 一个都不读 | 不能是"开总开关=读全部私聊" |
| C4 | **永久零发送能力** | 不是"配置里关掉"，而是**代码里不存在发送路径**：工具面没有发送类工具，核心层静态扫描不得出现发送/注入类符号 |
| C5 | 支持定时自动总结 | 由宿主定时任务驱动，不依赖插件内计时器 |
| C6 | 支持用户手动触发「立即总结」 | 必须在设置面板里有一个按钮 |
| C7 | **私聊正文零解析 / 零落盘 / 零进模型上下文** | 群聊与私聊同库同表，因此约束表述必须是"零可用性/零落盘/零上下文"，不能写成"零读取" |

**总开关优先级**：任何总开关关闭时，对应的单会话勾选**立即失效**。实现方式是在"配置 → 策略"的转换处直接清空 overrides 并把 defaultEnabled 置 false，而不是指望 gate 再判断一次。并有测试断言这条。

---

## 二、架构分层（必须遵守，否则约束守不住）

```
src/core/            纯函数层，无 I/O、无框架依赖、无 node 内置模块（唯一例外：gate.js 可用 node:crypto）
  canonical.js       会话 id 归一化与分类：全系统唯一解析点
  policy.js          策略解析：字段白名单、损坏即全关、单会话覆盖
  gate.js            可见性闸门：唯一裁决点，纯函数，输出不透明句柄
  funnel.js          单漏斗：两个触发入口 + 水位线 + 互斥
  store.js           内存存储：二次拒绝 + 强制 provenance
  lock.js / watermark.js
  toolSurface.js     工具面：零写工具、零原始 id 入参

src/adapters/        数据源（可以碰 fs / 网络）
  fixture.js         假数据，含群 + 私聊 + 公众号，各埋哨兵
  file.js            读手动导出的聊天记录（推荐路径）
  wechat.js          真实库适配器骨架：只读体检 + 显式 fail-closed，不含解密

src/config.js        配置 schema（用户可见的全部开关）
src/models.js        模型注册表（多 provider）
src/llm-config.mjs   模型凭据解析（env → ~/.dsh/.credentials.yaml）
src/summarize.js     本地关键词摘要（零网络）
src/summarize-llm.js OpenAI 兼容模型摘要
src/summarizer-factory.js
src/service.js       装配层：adapter + policy + gate + funnel + store
src/tools.js         工具处理器（再挡一遍多余参数）
src/settings-api.js  设置 API 的共享实现（DSH 面板与独立页共用同一份）
src/mcp-server.js    MCP stdio 服务器
src/run-mcp.mjs      MCP 启动包装（固化默认配置）
src/store-file.js    落盘版存储

lib/index.js         插件宿主半（ESM）
lib/client.js        插件客户端半（浏览器 ModuleLoader 格式）
cordis.patch.yml     bundle patch：insert 宿主行
docs/  scripts/  test/
```

**三条铁律**：

1. **原始 chat id 的生命周期止于闸门**。下游只见 `HMAC(secret, canonicalId)[:16]`。这样"读某个私聊"在接口形状上不可表达。
2. **工具面即策略**：`run_summary` 只有 `trigger` 一个键（`scheduled|manual`），多一个键即拒绝；`get_summary` 只接受不透明句柄；不存在任何接收原始 chat id 的入参。
3. **闸门是唯一裁决点**：存储层还要二次拒绝（只接受本次放行的句柄），但判定逻辑不得在别处重复实现。

---

## 三、DSH 集成契约（这一节最重要：全是已证实的坑）

### 3.1 插件必须是"两半"

- `package.json` 声明：
  ```json
  "main": "lib/index.js",
  "exports": { ".": {"default":"./lib/index.js"},
               "./client": {"default":"./lib/client.js"},
               "./cordis.patch.yml": "./cordis.patch.yml",
               "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web",
                "inject": ["@deepseek-ai/dsh-client-ui-renderer",
                           "@deepseek-ai/dsh-client-ui-settings"] },
    "engines": { "dsh": "<照抄同机一个已能正常加载的插件的区间，不要自己猜>" }
  }
  ```
- `cordis.patch.yml` 只有一个 insert：
  ```yaml
  - insert:
      - id: wechat-digest
        name: dsh-wechat-digest
  ```
- 接入方式：`node_modules/<包名>` 建 **junction** 指向源码目录，把包名加进 profile `package.json` 的 `dsh.profile.bundles`。
  **不需要**写进 `dependencies`（本机 53 个 bundle 里有 18 个都不在 dependencies 里）。

### 3.2 宿主半（lib/index.js，ESM）

```js
export const name = 'wechat-digest'
export const inject = []            // 关键：webServer 不能写在这里
export function apply(ctx) {
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer
    if (!webServer || typeof webServer.register !== 'function') { console.error(...); return }
    let dispose = null
    try { dispose = webServer.register({ kind: 'prefix', path: '/wechat-digest', handler }) }
    catch (err) { console.error(...); return }
    scope.effect(() => () => { if (typeof dispose === 'function') dispose() })
  })
}
```

- **`webServer` 不能写进 `inject`**：宿主行挂载早于 webServer 发布，apply 时一次性 `ctx.get('webServer')` 会拿到 `undefined` 并永久放弃。必须用非阻塞的 `ctx.inject(['webServer'], …)`。
- **路由 path 要带前导斜杠**。写成 `wechat-digest` 会 404。
- **不要靠 `req.url` 分派**：harness 如何向 handler 呈现 req.url（完整路径还是去前缀后的剩余部分）**不在任何契约里**。正确做法：只注册一个挂载点，分派只依赖 **HTTP method + 自定义请求头**（如 `x-wechat-digest-op: state|config|reset|run`），URL 仅作兜底线索。
- 补一道**同源校验**：带 `Origin` 且与 `Host` 不一致 → 403。因为该接口能改"是否允许读私聊"，而宿主可能开着公网隧道。

### 3.3 客户端半（lib/client.js，浏览器 ModuleLoader 格式，手写、无需构建）

```js
window.__ModuleLoader__.load({
  id: 'dsh-wechat-digest',
  factory: (require) => {           // 关键：factory 必须接收 require
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    // ... 面板组件 ...
    function apply(ctx) { /* 见下 */ }
    exports.name = 'wechat-digest'
    exports.inject = ['slots']      // 关键：没有它 apply 会早于 slots 发布
    exports.apply = apply
  },
})
```

- **`factory` 必须接收 `require`**，React 从 factory 参数拿。写成无参 IIFE 会报 `require is not defined`，症状是启动日志里「1 entry did not activate / 加载失败」，而宿主半照常工作。
- **`exports.inject = ['slots']` 必须写**，否则 apply 跑在槽位服务发布之前。
- **slots 读不到时绝不能直接 return**：那会表现为「插件已装、设置页没有该项、零报错」。正确做法：`ctx.slots ?? ctx.get('slots')`，取不到就**每 50ms 重试，最多 20 次**，仍失败才 `console.error`。
- 注册方式：
  ```js
  ctx.effect(() => slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'wechat-digest', order: 1250, label: '微信摘要' },
      () => h(WechatDigestPanel, null),
    )))
  ```
- **label 用普通字符串**，不要用函数：在没有 locale 服务的宿主上，函数 label 会让导航崩。
- 样式用宿主 CSS 变量（`--dsh-border` 等）并提供兜底值，不要写死颜色假设。

### 3.4 双入口一致性

设置面板与独立本地页必须**共用同一份服务端实现**（本项目为 `src/settings-api.js`），不要各写一套 — 否则校验规则会静默分叉。

---

## 四、配置 schema（用户可见开关，多余字段一律拒绝）

```json
{
  "version": 1,
  "groupsEnabled": true,                    // 群聊总开关
  "groups": { "<canonicalId>": { "enabled": true, "name": "自定义名字" } },
  "private": { "enabled": false,            // 私聊总开关
               "chats": { "<canonicalId>": { "enabled": true, "name": "老板" } } },
  "summarizer": "llm",                      // llm | heuristic
  "llm": { "provider": "deepseek-official", "model": "deepseek-flash" },
  "schedule": { "enabled": true, "kind": "weekly",
                "weekdays": ["MO","TU","WE","TH","FR"],
                "time": "09:00", "timeZone": "Asia/Shanghai" }
}
```

校验规则：

- 顶层与各嵌套层**字段白名单**，出现未知字段整份作废
- `name` 必须是字符串（不是就拒绝），超长截断 120 字符
- `time` 必须匹配 `^([01]\d|2[0-3]):[0-5]\d$`
- 配置**损坏 → 全关**（fail-closed），**不是**回退默认值（否则"写坏配置"就成了恢复放行的旁路）
- 旧配置缺 `groupsEnabled` / `private.chats` 必须向后兼容（缺省按 开 / 空白名单）

配置 → 策略的转换（`toPolicy`）是总开关优先语义的落点：

```js
const groupsOn = config.groupsEnabled !== false
const groupOverrides = groupsOn ? mapFrom(config.groups) : {}
const privateOn = config.private?.enabled === true
return {
  group:   { defaultEnabled: groupsOn, overrides: groupOverrides },
  private: { defaultEnabled: false, overrides: privateOn ? mapFrom(config.private.chats) : {} },
}
```

注意 `private.defaultEnabled` **恒为 false** —— 私聊是白名单，总开关只是闸门。

---

## 五、存储与隐私

- 摘要落盘为追加式 JSONL（`~/.dsh/wechat-digest/digests.jsonl`）。
- **只写白名单字段**：`roomHandle` / `digest` / `provenance{seqFrom,seqTo}` / `trigger` / `createdAt`。
- **聊天原文与原始会话 id 永不落盘** —— 不是过滤，是写入代码里没有这两条路径。必须有测试往记录里塞 `text`、`rawId`，再断言磁盘上找不到。
- 损坏行启动时跳过并计数，不能让服务起不来。
- 明确告知用户：存储是「启动读盘 + 运行期追加」，**外部改文件不影响已运行进程**，要生效需重启。

---

## 六、模型注册表（多 provider）

不要只支持一家。建一份注册表，每条含 `{id, label, baseUrl, apiKeyEnv, callable, reason?, headers?, models[{id,label}]}`，并允许用 `<dataDir>/models.json` 覆盖/追加（加模型不改代码）。

**必须区分"能在 DSH 里选"与"本插件能直接调用"**：账号登录态（OAuth）没有 OpenAI 兼容的 API Key，要标 `callable: false` 并给出原因，**不能假装能跑**。

密钥解析顺序：环境变量（按 `apiKeyEnv` 取名）→ DSH 凭据文件 `~/.dsh/.credentials.yaml` 同名 refs。**密钥只进内存，不落仓库、不进日志**。

模型失败**不静默降级**：失败就抛带错误码的异常（`SUMMARIZE_HTTP_429` / `SUMMARIZE_NETWORK_FAILED` 等），让用户看得见。

---

## 七、测试与验收（目标 160+ 用例）

必须覆盖：

1. **三态可见性**：群默认读、私聊默认拒、显式开私聊白名单后只读勾选的
2. **总开关优先**：群/私聊总开关关掉后，勾选一律失效
3. **双哨兵**（最关键的方法论）：
   - 群消息里埋 `GRP-<uuid>`，私聊里埋 `PRIV-<uuid>`
   - 跑完断言：`GRP` 在产物中 **≥1 次**（阳性对照），`PRIV` 在**摘要入模 payload / 存储 / 运行结果** 五处 **= 0 次**
   - **没有阳性对照，所有负向测试都可能因"什么都没读"而假阴性通过**
4. **类型交叉校验**：声明为群但权威字段是私聊 → 拒绝
5. **fail-closed**：未知形态、排除通道（公众号/系统号/企业微信）、损坏配置 → 全拒
6. **单漏斗**：定时与手动在闸门之前是同一段代码；触发参数多一个键就拒绝
7. **撞车**：并发第二次触发返回 `ALREADY_RUNNING`，只产出一份
8. **水位线**：第二次只处理增量
9. **存储二次拒绝**：绕过闸门直写被拒；缺 provenance 被拒
10. **核心层纯净性静态检查**：core 目录不得出现 `child_process`/`writeFile`/网络/发送类符号
11. **路由契约测试**：用假 ctx 捕获注册的路由，直接打 state/config/reset/run，**不需要重启就能发现"面板读不到数据"**
12. **设置页服务端测试**：in-process 起服务、真实 HTTP、真实文件系统
13. **页面内嵌 JS 语法校验**：模板字符串里的脚本 `node --check` 看不见，要抠出来交给 `new Function()` 解析

---

## 八、发布红线（这一节是血的教训）

**PII 必须在第一次提交前就清干净，不能等到发布后才发现：**

- **绝对不要把真实微信账号 id（wxid）、真实群 id、真实用户名、真实路径写进 docs、注释、测试夹具**
  - 测试要用 `wxid_testaccount00001` 这类**明确假值**
  - 文档里用 `wxid_xxxxxxxxxxxxxxxx_aaaa`、`C:\Users\<你的用户名>` 占位
  - 脚本里的路径用 `homedir()` / `import.meta.url` 在**运行时**推导
- 发布前跑一次 PII 扫描：`git grep -InE "wxid_[a-z0-9]{10,}|<你的真实用户名>|<真实姓名>|<真实邮箱>|sk-[A-Za-z0-9]{20,}"`
- 打包白名单：`files` 里只放需要的（`lib/ src/ scripts/ test/ docs/ cordis.patch.yml README.md LICENSE`），**`exports/`、`.tmp-*`、`*.bak*` 绝不能进包**（编辑器的备份文件真的会被打进去）
- `private: true` 会直接阻断 `npm publish`
- `npm publish` 可能返回 **PUT 202（Accepted）异步受理**，`npm view` 会先看到旧版本甚至看到一个 `0.0.0-stage` 占位版本 —— 这不是失败，等 1~3 分钟后用 `npm view` 或直连 registry 复查
- **`npm unpublish` 会被"绕过 2FA 的细粒度令牌"策略拒绝**（403）。所以**发布前必须干净**，事后想撤需要用户去网页手动删
- 发布后**把 registry 上的 tarball 拉回来跑一遍测试**，验证"发出去的包本身能用"，而不只是本地能跑
- 不要在没确认的情况下让 AI 读取 `~/.git-credentials` 之类的凭据文件（会被安全策略拦截，且本就不该读）

---

## 九、环境陷阱（Windows 本机实测）

- **MSYS 路径不能传给 Windows 版 Node**：`/d/Users/...` 这类路径会让 `fs.mkdirSync` 直接失败。给 node 的路径要用 `D:/Users/...`。
- **`npm` 的 Windows 包装脚本对某些子命令会崩**（如 `npm deprecate` 报 `'D:\Program' is not recognized`）。绕过办法：直接 `node "D:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js" <cmd>`。
- **DSH 沙箱写出的文件带 Low 完整性标签**，该树下的进程也是 Low IL，**无法读取 Medium IL 进程（如微信）的内存** —— 因此"从微信进程内存取解密密钥"在沙箱内物理上不可能，必须在文档里如实写明，并让真实取数作为需要用户单独授权的二期项。
- `node --test test/` 会为每个测试文件 spawn 子进程，在沙箱里以 `spawn EPERM` 失败。改用「本进程内顺序 import 各测试文件」的 runner。

---

## 十、明确不要做的事

- 不要用 DLL 注入 / 内存 hook 取数（自带发送能力 `SendTextMsg`，且违反 C4）
- 不要用坐标级 UI 自动化（点击可能误触发送、撤回、拉群）
- 不要照抄"默认关但可打开"的既有桥接插件判别式（如 `startsWith('group:') ? groups : private` 是 fail-open 到私聊）
- 不要为了省事把策略判断散落在调用点（必须单一闸门）
- 不要声称"私聊零读取"（同库同表下不可达，只能承诺零可用性/零落盘/零上下文）

---

## 十一、完成的定义

- [ ] `npm run verify` 全绿：核心纯净性检查 + 全部测试
- [ ] `list_rooms` / `run_summary` / `get_summary` 三个工具可用，且**没有任何发送类工具**
- [ ] DSH 设置界面出现「微信摘要」分区，能：勾选群、单群改名、开关群总开关、开关私聊总开关、勾选私聊白名单、选 provider/model、设定时、点「立即总结」看结果
- [ ] 配置改完立即生效（无需重启工具进程）
- [ ] 双哨兵测试通过（群命中、私聊零出现）
- [ ] 打包产物 PII 扫描零命中
- [ ] 从 registry 拉回 tarball 跑测试仍全绿
- [ ] 文档写明：真实微信取数受完整性级别限制、需用户在沙箱外单独处理；ToS/封号风险未评估
