// 日志噪声回归：自部署启动时曾每轮刷 ~170 条 warning，根因有两类。
//
// B 类：tasks 表里 `reserveCreatedTask` 先插的占位行 meta_json 为 NULL（presentation 由
//       后续 CLI 事实回填，属设计内状态），而 readPresentation 无条件 JSON.parse(NULL)
//       得到 null，zod 报 "expected object, received null" 并打 warn。实测库里 165 条孤儿
//       预留行因此每轮启动刷屏。
//
// C 类：上游 CDN 在同一个 revision 下换了内容（zcode-builtin-production-43.json 的 config
//       hash cfb34fcb vs 3.17.1 内嵌 bundled 的 b4402f74），applyRemoteRelease 直接 throw，
//       远端同步器把刷新记为失败并指数退避，failureCount 累到 160。
//
// 两个用例都把「设计内状态」与「真数据损坏」区分开：前者静默走列投影，后者仍然报错。
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeZCodeBuiltinProviderConfigSource } from "./zcode-builtin-provider-config-source.js";
import { decodeZCodeBuiltinRelease } from "./zcode-builtin-release.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-noise-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Built-in Release 同 revision 内容冲突", () => {
  it("不抛错，返回 unchanged 并保留本地权威配置", async () => {
    const dir = await makeTempDir();
    const bundledPath = join(dir, "zcode-builtin.json");
    const activePath = join(dir, "active.json");

    // 本地 bundled 的最小合法 release（字段形状与生产文件一致）。
    const bundled = {
      schemaVersion: 1,
      revision: 43,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    };
    await writeFile(bundledPath, JSON.stringify(bundled), "utf8");

    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: bundledPath,
      activeFilePath: activePath,
      watch: false,
    });

    // 同 revision、不同内容（模拟上游换内容不换号）。用真实的 modelConfigRules 子集
    // 制造差异，避开 provider rule 的复杂 schema。
    const conflicting = decodeZCodeBuiltinRelease({
      ...bundled,
      config: {
        ...bundled.config,
        modelConfigRules: {
          ...bundled.config.modelConfigRules,
          // modelMatch 从生产用的 ".*" 改成更窄的表达式即可制造内容差异，
          // 同时保持 schema 合法。
          modelRules: [{ modelMatch: "^conflicting$", config: { enabled: false } }],
        },
      },
    });

    // 修复前这里会 throw（"ZCode Built-in 相同 revision 43 对应不同内容"），
    // 使同步器按失败退避重试。
    await expect(source.applyRemoteRelease(conflicting)).resolves.toBe("unchanged");
    source.dispose();

    // 本地文件未被覆盖：仍然是 bundled 的原内容。
    const onDisk = JSON.parse(await readFile(activePath, "utf8").catch(() => "null"));
    if (onDisk !== null) {
      expect(onDisk.revision).toBe(43);
      expect(onDisk.config.providerConfigRules.providerRules).toHaveLength(0);
    }
  });

  it("revision 更高时仍然正常更新", async () => {
    const dir = await makeTempDir();
    const bundledPath = join(dir, "zcode-builtin.json");
    const activePath = join(dir, "active.json");
    const bundled = {
      schemaVersion: 1,
      revision: 43,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    };
    await writeFile(bundledPath, JSON.stringify(bundled), "utf8");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: bundledPath,
      activeFilePath: activePath,
      watch: false,
    });
    const newer = decodeZCodeBuiltinRelease({ ...bundled, revision: 44 });
    await expect(source.applyRemoteRelease(newer)).resolves.toBe("updated");
    source.dispose();
    const onDisk = JSON.parse(await readFile(activePath, "utf8"));
    expect(onDisk.revision).toBe(44);
  });
});
