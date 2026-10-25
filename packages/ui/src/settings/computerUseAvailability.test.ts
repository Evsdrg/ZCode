import { describe, expect, it } from "vitest";

import {
  isComputerUseRemoteOrLinux,
  resolveComputerUseAvailability,
} from "./computerUseAvailability.js";

// Linux 电脑控制接通（阶段 5）：核心是让 availability 判定承认「宿主是本机 Linux 桌面」
// 时 CUA 受支持（自部署 WebUI 由 server-info.hostPlatform==="linux" 推导 isLinuxDesktop）。
describe("resolveComputerUseAvailability — Linux 桌面支持", () => {
  it("无任何桌面标志 → web / unsupported", () => {
    expect(resolveComputerUseAvailability()).toEqual({ kind: "web", supported: false });
  });

  it("isLinuxDesktop → local-linux / supported", () => {
    expect(resolveComputerUseAvailability({ isLinuxDesktop: true })).toEqual({
      kind: "local-linux",
      supported: true,
    });
  });

  it("isMacDesktop → local-macos / supported", () => {
    expect(resolveComputerUseAvailability({ isMacDesktop: true })).toEqual({
      kind: "local-macos",
      supported: true,
    });
  });

  it("isWindowsDesktop → local-windows / supported", () => {
    expect(resolveComputerUseAvailability({ isWindowsDesktop: true })).toEqual({
      kind: "local-windows",
      supported: true,
    });
  });

  it("仅有 isDesktop（无平台细分）→ local-linux / unsupported（保持既有语义）", () => {
    expect(resolveComputerUseAvailability({ isDesktop: true })).toEqual({
      kind: "local-linux",
      supported: false,
    });
  });

  it("远端优先于本地平台：远端 + isLinuxDesktop 仍为 remote / unsupported", () => {
    expect(
      resolveComputerUseAvailability({
        isLinuxDesktop: true,
        remoteTarget: { kind: "ssh" } as never,
      }),
    ).toEqual({ kind: "remote-ssh", supported: false });
  });
});

describe("isComputerUseRemoteOrLinux", () => {
  it("支持的 local-linux 不算 remote/linux（走正常设置 UI）", () => {
    expect(isComputerUseRemoteOrLinux({ kind: "local-linux", supported: true })).toBe(false);
  });

  it("web 不算（是浏览器无桌面，不是 remote/linux 边界）", () => {
    expect(isComputerUseRemoteOrLinux({ kind: "web", supported: false })).toBe(false);
  });

  it("远端算 remote/linux（展示能力边界提示）", () => {
    expect(isComputerUseRemoteOrLinux({ kind: "remote-ssh", supported: false })).toBe(true);
  });
});
