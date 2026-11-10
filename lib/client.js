/**
 * dsh-wechat-digest — 客户端半（Client half）。
 *
 * 手写成浏览器模块加载器要求的格式（`window.__ModuleLoader__.load` + `require`），
 * 因此本包不需要打包步骤。只贡献一个设置分区，数据全部在宿主侧，
 * 通过宿主半注册的同源路由读写。
 *
 * 两个必须遵守的约定（踩过）：
 *  1) `exports.inject = ['slots']` —— 没有它，apply 会在槽位服务发布前执行，
 *     设置页静默不注册。
 *  2) label 用普通字符串 —— 在没有 locale 服务的宿主上，函数 label 会让导航崩。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wechat-digest',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const WEEK_LABEL = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' }

    /** 跟随页面 baseURI 解析路由，反代挂在子路径下也不会 404。 */
    const apiUrl = (suffix) => {
      const tail = typeof suffix === 'string' ? suffix : ''
      const route = `wechat-digest/api/${tail}`
      try {
        if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI) {
          return new URL(route, document.baseURI).toString()
        }
      } catch (err) {
        /* 落到下面的根相对路径 */
      }
      return `/${route}`
    }

    const box = {
      display: 'flex',
      flexDirection: 'column',
      gap: '18px',
      color: 'var(--dsh-text-primary, inherit)',
    }
    const card = {
      border: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
      borderRadius: '10px',
      padding: '14px 16px',
    }
    const title = { fontSize: '13px', fontWeight: 600, marginBottom: '10px', opacity: 0.85 }
    const hint = { fontSize: '12px', opacity: 0.6, marginTop: '6px', lineHeight: 1.6 }
    const row = { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', cursor: 'pointer' }
    const input = {
      background: 'transparent',
      color: 'inherit',
      border: '1px solid var(--dsh-border, rgba(128,128,128,.35))',
      borderRadius: '6px',
      padding: '4px 8px',
      fontSize: '13px',
    }
    const button = {
      background: 'var(--dsh-accent, #2b4a8f)',
      color: '#fff',
      border: 0,
      borderRadius: '7px',
      padding: '7px 16px',
      fontSize: '13px',
      cursor: 'pointer',
    }
    const buttonGhost = { ...button, background: 'transparent', border: '1px solid var(--dsh-border, rgba(128,128,128,.35))', color: 'inherit' }
    const pre = {
      margin: 0,
      padding: '10px 12px',
      borderRadius: '8px',
      border: '1px solid var(--dsh-border, rgba(128,128,128,.25))',
      fontSize: '12px',
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    }

    async function fetchJson(url, options) {
      const res = await fetch(url, { credentials: 'same-origin', ...options })
      const text = await res.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch (err) {
        body = { ok: false, reason: 'BAD_RESPONSE' }
      }
      return { status: res.status, body }
    }

    function WechatDigestPanel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      const [draft, setDraft] = useState(null)
      const [running, setRunning] = useState(false)
      const [runResult, setRunResult] = useState(null)

      const load = useCallback(async () => {
        setError(null)
        try {
          const { status: code, body } = await fetchJson(apiUrl('state'), {
            headers: { 'x-wechat-digest-op': 'state' },
          })
          if (code !== 200 || !body) {
            setError(body && body.reason ? body.reason : `HTTP ${code}`)
            return
          }
          setState(body)
          setDraft({
            groupsEnabled: body.config.groupsEnabled !== false,
            groups: { ...body.config.groups },
            privateEnabled: !!body.config.private.enabled,
            privateChats: { ...(body.config.private.chats || {}) },
            summarizer: body.config.summarizer,
            provider: body.config.llm?.provider ?? '',
            model: body.config.llm?.model ?? '',
            schedEnabled: !!body.config.schedule.enabled,
            schedTime: body.config.schedule.time,
            weekdays: [...body.config.schedule.weekdays],
            timeZone: body.config.schedule.timeZone,
          })
        } catch (err) {
          setError(String((err && err.message) || err))
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      if (error) {
        return h('div', { style: box }, h('div', { style: card }, `读取设置失败：${error}`))
      }
      if (!state || !draft) {
        return h('div', { style: box }, h('div', { style: card }, '读取中…'))
      }

      const groups = Array.isArray(state.groups) ? state.groups : Array.isArray(state.rooms) ? state.rooms : []
      const privates = Array.isArray(state.privates) ? state.privates : []
      const providers = Array.isArray(state.providers) ? state.providers : []
      const selectedProvider = providers.find((item) => item.id === draft.provider) || null
      const groupsOn = draft.groupsEnabled !== false
      const privateOn = !!draft.privateEnabled

      const toggleDay = (day) => {
        setDraft((prev) => {
          const has = prev.weekdays.includes(day)
          const next = has ? prev.weekdays.filter((d) => d !== day) : [...prev.weekdays, day]
          return { ...prev, weekdays: next.length ? next : [day] }
        })
      }

      /** 去掉空名字，别把 "" 写进配置。 */
      const cleanMap = (map) => {
        const out = {}
        for (const [key, value] of Object.entries(map || {})) {
          const entry = { enabled: value && value.enabled !== false }
          if (value && typeof value.name === 'string' && value.name.trim().length > 0) {
            entry.name = value.name.trim()
          }
          out[key] = entry
        }
        return out
      }

      const save = async () => {
        setStatus('保存中…')
        const payload = {
          version: 1,
          groupsEnabled: draft.groupsEnabled !== false,
          groups: cleanMap(draft.groups),
          private: { enabled: draft.privateEnabled, chats: cleanMap(draft.privateChats) },
          summarizer: draft.summarizer,
          llm: { provider: draft.provider, model: draft.model },
          schedule: {
            enabled: draft.schedEnabled,
            kind: 'weekly',
            weekdays: draft.weekdays,
            time: draft.schedTime || '09:00',
            timeZone: draft.timeZone || 'Asia/Shanghai',
          },
        }
        const { status: code, body } = await fetchJson(apiUrl('config'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-wechat-digest-op': 'config' },
          body: JSON.stringify(payload),
        })
        if (code === 200 && body && body.ok) setStatus('已保存 · 群聊与开关立即生效')
        else setStatus(`保存失败：${(body && body.reason) || 'HTTP ' + code}`)
      }

      const reset = async () => {
        const { status: code, body } = await fetchJson(apiUrl('reset'), {
          method: 'POST',
          headers: { 'x-wechat-digest-op': 'reset' },
        })
        if (code === 200 && body && body.ok) {
          setStatus('已恢复默认')
          load()
        } else {
          setStatus(`失败：${(body && body.reason) || 'HTTP ' + code}`)
        }
      }

      /** 立即总结：按**已保存**的设置跑一次。 */
      const runNow = async () => {
        setRunning(true)
        setRunResult(null)
        try {
          const { status: code, body } = await fetchJson(apiUrl('run'), {
            method: 'POST',
            headers: { 'x-wechat-digest-op': 'run' },
          })
          if (code === 200 && body) setRunResult(body)
          else setRunResult({ ok: false, error: (body && body.reason) || 'HTTP ' + code })
        } catch (err) {
          setRunResult({ ok: false, error: String((err && err.message) || err) })
        } finally {
          setRunning(false)
        }
      }

      /** 通用勾选列表；总开关关闭时置灰。名字可自定义，保存在配置里。 */
      const renderList = (items, { configMap, disabled, emptyText, kind }) => {
        if (state.roomsError) return h('div', { style: hint }, `读不到导出目录：${state.roomsError}`)
        if (items.length === 0) return h('div', { style: hint }, emptyText)

        const patchEntry = (key, patch) => {
          const next = { ...configMap, [key]: { ...(configMap[key] || {}), ...patch } }
          if (kind === 'group') setDraft((prev) => ({ ...prev, groups: next }))
          else setDraft((prev) => ({ ...prev, privateChats: next }))
        }

        return items.map((item) => {
          const entry = configMap[item.key] || {}
          const checked = entry.enabled !== false
          const shown = entry.name && entry.name.trim() ? entry.name.trim() : item.name
          return h(
            'div',
            {
              key: item.key,
              style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0', opacity: disabled ? 0.45 : 1 },
            },
            h('input', {
              type: 'checkbox',
              checked: checked,
              disabled: disabled,
              onChange: (event) => patchEntry(item.key, { enabled: event.target.checked }),
            }),
            h('span', { style: { minWidth: '110px' } }, shown),
            h('input', {
              type: 'text',
              style: { ...input, flex: '1', minWidth: '120px' },
              placeholder: '自定义名字（可选）',
              value: entry.name || '',
              disabled: disabled,
              onChange: (event) => patchEntry(item.key, { name: event.target.value }),
            }),
            h('span', { style: { ...hint, marginTop: 0, opacity: 0.4 } }, item.key),
          )
        })
      }

      return h(
        'div',
        { style: box },
        h(
          'div',
          { style: hint },
          `配置：${state.configPath}`,
          state.configError ? `　⚠ 配置有问题：${state.configError}（已按全关处理）` : '',
        ),
        h(
          'div',
          { style: card },
          h('div', { style: title }, '群聊'),
          h(
            'label',
            { style: row },
            h('input', {
              type: 'checkbox',
              checked: groupsOn,
              onChange: (event) => setDraft((prev) => ({ ...prev, groupsEnabled: event.target.checked })),
            }),
            h('span', null, '读取群聊（总开关）'),
            h('span', { style: hint }, groupsOn ? '' : '已关闭：任何群都不会被读取'),
          ),
          groupsOn
            ? h(
                'div',
                { style: { marginTop: '8px' } },
                h('div', { style: { ...hint, marginTop: 0, marginBottom: '4px' } }, '要总结哪些群（取消勾选 = 不读该群）'),
                renderList(groups, {
                  configMap: draft.groups,
                  disabled: false,
                  emptyText: '导出目录里还没有群。把导出的群放进 exports/ 后重新打开本页。',
                  kind: 'group',
                }),
              )
            : null,
        ),
        h(
          'div',
          { style: card },
          h('div', { style: title }, '私聊'),
          h(
            'label',
            { style: row },
            h('input', {
              type: 'checkbox',
              checked: privateOn,
              onChange: (event) => setDraft((prev) => ({ ...prev, privateEnabled: event.target.checked })),
            }),
            h('span', null, '允许读取私聊（总开关，默认关闭）'),
            h('span', { style: hint }, privateOn ? '' : '已关闭：私聊连读取都不会发生'),
          ),
          privateOn
            ? h(
                'div',
                { style: { marginTop: '8px' } },
                h('div', { style: { ...hint, marginTop: 0, marginBottom: '4px' } }, '允许哪些私聊（至少勾选一个才会读）'),
                renderList(privates, {
                  configMap: draft.privateChats,
                  disabled: false,
                  emptyText: '导出目录里没有私聊记录。',
                  kind: 'private',
                }),
                h('div', { style: hint }, '总开关关闭时，下面任何勾选都不会生效。'),
              )
            : null,
        ),
        h(
          'div',
          { style: card },
          h('div', { style: title }, '摘要方式'),
          h(
            'select',
            {
              style: input,
              value: draft.summarizer,
              onChange: (event) => setDraft((prev) => ({ ...prev, summarizer: event.target.value })),
            },
            h('option', { value: 'llm' }, '模型摘要'),
            h('option', { value: 'heuristic' }, '本地关键词规则（省钱、精度低）'),
          ),
          draft.summarizer !== 'llm'
            ? null
            : h(
                'div',
                { style: { marginTop: '14px' } },
                h('div', { style: { ...hint, marginTop: 0, marginBottom: '6px' } }, '提供方'),
                h(
                  'select',
                  {
                    style: { ...input, width: '100%' },
                    value: draft.provider,
                    onChange: (event) => {
                      const next = providers.find((item) => item.id === event.target.value)
                      const firstModel = next && next.models && next.models[0] ? next.models[0].id : ''
                      setDraft((prev) => ({ ...prev, provider: event.target.value, model: firstModel }))
                    },
                  },
                  providers.length === 0 ? h('option', { value: '' }, '（无可用提供方）') : null,
                  providers.map((provider) =>
                    h(
                      'option',
                      { key: provider.id, value: provider.id, disabled: !provider.callable },
                      provider.label + (provider.callable ? '' : '（不可直接调用）'),
                    ),
                  ),
                ),
                h('div', { style: { ...hint, marginTop: '10px', marginBottom: '6px' } }, '模型'),
                h(
                  'select',
                  {
                    style: { ...input, width: '100%' },
                    value: draft.model,
                    onChange: (event) => setDraft((prev) => ({ ...prev, model: event.target.value })),
                  },
                  ((selectedProvider && selectedProvider.models) || []).map((model) =>
                    h('option', { key: model.id, value: model.id }, model.label + ' — ' + model.id),
                  ),
                ),
                selectedProvider && selectedProvider.reason
                  ? h('div', { style: hint }, '⚠ ' + selectedProvider.reason)
                  : h(
                      'div',
                      { style: hint },
                      '密钥从环境变量或 ~/.dsh/.credentials.yaml 里的 ' +
                        (selectedProvider && selectedProvider.keyEnv ? selectedProvider.keyEnv : '—') +
                        ' 读取；不会写进仓库或日志。',
                    ),
              ),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: title }, '定时'),
          h(
            'label',
            { style: row },
            h('input', {
              type: 'checkbox',
              checked: draft.schedEnabled,
              onChange: (event) => setDraft((prev) => ({ ...prev, schedEnabled: event.target.checked })),
            }),
            h('span', null, '启用定时总结'),
          ),
          h(
            'div',
            { style: { ...row, cursor: 'default' } },
            h('span', null, '执行时间'),
            h('input', {
              type: 'time',
              style: input,
              value: draft.schedTime,
              onChange: (event) => setDraft((prev) => ({ ...prev, schedTime: event.target.value })),
            }),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '4px' } },
            Object.keys(WEEK_LABEL).map((day) =>
              h(
                'label',
                { key: day, style: { ...row, padding: '2px 0' } },
                h('input', {
                  type: 'checkbox',
                  checked: draft.weekdays.includes(day),
                  onChange: () => toggleDay(day),
                }),
                h('span', null, WEEK_LABEL[day]),
              ),
            ),
          ),
          h('div', { style: hint }, '定时触发由 DSH 的定时任务控制；这里保存的是配置，改了时间需要同步到定时任务才会按新时间跑。'),
        ),
        h(
          'div',
          { style: card },
          h('div', { style: title }, '立即总结'),
          h('div', { style: hint }, '按**已保存**的设置立刻跑一次；与定时任务共用同一套策略和闸门。'),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } },
            h('button', { style: button, onClick: runNow, disabled: running }, running ? '总结中…' : '立即总结'),
            runResult
              ? h(
                  'span',
                  { style: { ...hint, marginTop: 0, color: runResult.ok ? '#7ad17a' : '#ff8080' } },
                  runResult.ok
                    ? `完成 · 摘要 ${runResult.summarized} 个会话 · 跳过 ${runResult.skipped} · 拒绝 ${runResult.denied}`
                    : `失败：${runResult.error}`,
                )
              : null,
          ),
          runResult && runResult.items && runResult.items.length > 0
            ? h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' } },
                runResult.items.map((item, index) =>
                  h(
                    'div',
                    { key: index },
                    h('div', { style: { ...hint, marginTop: 0, marginBottom: '4px' } }, item.name || item.roomHandle),
                    h('pre', { style: pre }, item.text),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
          h('button', { style: button, onClick: save }, '保存'),
          h('button', { style: buttonGhost, onClick: reset }, '恢复默认'),
          status ? h('span', { style: hint }, status) : null,
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.slots !== undefined ? ctx.slots : ctx.get('slots')
      if (!slots || typeof slots.inject !== 'function') {
        console.error('[wechat-digest] slots 服务不可用，设置页无法注册')
        return
      }
      ctx.effect(() =>
        slots.inject('settings.section', () =>
          slots.register(
            { name: 'settings.section', id: 'wechat-digest', order: 1250, label: '微信摘要' },
            () => h(WechatDigestPanel, null),
          ),
        ),
      )
    }

    exports.name = 'wechat-digest'
    // 没有这行，apply 会在 slots 发布前跑，设置页静默不注册
    exports.inject = ['slots']
    exports.apply = apply
    // 必须返回：模块加载器只认 factory 的返回值，漏掉会让 client 半变成 undefined，
    // 宿主启动时抛 invalid plugin (received undefined)，整个应用起不来。
    return module.exports
  },
})
