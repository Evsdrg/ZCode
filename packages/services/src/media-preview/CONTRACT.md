# media-preview

自部署 WebUI 的本地音视频预览通道。

## 存在的意图

`IMediaPreviewService.prepare()` 的 `inline` 路径有 8MB 上限，超过即抛错。桌面端靠 Electron 的
`zcode-media://` 自定义协议走 `local-url`（HTTP Range），自部署 server 没有该协议，导致所有
>8MB 的音频/视频在 WebUI 上无法预览。本模块提供 server 侧的那一半：授权表 + Range 解析 +
同源 URL 构造。

## 不变量

- **URL 不是授权**：`/api/media/preview?path=...` 里的 path 只有先在 lease store 登记过才可读，
  未登记一律 404。知道路由格式不足以读取任意文件。
- **每次复核都重新 realpath**：授权后若文件被替换成指向别处的符号链接，`resolve()` 会失效并
  移除条目，不会顺着链接读到授权范围外的内容。
- **必须同源**：URL 由 `buildServerMediaPreviewUrl` 生成相对路径。浏览器可能在另一台机器上，
  写成 `http://127.0.0.1:<port>` 会让请求打到浏览器自己。
- **Range 必须支持**：音视频 seek 与「moov 位于 mdat 之后」的 MP4 元数据探测都依赖
  206 + Content-Range；返回 200 全量会被浏览器判为不可播放。

## 与其它模块的交集

- 授权入口在 `createMediaPreviewService` 的 `authorizeLocalMediaPreviewPath` 回调里
  （`packages/services/src/node.ts` 按宿主形态二选一：桌面走 Electron，自部署走本模块）。
- HTTP 读取端在 `packages/server/src/http.ts` 的 `/api/media/preview` 路由，按 1MB 分块流式
  返回，背压交给 ReadableStream。
- 文件读取统一走 `IFileService.readFileRange`，不直接碰文件系统——这样同一份路由也能兼容
  远端 Host 的文件服务。
