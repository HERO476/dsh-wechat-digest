# 导出目录

把你在微信里复制出来的群聊记录放在这里，每个会话一个子目录：

```
exports/
  my-group/
    room.json       { "name": "我的群", "kind": "group", "id": "my-group" }
    messages.txt    [2026-11-10 09:12] 小王: 周五前交评审稿
```

格式细节见 [../docs/EXPORT-FORMAT.md](../docs/EXPORT-FORMAT.md)。

注意：`kind` 为 `private` 的目录**默认为不可读**（会被闸门拒绝），
所以把私聊也放进来是安全的——存在不等于可读。
