# 安装进 DSH

本插件有**两个互不干扰的接入点**：

| 接入点 | 提供什么 | 改动生效 |
|---|---|---|
| MCP 行（`mcp-wechat-digest`） | 三个只读工具 `list_rooms` / `run_summary` / `get_summary` | 热加载，无需重启 |
| Bundle（`dsh-wechat-digest`） | 设置界面里的「微信摘要」分区 | **需重启** |

两者可以共存，也可以只装其中一个。

---

## 一、MCP 行（工具）

把 [cordis.patch.fragment.yml](../install/cordis.patch.fragment.yml) 的内容追加到
`C:\Users\<你的用户名>\.dsh\profiles\desktop\cordis.patch.yml` 末尾，然后：

```
重启后工具列表里出现 list_rooms / run_summary / get_summary
```

（实测这一路是热加载的，通常不用重启就能出现。）

## 二、Bundle（设置分区）

1. 建 junction，让 profile 能解析到本包：

   ```powershell
   New-Item -ItemType Junction `
     -Path   C:\Users\<你的用户名>\.dsh\profiles\desktop\node_modules\dsh-wechat-digest `
     -Target <项目目录>
   ```

2. 把包名加入 profile 的 `dsh.profile.bundles`（先备份 `package.json`）：

   ```js
   p.dsh.profile.bundles.push('dsh-wechat-digest')
   ```

   > 不需要写进 `dependencies`——本机 53 个 bundle 里有 18 个都不在 dependencies 里。

3. **重启 DSH**（完全退出再打开）。

4. 打开 设置 → 左侧应出现 **「微信摘要」**。

### 起不来的话怎么回滚

只撤 bundle 还不够 —— MCP 行与数据目录也要处理，否则会留下「工具还在、面板没了」的半装状态。

```powershell
# 1) 还原 profile package.json（撤掉 bundles 里的条目）
Copy-Item C:\Users\<你的用户名>\.dsh\profiles\desktop\package.json.bak-wechat-digest-* `
          C:\Users\<你的用户名>\.dsh\profiles\desktop\package.json -Force

# 2) 删掉 junction
Remove-Item C:\Users\<你的用户名>\.dsh\profiles\desktop\node_modules\dsh-wechat-digest -Force

# 3) 撤掉 MCP 行：编辑 profile 的 cordis.patch.yml，删除 id 为 mcp-wechat-digest 的那一段
#    （在 ~/.dsh/profiles/desktop/cordis.patch.yml 里搜 "mcp-wechat-digest"）

# 4) 数据目录（可选：删了就没有历史摘要与配置了）
Remove-Item C:\Users\<你的用户名>\.dsh\wechat-digest -Recurse -Force
```

回滚后独立设置页（`npm run settings`）仍然可用，功能不丢；
再打开 DSH 时设置 →「微信摘要」分区应消失。

---

## 三、独立设置页（不依赖 DSH）

```bash
npm run settings     # → http://127.0.0.1:7199
```

与 DSH 面板读同一份 `~/.dsh/wechat-digest/config.json`、复用同一份校验逻辑
（`src/settings-api.js`），所以两边行为一致。

---

## 四、配置项

默认值集中在 `src/run-mcp.mjs` 顶部（MCP 侧）与 `src/settings-api.js`（路径解析）：

| 变量 | 说明 |
|---|---|
| `WECHAT_DIGEST_SOURCE` | `fixture` / `file`（默认）/ `wechat` |
| `WECHAT_DIGEST_EXPORT_DIR` | 导出根目录，默认由包位置推导 |
| `WECHAT_DIGEST_DATA_DIR` | 配置与摘要落盘，默认 `~/.dsh/wechat-digest` |
| `WECHAT_DIGEST_SECRET` | 句柄 HMAC 密钥，≥16 字符；**不设则自动生成 `<dataDir>/secret`**（0600，两半共用） |
| `WECHAT_DIGEST_ALLOWED_HOSTS` | 额外允许的 Host（逗号分隔）。默认只允许回环，用隧道必须显式加白 |
| `WECHAT_DIGEST_SUMMARIZER` | `heuristic` / `llm` |
| `WECHAT_DIGEST_SCHEDULER` | `off` 关掉宿主半定时器（排障用） |

模型密钥优先环境变量 `WECHAT_DIGEST_LLM_API_KEY`，否则运行时读
`~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`。密钥不进仓库、不进日志。

---

## 五、安全提示

- 设置接口能改「是否允许读私聊」，而本机可能开着 `remote-web-ui.autoTunnel`。
  现在的访问控制是两层：
  1. **Host 白名单**：只接受 `127.0.0.1` / `localhost` / `[::1]`，
     （也挡 DNS rebinding：攻击页的 `Host` 是它自己的域名）；
  2. **写操作必须同源 `Origin`**：`POST` 没有 `Origin` 或 `Origin.host !== Host` → 403。
     浏览器一定带 `Origin`，`curl` 不带 → 程序化改配置被关掉。
- **要走公网隧道**：把隧道域名写进 `WECHAT_DIGEST_ALLOWED_HOSTS`（逗号分隔）才会放行；
  不放行时隧道访问会得到 403。**默认不放行**——这是故意的。
- 独立设置页（`127.0.0.1:7199`）用同一套 Host/Origin 校验。
- 句柄密钥不再有仓库默认值：`<dataDir>/secret` 首次运行生成 32 字节随机值（0600）。
  进程内两侧共用同一份，所以句柄稳定；删掉这个文件会让所有历史句柄失效（摘要读不出来）。
- 插件**永久没有发送能力**：工具面里不存在发送类工具，代码里也没有那条路径。
