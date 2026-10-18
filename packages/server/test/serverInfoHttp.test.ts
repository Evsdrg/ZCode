import { afterEach, describe, expect, it } from "vitest";
import { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceCollection } from "@zcode/services";
import { SERVER_REMOTE_PROTOCOL_VERSION } from "@zcode/shared";
import { createHttpServer } from "../src/http.js";

describe("server info HTTP endpoint", () => {
  const servers: Array<{ close(callback?: (err?: Error) => void): void }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error?: Error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            });
          }),
      ),
    );
    servers.length = 0;
    await Promise.all(tempDirs.map((dir) => rm(dir, { force: true, recursive: true })));
    tempDirs.length = 0;
  });

  it("returns desktop connector bootstrap metadata", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      serverId: "studio",
      name: "Studio Server",
      workspaces: [
        {
          path: "/srv/zcode/project",
          label: "project",
        },
      ],
    });
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      serverId: "studio",
      name: "Studio Server",
      version: expect.any(String),
      protocolVersion: SERVER_REMOTE_PROTOCOL_VERSION,
      authRequired: false,
      compatibility: {
        schemaVersion: 1,
        productVersion: expect.any(String),
        minCompatibleVersion: expect.any(String),
      },
      migration: { failedPathCount: 0 },
      identity: { osUser: expect.any(String), hostname: expect.any(String) },
      workspaces: [
        {
          path: "/srv/zcode/project",
          label: "project",
        },
      ],
      capabilities: {
        desktopContinuous: true,
        websocketRpc: true,
        processResourceTelemetry: true,
      },
    });
  });

  it("announces virtual projects only for an initialized owner host", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      serverId: "owner",
      virtualProjects: true,
      migrationFailedPathCount: 2,
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/server-info`);
    expect(await response.json()).toMatchObject({
      serverId: "owner",
      capabilities: { virtualProjects: true },
      migration: { failedPathCount: 2 },
    });
  });

  it("requires the lite token for protected API routes", async () => {
    const server = createHttpServer(new ServiceCollection(), 0, {
      authToken: "secret-token",
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const rejected = await fetch(`${baseUrl}/api/server-info`);
    expect(rejected.status).toBe(401);

    const accepted = await fetch(`${baseUrl}/api/server-info?token=secret-token`);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toContain("zcode_lite_token=");

    const cookieAccepted = await fetch(`${baseUrl}/api/server-info`, {
      headers: {
        cookie: "zcode_lite_token=secret-token",
      },
    });
    expect(cookieAccepted.status).toBe(200);

    const capabilityRejected = await fetch(`${baseUrl}/api/rpc-host-capability`, {
      method: "POST",
    });
    expect(capabilityRejected.status).toBe(401);
    const capabilityAccepted = await fetch(
      `${baseUrl}/api/rpc-host-capability?token=secret-token`,
      { method: "POST" },
    );
    expect(capabilityAccepted.status).toBe(200);
    await expect(capabilityAccepted.json()).resolves.toMatchObject({
      capability: expect.any(String),
      expiresAt: expect.any(Number),
    });
  });

  it("does not expose either retired remote-connect route", async () => {
    const server = createHttpServer(new ServiceCollection(), 0);
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/api/connect-remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(404);
    const websocketUpgradeRoute = await fetch(
      `http://127.0.0.1:${address.port}/ws/remote/retired-session`,
    );
    expect(websocketUpgradeRoute.status).toBe(404);
  });

  it("serves static web files with SPA fallback", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-lite-static-"));
    tempDirs.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<html>lite</html>", "utf8");
    await writeFile(join(staticRoot, "app.js"), "console.log('lite');", "utf8");

    const server = createHttpServer(new ServiceCollection(), 0, {
      staticRoot,
      spaFallback: true,
    });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const asset = await fetch(`${baseUrl}/app.js`);
    expect(asset.status).toBe(200);
    // 不同静态资源适配器使用两种合法 JS MIME；断言资源可执行类型而非库版本拼写。
    expect(asset.headers.get("content-type")).toMatch(/^(?:text|application)\/javascript(?:;|$)/);
    await expect(asset.text()).resolves.toBe("console.log('lite');");

    const fallback = await fetch(`${baseUrl}/workspace/deep/link`);
    expect(fallback.status).toBe(200);
    expect(fallback.headers.get("content-type")).toContain("text/html");
    await expect(fallback.text()).resolves.toBe("<html>lite</html>");

    const apiFallback = await fetch(`${baseUrl}/api/missing`);
    expect(apiFallback.status).toBe(404);
  });

  it("compresses large static assets when the client accepts compression", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-lite-static-gzip-"));
    tempDirs.push(staticRoot);
    // 超过压缩阈值，内容可压缩。
    const payload = "console.log('zcode compression probe');\n".repeat(200);
    await writeFile(join(staticRoot, "bundle.js"), payload, "utf8");
    await writeFile(join(staticRoot, "small.js"), "1;\n", "utf8");

    const server = createHttpServer(new ServiceCollection(), 0, { staticRoot });
    servers.push(server);
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const gzipped = await fetch(`${baseUrl}/bundle.js`, {
      headers: { "accept-encoding": "gzip" },
    });
    expect(gzipped.status).toBe(200);
    expect(gzipped.headers.get("content-encoding")).toBe("gzip");
    expect(gzipped.headers.get("vary")).toBe("Accept-Encoding");
    // undici 会按 content-encoding 自动解压，正文必须与原文一致。
    await expect(gzipped.text()).resolves.toBe(payload);

    const brotli = await fetch(`${baseUrl}/bundle.js`, {
      headers: { "accept-encoding": "br, gzip" },
    });
    expect(brotli.headers.get("content-encoding")).toBe("br");
    await expect(brotli.text()).resolves.toBe(payload);

    const plain = await fetch(`${baseUrl}/bundle.js`, {
      headers: { "accept-encoding": "identity" },
    });
    expect(plain.headers.get("content-encoding")).toBeNull();
    await expect(plain.text()).resolves.toBe(payload);

    // 小于阈值的文件即使客户端支持压缩也原样返回。
    const small = await fetch(`${baseUrl}/small.js`, {
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(small.headers.get("content-encoding")).toBeNull();
    await expect(small.text()).resolves.toBe("1;\n");
  });

  it("does not compress binary static assets", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "zcode-lite-static-bin-"));
    tempDirs.push(staticRoot);
    // 未压缩但体积超过阈值的二进制内容；.png 不在可压缩列表内。
    await writeFile(join(staticRoot, "image.png"), Buffer.alloc(4096, 0x89));

    const server = createHttpServer(new ServiceCollection(), 0, { staticRoot });
    servers.push(server);
    const address = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${address.port}/image.png`, {
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-type")).toBe("image/png");
  });
});
