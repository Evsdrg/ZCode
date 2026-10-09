import { useEffect, useState, type ReactNode } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block.js";
import { MessageResponse, type MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { ToolInput, ToolOutput } from "@/components/ai-elements/tool.js";
import { useToolPresentationCapabilities } from "@/ToolCallBlocks/presentationCapabilities.js";
import { logger } from "@/logger.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  CodeViewerSource,
  ImageCodeViewerSource,
  TextCodeViewerSource,
} from "@/lib/codeViewer.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";
import type { ToolDisplayModel, ToolInlinePreview } from "@/lib/toolDisplay.js";
import type { Theme } from "@/useTheme.js";

export function ToolCallBody({
  childToolList,
  displayModel,
  inlinePreviewOverride,
  toolCall,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  childToolList: ReactNode;
  displayModel: ToolDisplayModel;
  inlinePreviewOverride?: ToolInlinePreview;
  toolCall: TaskChatToolCallTreeNode["toolCall"];
  workspacePath: string;
  /** 应用主题（store 耦合剥离）：透传给 markdown / 代码块渲染，缺省按 "system" 兜底。 */
  theme?: Theme;
  /** 代码预览设置（store 耦合剥离）：透传给 markdown 渲染，需保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  const inlinePreview = inlinePreviewOverride ?? displayModel.inlinePreview;

  return (
    <>
      {childToolList ?? (
        <>
          {inlinePreview.type === "text" ? (
            <InlineCodeContent
              preview={inlinePreview.source}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ) : null}
          {inlinePreview.type === "image" ? (
            <InlineImageContent preview={inlinePreview.source} />
          ) : null}
          {displayModel.planResult ? (
            <InlinePlanResult
              plan={displayModel.planResult.plan}
              planFilePath={displayModel.planResult.planFilePath}
              workspacePath={workspacePath}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenCodeViewer={onOpenCodeViewer}
              onOpenFileLink={onOpenFileLink}
              onOpenBrowserUrl={onOpenBrowserUrl}
            />
          ) : null}
          {displayModel.showInput && toolCall.input !== undefined ? (
            <ToolInput input={toolCall.input} />
          ) : null}
          {displayModel.showOutput ? (
            <ToolOutput errorText={toolCall.error} output={toolCall.output} />
          ) : null}
          {displayModel.showKind ? (
            <p className="text-ui-base text-muted-foreground">{toolCall.kind}</p>
          ) : null}
        </>
      )}
    </>
  );
}

function InlineCodeContent({
  preview,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  preview: TextCodeViewerSource;
  workspacePath: string;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  if (preview.language === "markdown") {
    return (
      <div className="max-h-60 overflow-auto rounded-xl border border-border bg-muted/15 px-3 py-3">
        <MessageResponse
          className="min-w-0 break-words"
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          // 工具输出里的 markdown 文件链接之前只拿到 onOpenCodeViewer，
          // 点击会退化成 code viewer fallback；有 diff source 上下文时容易打开变更视图。
          // 这里优先交给 shell 的文件链接分流，文件看内容，目录走文件树 reveal。
          onOpenFileLink={onOpenFileLink}
          onOpenExternalUrl={onOpenBrowserUrl}
        >
          {preview.content}
        </MessageResponse>
      </div>
    );
  }

  return (
    <div className="max-h-60 overflow-auto rounded-xl bg-muted/15">
      <CodeBlock code={preview.content} language={preview.language} appTheme={theme} />
    </div>
  );
}

// 虚拟列表按测高缓存行高：截图 <img> 解码后从 0 撑到全高会让行高突变，
// 用户浏览历史时表现为滚动条乱跳。按 dataURL 记住自然尺寸，重挂载时立即
// 预留宽高比（首见仍会撑高一次，属不可避免；dataURL 相同 ⇒ 命中同一缓存）。
const imageSizeCache = new Map<string, { width: number; height: number }>();

function InlineImageContent({ preview }: { preview: ImageCodeViewerSource }) {
  const { readMediaPreview, resourceUrl } = useToolPresentationCapabilities();
  const { intl } = useZCodeIntl();
  const directSrc = resourceUrl?.(preview.path);
  const [result, setResult] = useState<{
    path: string;
    reader: typeof readMediaPreview;
    src?: string;
    failed?: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    if (directSrc || !readMediaPreview) return;
    // 图片读取失败曾留下永久 loading 和未处理 rejection；终态必须收口。
    void (async () => {
      try {
        const media = await readMediaPreview(preview.path);
        if (!cancelled)
          setResult({ path: preview.path, reader: readMediaPreview, src: media?.dataBase64 });
      } catch (error) {
        if (cancelled) return;
        logger.warn("[ToolCallBody] 内嵌图片读取失败", {
          path: preview.path,
          error: String(error),
        });
        setResult({ path: preview.path, reader: readMediaPreview, failed: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [directSrc, readMediaPreview, preview.path]);

  // 在 effect 清理前也不能显示旧路径或旧能力的图片。
  const current =
    result?.path === preview.path && result.reader === readMediaPreview ? result : null;
  const src = directSrc ?? current?.src;
  if (!src) {
    return (
      <p>
        {intl.formatMessage({
          id: current?.failed
            ? "chat.toolCall.previewFailed"
            : !readMediaPreview || current
              ? "chat.toolCall.previewUnavailable"
              : "chat.toolCall.loading",
        })}
      </p>
    );
  }

  const cachedSize = imageSizeCache.get(src);
  return (
    <img
      src={src}
      alt={preview.title}
      // 上限收紧截图高度（全页截图可达数千 px）；宽高比预留减少虚拟列表测高突变。
      className="max-h-[420px] max-w-full rounded-lg object-contain"
      {...(cachedSize ? { width: cachedSize.width, height: cachedSize.height } : {})}
      onLoad={(event) => {
        const img = event.currentTarget;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          imageSizeCache.set(img.src, {
            width: img.naturalWidth,
            height: img.naturalHeight,
          });
        }
      }}
    />
  );
>>>>>>> ea3e1799 (feat(attachments): Host 持久保存 20 MiB 以内的任意文件附件)
}

function InlinePlanResult({
  plan,
  planFilePath,
  workspacePath,
  theme,
  codePreviewSettings,
  onOpenCodeViewer,
  onOpenFileLink,
  onOpenBrowserUrl,
}: {
  plan: string;
  planFilePath?: string;
  workspacePath: string;
  theme?: Theme;
  codePreviewSettings?: CodePreviewSettings;
  onOpenCodeViewer?: (source: CodeViewerSource) => void;
  onOpenFileLink?: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl?: (url: string) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-3 rounded-xl border border-outline/60 bg-muted/15 p-3">
      {planFilePath ? (
        <div className="flex flex-wrap items-center gap-2 text-ui-base text-on-surface-muted">
          <span>{intl.formatMessage({ id: "chat.toolCall.planFile" })}</span>
          <span className="cursor-default rounded-md bg-muted/70 px-2 py-1 font-mono text-on-surface">
            {planFilePath}
          </span>
        </div>
      ) : null}
      <MessageResponse
        className="size-full min-w-0 break-words whitespace-normal [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
        workspacePath={workspacePath}
        theme={theme}
        codePreviewSettings={codePreviewSettings}
        onOpenCodeViewer={onOpenCodeViewer}
        onOpenFileLink={onOpenFileLink}
        onOpenExternalUrl={onOpenBrowserUrl}
      >
        {plan}
      </MessageResponse>
    </div>
  );
}
