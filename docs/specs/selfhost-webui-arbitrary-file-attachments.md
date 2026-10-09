# 自部署 WebUI 通用文件附件上传

状态：已实施（本地构建与隔离验收通过；线上需同步静态资源并重启Host生效）
适用：自部署 entry-http 的本机工作区。桌面 localPath 零拷贝、远端工作区、图片/视频/PDF 的既有链路不变。

## 产品规则

- 浏览器选择的普通文件（含文本、未知扩展名、二进制）完整保存原始字节；单文件上限为 20 MiB（20,971,520 字节），等于上限允许，0 字节允许，超过上限在读内容前拒绝。
- 不建立扩展名白名单，不将二进制当 UTF-8 解码。空 MIME 规范为 application/octet-stream；图片/视频/PDF 保留现有多模态上传链路。
- 复用最多 8 个附件和现有上传进度、取消、重试 UI。普通文件通过现有 IPromptAttachmentTransferService 扩展的事务上传，不新增 HTTP 上传路由、不修改闭源 CLI。
- 文件保存在运行 Agent 的 Host 数据根下专用私有目录，不存于 edge/relay，不写入项目目录。提交返回 Host 上稳定绝对路径，AttachmentRef 经现有 sendText/createSession/editUserQuery 交付，CLI 使用既有路径附件处理。
- 上传成功表示原始字节已校验且可由工具访问，不表示全部内容进入模型上下文或任意格式能被直接解析。
- 未发送 File 草稿保持浏览器内存语义：刷新后可能需重新选择；已发送文件必须跨 Host 重启保留。

## 所有者与接口

- Host 通用上传存储是事务、文件及持久 manifest 的唯一所有者，位于 packages/services/src/prompt-attachment-transfer。
- IPromptAttachmentTransferService 增加能力查询和 beginUpload/uploadChunk/commitUpload；cancel/cleanup/adopt 复用。普通 localPath stage 仍零拷贝，不得删除用户源文件。
- capabilities 由 Host 装配开启；entry-http 开启，桌面和远端默认不开启。远端输入 fail closed，不能把本机上传路径发送给其他 Host。
- begin 绑定 operationId、sessionId、workspaceIdentity?.trim() || workspacePath、文件名、MIME、字节数、分片数与 SHA-256。重放参数冲突拒绝；重复同片字节一致时返回已确认进度；重复提交返回相同路径。
- 每片 decoded <=512 KiB；Web 实际使用384 KiB。总量<=20 MiB；同时在传最多16项、上传中预留总量64 MiB、上传中及待发送总量默认160 MiB（8个20 MiB附件），全部 managed 文件默认2 GiB，Host装配可通过 arbitraryFileUploadQuota 调整；达到配额拒绝新增，不删除已发送文件。流式写入异步文件 IO，提交重新校验 SHA-256/总长并原子 rename。
- manifest 保存元数据/状态/片校验，不含正文。Host 重建后回收未完成上传；已提交但未引用的暂存文件可按持久记录24小时回收。已保留/接管文件不得按 mtime/TTL 删除。

## 顺序与崩溃边界

```text
浏览器 File → begin/chunk → Host uploading
                              ↓ checksum + atomic commit
                           ready（路径稳定）
                              ↓ Host发送入口持久 retainForCommand
                           retained（不再允许cleanup删除）
                              ↓ CLI command admission → ACK
                           UI adopt/clear（幂等，不改文件路径）
```

- createLocalServices 向 Agent service 注入发送前附件保留端口。在 CLI 请求前按规范命令解析引用并持久保留 owned 文件，覆盖 send ACK 与 UI adopt 之间的崩溃窗口。
- command/session/workspace 绑定必须一致；只校验本服务根内的 managed ref，既有桌面路径与CLI artifact ref不变。
- 发送失败或ACK丢失无法证明CLI未接受时不回收 retained 文件（保守保留优于破坏已接受消息）；UI不应借cleanup删已保留文件。此次不提供自动删除已发送附件，后续清理需以权威会话引用为依据。
- cancel/commit/send 在同一owner串行执行；晚到chunk/commit不能复活已取消operation。cleanup路径由owner生成，不接受任意删除路径。
- Desktop continuous 与 Web replayable 共用同一附件owner；重连无需改变引用路径。已有owner/lease、CommandInbox admission与stale command防护不变。

## 安全与失败

- 数据根下专用上传目录700，文件600（POSIX）；文件名只接受安全basename，operation目录由随机operationId的hash生成，拒绝路径穿越、NUL、超长元数据；排除符号链接与根目录逃逸。
- 以实际decoded字节计量，不相信客户端size。校验失败不能返回ready；取消/磁盘失败只删除该operation的未引用内容。
- 服务方法做运行时校验；客户端不能伪造远端target或其他session的managed路径来发送。使用已鉴权RPC链路，不打印正文/凭据。
- 释放服务时关闭句柄/定时器/事件并等待在途IO，保留已提交文件。

## 验收

1. binpkg/zip/db/未知扩展名/Unicode文件名/长文本，Host文件与输入SHA-256相同，发送引用为正确Host路径，智能体工具可访问。
2. 0、1字节、20 MiB允许；20 MiB+1拒绝且不读文件正文；超过512KiB分片、总量越界、checksum不符拒绝。
3. 同名不同内容不覆盖；重复begin/chunk/commit幂等，冲突拒绝；cancel后chunk/commit拒绝。
4. 相同路径不同workspace identity、不同session不能串用managed引用；远端upload拒绝。
5. 上传取消/重试/发送失败/发送ACK丢失/Host重启：未引用内容可清理，发送前已retain内容保留，文件路径不变。
6. 图片/视频/PDF和桌面localPath路径回归；上传中的附件不允许提交，进度与完成态正确；服务关闭无悬挂资源。

验证：services存储与发送边界单测，ui纯上传事务/分类单测，隔离实例Web GUI验收；执行pnpm typecheck、pnpm lint、架构检查与目标包tests。不得为验收重启zcode-web-local宿主；复制数据根必须去掉副本credentials.json。

2026-10-09 验证记录：实际useComposerAttachments + 浏览器WebSocket/ChannelClient + Host服务的隔离GUI中，4字节binpkg、0字节、恰好20 MiB db、204800字节文本均ready，落盘SHA-256完全相同且权限600，20 MiB+1在UI拒绝；移除ready附件删除其文件并持久记取消，重建Host保留原20 MiB文件。发送前retain跨服务重建/24h保留由存储与接线单测覆盖。CLI源码实际附件映射/resolver确认二进制路径交付（不发送真实模型请求）。
