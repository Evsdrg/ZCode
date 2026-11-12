# log-export

自部署 WebUI 的日志导出通道。

## 存在的意图

桌面端 `exportLogs()` 在 Electron main 里：收集 `~/.zcode/v2`、`~/.zcode/cli/log`、CUA helper
日志 → 逐个脱敏 → 打包 zip → `shell.showItemInFolder`。整条链里唯一与 Electron 绑定的只有
最后一步。浏览器没有文件管理器，所以本模块把纯 Node 部分搬过来，产物改为经 HTTP 附件下载。

## 不变量

- **必须脱敏**：所有文本日志都经 `sanitizeSensitiveLog.ts`，键名命中
  password/secret/token/auth 等族即替换为 `***REDACTED***`，再按白名单放行
  `input_tokens` / `max_tokens` / `author` 这类普通字段。不能跳过这一步直出原始日志。
- **zip 失败必须回退目录**：与桌面端一致，zip 写入被外部因素打断时回退到目录导出；
  两者都失败才报错。目录回退不可下载，调用方要如实展示而不是当成下载成功。
- **时间窗只作用于日志类路径**：只有 `logs/` 与 `.zcode/cli/log/` 下的文件按 mtime 保留近
  3 天；settings 等排障配置不参与过滤，避免久未修改但影响当前行为的配置丢失。

## 与其它模块的交集

- HTTP 出口在 `packages/server/src/http.ts` 的 `/api/logs/export`，成功时返回
  `Content-Disposition: attachment` 的 zip，失败时返回 JSON 错误（避免浏览器把错误体存成
  坏掉的 zip）。
- 浏览器侧在 `packages/web/src/platform/exportLogs.ts`，先 fetch 再转 blob 下载。
- `showItemInFolder` 是可注入依赖，默认空操作：桌面 Host 注入 Electron shell，自部署不注入。
- `setLogExportLogger` 只供测试替换 sink，生产代码不调用。
