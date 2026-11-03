// B 类日志噪声回归：`reserveCreatedTask` 先于 CLI 首发插入的归属占位行不写 meta_json，
// 这是设计内状态（presentation 由后续 CLI 事实回填）。但 readPresentation 无条件
// JSON.parse(row.meta_json)，NULL 被解析为 null，zod 报 "expected object, received null"
// 并打 warn —— 实测库里 165 条孤儿预留行使每次启动刷 170 条。
//
// 本用例断言：NULL / 空串 meta_json 的占位行静默走列投影（不刷 warn、不抛错），
// 而有内容但格式损坏的 meta_json 仍然照旧告警（真数据问题不能被掩盖）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loggerWarn = vi.fn();

// taskIndexRepo 用的是 #src/logger/serviceLogger.js 的 createServiceLogger，
// mock 必须命中真实导入路径。
vi.mock("#src/logger/serviceLogger.js", () => ({
  createServiceLogger: () => ({
    warn: (...args: unknown[]) => loggerWarn(...args),
    info: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

const tempDirs: string[] = [];

async function makeRepo(): Promise<{ repo: import("../taskIndexRepo.js").TaskIndexRepo; dbPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-index-"));
  tempDirs.push(dir);
  const dbPath = join(dir, "tasks-index.sqlite");
  const { TaskIndexRepo } = await import("../src/session/taskIndexRepo.js");
  const repo = new TaskIndexRepo(undefined, "local", dbPath);
  await repo.ensureReady();
  return { repo, dbPath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  loggerWarn.mockReset();
});

describe("task index 占位行 meta_json", () => {
  it("meta_json 为 NULL 的占位行不产生 warn", async () => {
    const { repo, dbPath } = await makeRepo();
    const db = await repo.getOrganizationDatabase();
    // 直接插一条 reserveCreatedTask 形态的占位行：有归属列，meta_json 为 NULL。
    db.prepare(
      `INSERT INTO tasks(workspace_key, workspace_path, task_id, created_at, updated_at, host_id, root_path, handoff_pending)
       VALUES(?,?,?,0,0,?,?,?)`,
    ).run(
      "/tmp/ws",
      "/tmp/ws",
      "session_placeholder_null",
      "local",
      "/tmp/ws",
      1,
    );

    const metas = await repo.listTaskMetas({ workspacePath: "/tmp/ws", includeDeleted: true });
    // 该行没有 cli_created_at，listTaskMetas 会过滤掉；改用 reconcile 入口确认没 warn。
    expect(metas).toEqual([]);
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("meta_json 损坏（非空）仍然告警，不被静默吞掉", async () => {
    const { repo } = await makeRepo();
    const db = await repo.getOrganizationDatabase();
    db.prepare(
      `INSERT INTO tasks(workspace_key, workspace_path, task_id, created_at, updated_at, host_id, root_path, handoff_pending, meta_json)
       VALUES(?,?,?,0,0,?,?,?,?)`,
    ).run(
      "/tmp/ws2",
      "/tmp/ws2",
      "session_broken_meta",
      "local",
      "/tmp/ws2",
      1,
      "{not-json",
    );

    await repo.listReconciliationRows({ workspacePath: "/tmp/ws2" });
    expect(loggerWarn).toHaveBeenCalled();
  });
});
