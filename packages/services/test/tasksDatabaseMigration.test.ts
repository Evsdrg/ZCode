import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { build } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

describe("DB109 App 库统一迁移", () => {
  const databases: DatabaseSync[] = [];
  const open = () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    return db;
  };
  let backupRoot: string;
  beforeEach(async () => {
    backupRoot = await mkdtemp(join(tmpdir(), "zcode-db109-backup-"));
  });
  const migrate = (db: DatabaseSync) =>
    runTasksDatabaseMigrations(db, join(backupRoot, "tasks.sqlite"));
  afterEach(async () => {
    for (const db of databases.splice(0)) db.close();
    await rm(backupRoot, { recursive: true, force: true });
  });

  it("DB109-02/03：任意 Repo 所需八张表一次创建，重开不改账本", async () => {
    const db = open();
    await migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();
    expect(tables.map((row) => row.name)).toEqual([
      "automation_runs",
      "automations",
      "off_peak_tasks",
      "task_group_admissions",
      "task_group_members",
      "task_group_view_node_orders",
      "task_group_workspace_bootstraps",
      "task_groups",
      "tasks",
      "tasks_schema_migration",
    ]);
    const ledger = db.prepare("SELECT * FROM tasks_schema_migration").all();
    expect(ledger).toHaveLength(6);
    await migrate(db);
    expect(db.prepare("SELECT * FROM tasks_schema_migration").all()).toEqual(ledger);
  });

  it("DB109-04/08：旧格式来源明确才转，原列/时间保留，不依赖账号", async () => {
    const db = open();
    await migrate(db);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0002_provider_selection'");
    const insert = db.prepare(
      `INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,provider,thought_level,model_selection) VALUES(?, '* * * * *','正文','ws','/ws',1,2,?,?,?,?)`,
    );
    insert.run("known", "custom:builtin%3Abigmodel-coding-plan:GLM-5.3", "zcode", "high", "null");
    insert.run("unknown", "unknown-model", "zcode", "high", "null");
    insert.run("default", null, null, null, null);
    await migrate(db);
    const known = db.prepare("SELECT * FROM automations WHERE automation_id='known'").get()!;
    expect(JSON.parse(String(known.model_selection))).toEqual({
      providerId: "account:bigmodel-individual-coding-plan",
      modelId: "GLM-5.3",
      options: { reasoningLevel: "high" },
    });
    expect(known).toMatchObject({
      model: "custom:builtin%3Abigmodel-coding-plan:GLM-5.3",
      provider: "zcode",
      thought_level: "high",
      prompt: "正文",
      created_at: 1,
      updated_at: 2,
    });
    expect(
      db.prepare("SELECT model_selection FROM automations WHERE automation_id='unknown'").get()
        ?.model_selection,
    ).toBeNull();
    expect(
      db.prepare("SELECT model_selection FROM automations WHERE automation_id='default'").get()
        ?.model_selection,
    ).toBe("null");
    db.exec("UPDATE automations SET model_selection=NULL WHERE automation_id='known'");
    await migrate(db);
    expect(
      db.prepare("SELECT model_selection FROM automations WHERE automation_id='known'").get()
        ?.model_selection,
    ).toBeNull();
  });

  it("GLM112：新增版本仅规范官方当前选择，旧列、坏值和回滚后缺失不改写", async () => {
    const db = open();
    await migrate(db);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0003_official_glm_selection'");
    const oldLedger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    const cases = [
      [
        "official",
        JSON.stringify({
          providerId: "account:zai-start-plan",
          modelId: "glm-5.3-flash",
          options: { reasoningLevel: "high" },
        }),
      ],
      ["custom", JSON.stringify({ providerId: "personal-proxy", modelId: "glm-5.3-flash" })],
      [
        "offpeak",
        JSON.stringify({ providerId: "account:zai-offpeak-idle-plan", modelId: "glm-5.3-flash" }),
      ],
      ["unknown", JSON.stringify({ providerId: "account:zai-start-plan", modelId: "glm-unknown" })],
      ["broken", "{broken"],
      ["missing", null],
    ] as const;
    const insert =
      db.prepare(`INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,model_selection)
      VALUES(?, '* * * * *', '任务正文', 'remote:ws', '/ws', 1, 2, '旧选择原文', ?)`);
    for (const [id, selection] of cases) insert.run(id, selection);
    await migrate(db);
    expect(
      db
        .prepare(
          "SELECT * FROM tasks_schema_migration WHERE id != '0003_official_glm_selection' ORDER BY id",
        )
        .all(),
    ).toEqual(oldLedger);
    for (const [id, selection] of cases) {
      const row = db.prepare("SELECT * FROM automations WHERE automation_id=?").get(id)!;
      expect(row).toMatchObject({
        prompt: "任务正文",
        model: "旧选择原文",
        created_at: 1,
        updated_at: 2,
      });
      expect(row.model_selection).toBe(
        id === "official" ? selection?.replace("glm-5.3-flash", "GLM-5.3-Flash") : selection,
      );
    }
    const ledger = db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all();
    db.exec("UPDATE automations SET model_selection=NULL WHERE automation_id='official'");
    await expect(migrate(db)).resolves.toBeDefined();
    expect(
      db.prepare("SELECT model_selection FROM automations WHERE automation_id='official'").get()
        ?.model_selection,
    ).toBeNull();
    expect(db.prepare("SELECT * FROM tasks_schema_migration ORDER BY id").all()).toEqual(ledger);
  });

  it("DB109-05/07：SQL 故障不记成功，checksum 错误不重跑", async () => {
    const db = open();
    db.exec("CREATE TABLE automations(automation_id TEXT)");
    await expect(migrate(db)).rejects.toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='tasks_schema_migration'").get(),
    ).toBeUndefined();
    const ready = open();
    await migrate(ready);
    ready.exec("UPDATE tasks_schema_migration SET checksum='broken'");
    await expect(migrate(ready)).rejects.toThrow(/checksum/);
  });

  it("DB109-02/05：部分旧 schema 补列，数据转换中途失败连补列一起回滚", async () => {
    const db = open();
    await migrate(db);
    db.exec(`DELETE FROM tasks_schema_migration;
      ALTER TABLE automations DROP COLUMN model_selection;
      ALTER TABLE automations DROP COLUMN scheduled_run_count;
      INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,provider,run_count)
      VALUES('legacy','* * * * *','旧任务正文','remote:/same','/same',11,12,'p/model','zcode',7);
      CREATE TRIGGER reject_migration BEFORE UPDATE ON automations
      BEGIN SELECT RAISE(ABORT,'injected failure'); END;`);
    await expect(migrate(db)).rejects.toThrow(/injected failure/);
    expect(db.prepare("SELECT * FROM tasks_schema_migration").all()).toEqual([]);
    expect(
      db
        .prepare("PRAGMA table_info(automations)")
        .all()
        .map((row) => row.name),
    ).not.toContain("model_selection");
    db.exec("DROP TRIGGER reject_migration");
    await migrate(db);
    expect(
      db.prepare("SELECT * FROM automations WHERE automation_id='legacy'").get(),
    ).toMatchObject({
      prompt: "旧任务正文",
      workspace_key: "remote:/same",
      workspace_path: "/same",
      created_at: 11,
      updated_at: 12,
      model: "p/model",
      provider: "zcode",
      run_count: 7,
      scheduled_run_count: 7,
      model_selection: JSON.stringify({ providerId: "p", modelId: "model" }),
    });
  });

  it.each([
    [
      "custom:builtin:bigmodel-coding-plan:GLM-5.3",
      "account:bigmodel-individual-coding-plan",
      "GLM-5.3",
      "high",
    ],
    ["custom:proxy:vendor%2Fmodel%3Abeta", "proxy", "vendor/model:beta", "high"],
    ["proxy/vendor/model$low", "proxy", "vendor/model", "low"],
    ["custom:proxy:bad%escape", "proxy", "bad%escape", "high"],
  ])("DB109-04：冻结旧选择编码 %s", async (model, providerId, modelId, reasoningLevel) => {
    const db = open();
    await migrate(db);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0002_provider_selection'");
    db.prepare(`INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,provider,thought_level)
      VALUES('legacy','* * * * *','正文','ws','/ws',1,2,?,'zcode','high')`).run(model);
    await migrate(db);
    const row = db.prepare("SELECT model,model_selection FROM automations").get()!;
    expect(row.model).toBe(model);
    expect(JSON.parse(String(row.model_selection))).toEqual({
      providerId,
      modelId,
      options: { reasoningLevel },
    });
  });

  it("DB109-06：两个独立线程同时打开旧库，数据转换只发生一次", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-db109-concurrent-"));
    const path = join(root, "tasks.sqlite");
    const db = new DatabaseSync(path);
    const workers: Worker[] = [];
    try {
      await migrate(db);
      db.exec(`DELETE FROM tasks_schema_migration;
        INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model)
        VALUES('old','* * * * *','正文','ws','/ws',1,2,'proxy/model');
        CREATE TABLE migration_probe(value INTEGER);
        CREATE TRIGGER count_conversion AFTER UPDATE OF model_selection ON automations
        BEGIN INSERT INTO migration_probe VALUES(1); END;`);
      const compiled = await build({
        entryPoints: [resolve("packages/services/src/session/tasksDatabase/migrations.ts")],
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
        // #src 属于各自 package；全局 alias 会把 shared 的入口错误重定向到 services。
      });
      const gate = new SharedArrayBuffer(4);
      for (let index = 0; index < 2; index++) {
        workers.push(
          new Worker(
            `${compiled.outputFiles[0]!.text}
          const { parentPort, workerData } = require('node:worker_threads');
          const database = new (require('node:sqlite').DatabaseSync)(workerData.path, { timeout: 5000 });
          const gate = new Int32Array(workerData.gate);
          parentPort.postMessage('ready');
          Atomics.wait(gate, 0, 0);
          module.exports.runTasksDatabaseMigrations(database, workerData.path).then(() => database.close());`,
            { eval: true, workerData: { path, gate } },
          ),
        );
      }
      const exits = workers.map((worker) => once(worker, "exit"));
      await Promise.all(workers.map((worker) => once(worker, "message")));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0);
      expect(await Promise.all(exits)).toEqual([[0], [0]]);
      expect(db.prepare("SELECT * FROM tasks_schema_migration").all()).toHaveLength(6);
      expect(db.prepare("SELECT * FROM migration_probe").all()).toHaveLength(1);
      expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  // 2026-10-24 事故回归：闭源旧版创建的 tasks-index 遗留表无类型列且无主键/唯一约束，
  // 0001 adopt 后 writeRecord 的 ON CONFLICT(workspace_key, task_id) 在 prepare 阶段失败，
  // 表现为自部署 WebUI 无法在工程里创建新会话。
  const createLegacyTypelessTables = (db: DatabaseSync) => {
    db.exec(`
      CREATE TABLE tasks ("workspace_key","workspace_path","workspace_identity","task_id","title","task_status","provider","mode","model","migration_source","forked_from_task_id","created_at","updated_at","unread_at","last_unread_at","pinned","archived","deleted","title_overridden","searchable_text","meta_json","cron_automation_id","off_peak_task_id");
      CREATE TABLE task_groups ("group_id","title","color","created_at","updated_at");
      CREATE TABLE task_group_members ("group_id","workspace_key","workspace_path","workspace_identity","task_id","sort_order","added_at","created_at","updated_at");
      CREATE TABLE task_group_view_node_orders ("node_type","node_key","sort_order","created_at","updated_at");
      CREATE TABLE task_group_workspace_bootstraps ("workspace_key","group_id","created_at","updated_at");
      CREATE TABLE automations ("automation_id","title","cron_expr","prompt","model","provider","mode","thought_level","workspace_key","workspace_path","workspace_identity","target_task_id","bot_delivery_target","location_kind","recurring","max_runs","end_at","schedule_rule","schedule_edited_by_user","run_count","scheduled_run_count","enabled","lifecycle_status","next_run_at","last_run_at","running","claimed_at","dispatch_status","dispatch_attempts","retry_at","last_error","created_at","updated_at","model_selection","project_id","host_id","additional_directories");
      CREATE TABLE off_peak_tasks ("off_peak_task_id","server_ticket_id","title","conversation_id","session_id","prompt","permission_mode","model","thought_level","workspace_key","workspace_path","workspace_identity","status","queued_at","started_at","ended_at","failure_reason","files_changed","settled_at","history_deleted_at","registered_at","schedulable","queue_position","next_poll_at","claim_running","claimed_at","attempt_count","last_error","created_at","updated_at","model_selection","project_id","host_id","additional_directories");
    `);
  };

  it("0008：遗留无约束表回填唯一索引后 upsert 可用，重复账本行重跑不重复建", async () => {
    const db = open();
    createLegacyTypelessTables(db);
    await migrate(db);
    const backfilled = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_unique' ORDER BY name",
      )
      .all();
    expect(backfilled.map((row) => row.name)).toEqual([
      "idx_automations_automation_id_unique",
      "idx_off_peak_tasks_off_peak_task_id_unique",
      "idx_task_group_members_workspace_key_task_id_unique",
      "idx_task_group_view_node_orders_node_type_node_key_unique",
      "idx_task_group_workspace_bootstraps_workspace_key_unique",
      "idx_task_groups_group_id_unique",
      "idx_tasks_workspace_key_task_id_unique",
    ]);
    const upsert = db.prepare(
      `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at)
       VALUES ('ws', '/ws', 't1', '标题', 1, 1)
       ON CONFLICT(workspace_key, task_id) DO UPDATE SET title = excluded.title`,
    );
    upsert.run();
    upsert.run();
    expect(db.prepare("SELECT title FROM tasks").get()?.title).toBe("标题");
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0008_legacy_unique_constraints'");
    await migrate(db);
    expect(
      db
        .prepare(
          "SELECT count(*) AS total FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_unique'",
        )
        .get(),
    ).toMatchObject({ total: 7 });
  });

  it("0008：新库由主键满足约束，不额外建冗余唯一索引", async () => {
    const db = open();
    await migrate(db);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_unique'")
        .all(),
    ).toEqual([]);
    db.exec("DELETE FROM tasks_schema_migration WHERE id='0008_legacy_unique_constraints'");
    await migrate(db);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%_unique'")
        .all(),
    ).toEqual([]);
  });

  it("0008：遗留表存在重复行时 fail-closed，不写账本不动数据", async () => {
    const db = open();
    createLegacyTypelessTables(db);
    db.exec(
      `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, created_at, updated_at)
       VALUES ('ws', '/ws', 'dup', 'a', 1, 1), ('ws', '/ws', 'dup', 'b', 2, 2)`,
    );
    await expect(migrate(db)).rejects.toThrow(/Legacy unique constraint backfill failed on tasks/);
    // 整个迁移事务回滚：全新库连账本表都不落盘，重复行原样保留。
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='tasks_schema_migration'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT count(*) AS total FROM tasks WHERE task_id='dup'").get(),
    ).toMatchObject({
      total: 2,
    });
  });
});
