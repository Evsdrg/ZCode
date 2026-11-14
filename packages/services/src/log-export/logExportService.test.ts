import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLogExportService } from "./logExportService.js";

/**
 * 自部署日志导出回归：桌面端导出后由文件管理器定位文件、文件留给用户；Web 端 zip 已经
 * 作为下载字节回了浏览器，服务端副本无人使用。若不清理，`~/.zcode/export-log/` 会按每次
 * 140MB+ 无限累积（实测 4 次导出累积 614MB）。
 *
 * 这里直接验证 `cleanup()` 删除的是整个 mkdtemp 输出目录，而不只是 zip 文件——
 * 目录回退路径（zip 写入失败）产生的整棵目录也必须能清掉。
 */
describe("log export service cleanup", () => {
  it("删除 zip 所在的整个导出目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-log-export-test-"));
    const exportDir = await mkdtemp(join(root, "zcode-logs-20260101-000000-"));
    const zipPath = join(exportDir, "zcode-logs-20260101-000000.zip");
    await writeFile(zipPath, "fake zip bytes");

    const service = createLogExportService();
    await service.cleanup(zipPath);

    await expect(access(zipPath)).rejects.toThrow();
    await expect(access(exportDir)).rejects.toThrow();
    // 只删本次导出目录，不能动父目录。
    await expect(access(root)).resolves.toBeUndefined();
  });

  it("目录回退产物同样整体清理", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-log-export-test-"));
    const exportDir = await mkdtemp(join(root, "zcode-logs-20260101-000001-"));
    const directoryPath = join(exportDir, "zcode-logs-20260101-000001");
    await mkdir(directoryPath, { recursive: true });
    await writeFile(join(directoryPath, "app.log"), "log line");

    const service = createLogExportService();
    await service.cleanup(directoryPath);

    await expect(access(directoryPath)).rejects.toThrow();
    await expect(access(exportDir)).rejects.toThrow();
  });

  it("cleanup 幂等：目标不存在时不抛错", async () => {
    const service = createLogExportService();
    await expect(service.cleanup("/tmp/zcode-log-export-does-not-exist/x.zip")).resolves.toBeUndefined();
  });
});
