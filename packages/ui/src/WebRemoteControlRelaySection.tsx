import { memo, useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import type { IWebRemoteControlRelayService, WebRemoteControlRelayStatus } from "@zcode/services";
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  MonitorSmartphone,
  RefreshCwIcon,
  Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import {
  resolveRelayPrimaryAction,
  resolveRelayStateLabelId,
  resolveRelayStatusTone,
  shouldRenderRelayQrCode,
} from "@/webRemoteControlRelayUi.js";

const STATUS_POLL_INTERVAL_MS = 3000;

const TONE_CLASS: Record<string, string> = {
  neutral: "text-foreground-subtle",
  loading: "text-foreground-subtle",
  success: "text-primary",
  danger: "text-destructive",
};

/**
 * 「官方中转远程控制」区块：状态投影 + 开关/重试/重置配对命令。
 * 连接事实的唯一所有者是服务端 relay service；本组件仅轮询 getStatus 做展示。
 */
export const WebRemoteControlRelaySection = memo(function WebRemoteControlRelaySection({
  service,
}: {
  service: IWebRemoteControlRelayService;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [status, setStatus] = useState<WebRemoteControlRelayStatus | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const next = await service.getStatus();
      setStatus(next);
    } catch (error) {
      logger.warn("[WebRemoteControlRelaySection] 读取远控状态失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [service]);

  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => void refreshStatus(), STATUS_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  useEffect(() => {
    let cancelled = false;
    if (!shouldRenderRelayQrCode(status)) {
      setQrDataUrl(null);
      setPairingUrl(null);
      return;
    }
    void (async () => {
      try {
        const info = await service.getPairingInfo();
        if (!info || cancelled) return;
        setPairingUrl(info.qrUrl);
        const dataUrl = await QRCode.toDataURL(info.qrUrl, {
          margin: 1,
          width: 220,
          color: { dark: "#000000", light: "#ffffff" },
        });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch (error) {
        logger.warn("[WebRemoteControlRelaySection] 生成配对二维码失败", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [service, status?.enabled, status?.state]);

  const handlePrimaryAction = useCallback(async () => {
    const action = resolveRelayPrimaryAction(status);
    if (!action || busy) return;
    setBusy(true);
    try {
      if (action === "enable" || action === "retry") {
        setStatus(await service.setEnabled(true));
      } else {
        setStatus(await service.setEnabled(false));
      }
    } catch (error) {
      logger.warn("[WebRemoteControlRelaySection] 远控开关操作失败", {
        action,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, service, status]);

  const handleResetPairing = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      setStatus(await service.resetPairing());
      setQrDataUrl(null);
      setPairingUrl(null);
    } catch (error) {
      logger.warn("[WebRemoteControlRelaySection] 重置配对失败", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }, [busy, service]);

  /** 配对链接不挑端：手机扫码与桌面浏览器直接打开是同一条 terminal 连接。 */
  const handleCopyLink = useCallback(() => {
    if (!pairingUrl) return;
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(intl.formatMessage({ id: "webRemoteControl.relay.copyFailed" }));
      return;
    }
    void navigator.clipboard.writeText(pairingUrl).then(
      () => {
        setLinkCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setLinkCopied(false), 1500);
      },
      () => toast(intl.formatMessage({ id: "webRemoteControl.relay.copyFailed" })),
    );
  }, [intl, pairingUrl]);

  const handleOpenInBrowser = useCallback(() => {
    if (!pairingUrl) return;
    platform.openExternal(pairingUrl);
  }, [pairingUrl, platform]);

  const primaryAction = resolveRelayPrimaryAction(status);
  const enabled = Boolean(status?.enabled);

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-start gap-2">
        <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "webRemoteControl.relay.title" })}
            </span>
            <span
              className={`text-ui-base/relaxed font-medium ${TONE_CLASS[resolveRelayStatusTone(status)]}`}
            >
              {intl.formatMessage({ id: resolveRelayStateLabelId(status) })}
            </span>
          </div>
          <p className="text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "webRemoteControl.relay.description" })}
          </p>
        </div>
      </div>

      {shouldRenderRelayQrCode(status) ? (
        <div className="mb-3 flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={intl.formatMessage({ id: "webRemoteControl.relay.qrAlt" })}
              className="size-[180px] shrink-0 rounded-md border border-border bg-white p-1.5"
            />
          ) : (
            <div className="flex size-[180px] shrink-0 items-center justify-center rounded-md border border-border">
              <RefreshCwIcon className="size-6 animate-spin text-foreground-subtle" />
            </div>
          )}
          <div className="flex w-full min-w-0 flex-col items-center gap-1.5 text-center">
            <div className="flex items-center gap-1.5 text-ui-base font-medium text-foreground">
              <Smartphone className="size-3.5 shrink-0" />
              {intl.formatMessage({ id: "webRemoteControl.relay.qrPrompt" })}
            </div>
            <p className="text-ui-base/relaxed text-foreground-subtle">
              {intl.formatMessage({ id: "webRemoteControl.relay.privacyNote" })}
            </p>
            <p className="text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "webRemoteControl.relay.experimentalNote" })}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!pairingUrl}
                onClick={handleCopyLink}
                data-testid="relay-copy-link"
              >
                {linkCopied ? (
                  <CheckIcon className="size-3.5" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
                {intl.formatMessage({
                  id: linkCopied
                    ? "webRemoteControl.relay.linkCopied"
                    : "webRemoteControl.relay.copyLink",
                })}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!pairingUrl}
                onClick={handleOpenInBrowser}
                data-testid="relay-open-in-browser"
              >
                <ExternalLinkIcon className="size-3.5" />
                {intl.formatMessage({ id: "webRemoteControl.relay.openInBrowser" })}
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <p className="mb-3 text-ui-base/relaxed text-foreground-subtle">
          {intl.formatMessage({ id: "webRemoteControl.relay.privacyNote" })}
        </p>
      )}

      {status?.state === "error" && status.errorCode ? (
        <p className="mb-3 text-ui-base/relaxed text-destructive" data-testid="relay-error-code">
          {intl.formatMessage({ id: "webRemoteControl.relay.errorPrefix" })}
          {status.errorCode}
          {status.errorMessage ? `: ${status.errorMessage}` : ""}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {primaryAction ? (
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void handlePrimaryAction()}
            data-testid="relay-primary-action"
          >
            {intl.formatMessage({
              id:
                primaryAction === "enable"
                  ? "webRemoteControl.relay.enable"
                  : primaryAction === "retry"
                    ? "webRemoteControl.relay.retry"
                    : "webRemoteControl.relay.disable",
            })}
          </Button>
        ) : null}
        {enabled ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void handleResetPairing()}
            data-testid="relay-reset-pairing"
          >
            {intl.formatMessage({ id: "webRemoteControl.relay.resetPairing" })}
          </Button>
        ) : null}
      </div>
    </section>
  );
});
