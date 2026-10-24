import { TASK_GROUP_ADMISSIONS_SQL } from "#src/task-groups/migration-v6.js";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { databaseMigrationIdSchema, type DatabaseMigrationFacts } from "@zcode/shared";
import type { DatabaseSync } from "node:sqlite";
import { sqliteMigrations, type SqliteMigration } from "@zcode/shared/sqlite-migrations";
import {
  AUTOMATION_SCHEMA,
  OFF_PEAK_SCHEMA,
  TASK_INDEX_SCHEMA,
} from "#src/session/tasksDatabase/schema-v1.js";
import { importLegacyAutomationSelections } from "#src/session/tasksDatabase/provider-selection-v2.js";
import { OFFICIAL_GLM_SELECTION_MIGRATION_SQL } from "#src/session/tasksDatabase/official-glm-selection-v3.js";
import { CONTROLLER_REMOTE_SCHEMA_SQL } from "#src/session/tasksDatabase/controller-remote-schema-v4.js";
import {
  adoptSourceServerWorkspaceSchema,
  SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT,
} from "#src/session/tasksDatabase/source-server-schema-v5.js";

// 闭源旧版（开源仓库发布前）创建的 tasks-index 遗留表是无类型列且不带任何主键/唯一约束；
// 0001 的 adopt 用 CREATE TABLE IF NOT EXISTS 接管，对已存在的表补不上约束，导致
// writeRecord 等按 ON CONFLICT(workspace_key, task_id) 形态 upsert 的语句在 prepare 阶段
// 直接抛 "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"（2026-10-24
// 自部署实例新会话创建失败的根因）。本清单把 schema-v1 已声明、遗留库缺失的唯一约束以
// 唯一索引形式回填；字段与 v1 主键一一对应，不再随运行态 schema 变化。
const legacyUniqueConstraints = [
  { table: "tasks", columns: ["workspace_key", "task_id"] },
  { table: "task_groups", columns: ["group_id"] },
  { table: "task_group_members", columns: ["workspace_key", "task_id"] },
  { table: "task_group_view_node_orders", columns: ["node_type", "node_key"] },
  { table: "task_group_workspace_bootstraps", columns: ["workspace_key"] },
  { table: "automations", columns: ["automation_id"] },
  { table: "off_peak_tasks", columns: ["off_peak_task_id"] },
] as const;

// 已存在等价唯一约束（含主键 autoindex）时跳过，新库不会多出冗余索引。
function ensureLegacyUniqueConstraints(db: DatabaseSync): void {
  for (const { table, columns } of legacyUniqueConstraints) {
    const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as {
      name: string;
      unique: number;
      partial: number;
    }[];
    const satisfied = indexes.some((index) => {
      if (!index.unique || index.partial) return false;
      const indexColumns = db.prepare(`PRAGMA index_info("${index.name}")`).all() as {
        name: string;
      }[];
      return (
        indexColumns.length > 0 &&
        indexColumns.length === columns.length &&
        columns.every((column, position) => indexColumns[position]!.name === column)
      );
    });
    if (satisfied) continue;
    const indexName = `idx_${table}_${columns.join("_")}_unique`;
    try {
      db.exec(`CREATE UNIQUE INDEX ${indexName} ON ${table}(${columns.join(", ")})`);
    } catch (error) {
      // 重复行时 fail-closed：迁移失败由 runner 用表级备份恢复；不允许静默跳过把
      // upsert 写路径留在不可用状态。
      throw Object.assign(
        new Error(
          `Legacy unique constraint backfill failed on ${table}(${columns.join(", ")}): ${String(error)}`,
        ),
        { cause: error },
      );
    }
  }
}

// 冻结历史列声明，不能以实时 Repo/schema 代替，否则新版构建会改变已应用 checksum。
const columns = [
  ["tasks", "title_overridden", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "last_unread_at", "INTEGER NOT NULL DEFAULT 0"],
  ["tasks", "searchable_text", "TEXT NOT NULL DEFAULT ''"],
  ["tasks", "cron_automation_id", "TEXT"],
  ["tasks", "off_peak_task_id", "TEXT"],
  ["automations", "target_task_id", "TEXT"],
  ["automations", "bot_delivery_target", "TEXT"],
  ["automations", "mode", "TEXT"],
  ["automations", "end_at", "INTEGER"],
  ["automations", "schedule_rule", "TEXT"],
  ["automations", "schedule_edited_by_user", "INTEGER NOT NULL DEFAULT 0"],
  ["automations", "thought_level", "TEXT"],
  ["automations", "model_selection", "TEXT"],
  ["automations", "scheduled_run_count", "INTEGER NOT NULL DEFAULT 0"],
  ["automation_runs", "model_selection", "TEXT"],
  ["off_peak_tasks", "thought_level", "TEXT"],
  ["off_peak_tasks", "model_selection", "TEXT"],
  ["off_peak_tasks", "history_deleted_at", "INTEGER"],
] as const;
const indexes = `
  CREATE INDEX IF NOT EXISTS idx_tasks_cron_automation ON tasks(cron_automation_id, updated_at DESC)
    WHERE cron_automation_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_tasks_off_peak_task ON tasks(off_peak_task_id, updated_at DESC)
    WHERE off_peak_task_id IS NOT NULL AND deleted=0;
  CREATE INDEX IF NOT EXISTS idx_automations_target_task ON automations(target_task_id) WHERE target_task_id IS NOT NULL;
`;
const terminalStatuses = "'completed','failed','cancelled'";
const activePredicate = `session_id IS NOT NULL AND status NOT IN (${terminalStatuses})`;
const boundIndex = `CREATE UNIQUE INDEX IF NOT EXISTS idx_off_peak_bound_active ON off_peak_tasks(workspace_key,session_id) WHERE ${activePredicate}`;
const executionColumns = [
  ["automations", "project_id"],
  ["automations", "host_id"],
  ["automations", "additional_directories"],
  ["off_peak_tasks", "project_id"],
  ["off_peak_tasks", "host_id"],
  ["off_peak_tasks", "additional_directories"],
] as const;

// 与 Agent 同样是库级串行事务，但不跨域依赖其具体 adapter。TS 转换使用冻结语义版本，
// 禁用 function.toString 哈希：Electron/SEA 打包会改变函数文本而非迁移语义。
const definitions = [
  {
    id: "0001_adopt_task_schema",
    touchedTables: [
      "tasks",
      "task_groups",
      "task_group_members",
      "task_group_view_node_orders",
      "task_group_workspace_bootstraps",
      "automations",
      "automation_runs",
      "off_peak_tasks",
    ],
    apply: adoptSchema,
    checksumInput: [
      TASK_INDEX_SCHEMA,
      AUTOMATION_SCHEMA,
      OFF_PEAK_SCHEMA,
      columns,
      indexes,
      boundIndex,
      "scheduled-count-backfill-v1",
    ],
  },
  {
    id: "0002_provider_selection",
    touchedTables: ["automations"],
    apply: importLegacyAutomationSelections,
    checksumInput: ["legacy-automation-selection-v1", "no-provider-for-legacy-off-peak-v1"],
  },
  {
    id: "0003_official_glm_selection",
    touchedTables: ["automations"],
    apply: (db: DatabaseSync) => db.exec(OFFICIAL_GLM_SELECTION_MIGRATION_SQL),
    checksumInput: [OFFICIAL_GLM_SELECTION_MIGRATION_SQL],
  },
  {
    id: "0004_project_execution_scopes",
    touchedTables: ["automations", "off_peak_tasks"],
    checksumInput: [executionColumns, "nullable-text-v1"],
    apply: (db: DatabaseSync) => {
      // 原因：调度器可独立打开 Repo，不能等待项目归属转换，也不能把新列写进上游冻结 schema。
      for (const [table, column] of executionColumns) {
        if (
          !db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .some((entry) => entry.name === column)
        )
          db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
      }
    },
  },
  {
    id: "0006_task_group_admissions",
    touchedTables: ["task_group_admissions"],
    checksumInput: [TASK_GROUP_ADMISSIONS_SQL],
    apply: (db: DatabaseSync) => db.exec(TASK_GROUP_ADMISSIONS_SQL),
  },
  {
    id: "0008_legacy_unique_constraints",
    touchedTables: [
      "tasks",
      "task_groups",
      "task_group_members",
      "task_group_view_node_orders",
      "task_group_workspace_bootstraps",
      "automations",
      "off_peak_tasks",
    ],
    // checksumInput 必须冻结：legacyUniqueConstraints 变动等同改写历史迁移。
    checksumInput: [
      legacyUniqueConstraints.map(({ table, columns }) => `${table}(${columns.join(",")})`),
      "legacy-unique-backfill-v1",
    ],
    apply: ensureLegacyUniqueConstraints,
  },
] as const;

export type TasksDatabaseMigrationScope = "base" | "controller-remote" | "source-server";

interface TasksDatabaseMigrationOptions {
  scope?: TasksDatabaseMigrationScope;
  dbPath?: string;
  transactionOpen?: boolean;
  migration?: DatabaseMigrationFacts;
  onProgress?: (phase: "migrating" | "committing", migration: DatabaseMigrationFacts) => void;
}

function prepareMigrations(scope: TasksDatabaseMigrationScope) {
  // 两端专属表仍归同库账本协调，不会为另一端创建无关表。
  const migrations =
    scope === "base"
      ? definitions
      : scope === "controller-remote"
        ? [
            {
              id: "0004_controller_remote_identity",
              checksumInput: [CONTROLLER_REMOTE_SCHEMA_SQL],
              touchedTables: ["controller_remote_identity_migrations"],
              apply: (db: DatabaseSync) => db.exec(CONTROLLER_REMOTE_SCHEMA_SQL),
            },
          ]
        : [
            {
              id: "0005_source_server_workspace_schema",
              checksumInput: SOURCE_SERVER_SCHEMA_CHECKSUM_INPUT,
              touchedTables: [
                "workspace_alias",
                "workspace_migration_schema_version",
                "workspace_migration_ledger",
                "workspace_migration_conflicts",
                "workspace_migration_ledger_v2",
                "workspace_migration_conflicts_v2",
              ],
              apply: adoptSourceServerWorkspaceSchema,
            },
          ];
  return migrations.map((migration) => ({
    id: migration.id,
    appVersion: "3.12.0",
    sql: JSON.stringify(migration.checksumInput),
    touchedTables: migration.touchedTables,
    apply: migration.apply,
    checksum: createHash("sha256").update(JSON.stringify(migration.checksumInput)).digest("hex"),
  }));
}

export async function runTasksDatabaseMigrations(
  db: DatabaseSync,
  scopeOrOptions: string | TasksDatabaseMigrationOptions = "base",
) {
  const options: TasksDatabaseMigrationOptions =
    typeof scopeOrOptions === "string"
      ? ["base", "controller-remote", "source-server"].includes(scopeOrOptions)
        ? { scope: scopeOrOptions as TasksDatabaseMigrationScope }
        : { dbPath: scopeOrOptions }
      : scopeOrOptions;
  const scope = options.scope ?? "base";
  const migrations = prepareMigrations(scope);
  if (!options.transactionOpen && areTasksDatabaseMigrationsApplied(db, scope))
    return { applied: [], backupSkipped: false };
  const facts = options.migration ?? {
    kind: inspectTasksMigrationKind(db, scope),
    executedCount: 0,
    committedCount: 0,
  };
  const path =
    options.dbPath ??
    String(
      db
        .prepare("pragma database_list")
        .all()
        .find((row) => row.name === "main")?.file ?? ":memory:",
    );
  const directory = dirname(path);
  const dataRoot = basename(directory) === "v2" ? dirname(directory) : directory;
  let currentMigrationId: string | undefined;
  try {
    const result = await sqliteMigrations.migrate(db, migrations, {
      database: "tasks_schema",
      journalTable: "tasks_schema_migration",
      backupDirectories: [join(dataRoot, "backup")],
      transactionOpen: options.transactionOpen,
      onBeforeApply: (id) => {
        currentMigrationId = id;
        if (facts.kind === "none") facts.kind = "upgrade";
        if (facts.lastAppliedMigrationId === undefined) {
          const baseline = db
            .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
            .get();
          facts.lastAppliedMigrationId = baseline
            ? databaseMigrationIdSchema.safeParse(baseline.id).data
            : null;
        }
        options.onProgress?.("migrating", { ...facts });
      },
      onApplied: () => {
        facts.executedCount++;
      },
      onCommitting: () => {
        if (facts.lastAppliedMigrationId === undefined) {
          const baseline = db
            .prepare("SELECT id FROM tasks_schema_migration ORDER BY id DESC LIMIT 1")
            .get();
          facts.lastAppliedMigrationId = baseline
            ? databaseMigrationIdSchema.safeParse(baseline.id).data
            : null;
        }
        options.onProgress?.("committing", { ...facts });
      },
    });
    facts.committedCount = facts.executedCount;
    return result;
  } catch (error) {
    if (error && typeof error === "object" && currentMigrationId)
      Object.assign(error, { migrationId: currentMigrationId });
    throw error;
  }
}

function isMigrationApplied(db: DatabaseSync, id: string, checksum: string): boolean {
  const applied = db.prepare("SELECT checksum FROM tasks_schema_migration WHERE id=?").get(id);
  if (!applied) return false;
  if (applied.checksum !== checksum)
    throw Object.assign(new Error(`Task database migration checksum mismatch: ${id}`), {
      kind: "checksum_mismatch",
      migrationId: id,
    });
  return true;
}

/** 交接只复用已完成初始化；每个新连接按冻结账本确认，替换/清空文件不能假 ready。 */
export function areTasksDatabaseMigrationsApplied(
  db: DatabaseSync,
  scope: TasksDatabaseMigrationScope = "base",
): boolean {
  if (
    !db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
      .get()
  )
    return false;
  return prepareMigrations(scope).every(({ id, checksum }) => isMigrationApplied(db, id, checksum));
}

/** 只读账本的展示预检，不授权执行；runner 拿锁后仍复查每一项。 */
export function inspectTasksMigrationKind(
  db: DatabaseSync,
  scope: TasksDatabaseMigrationScope = "base",
): DatabaseMigrationFacts["kind"] {
  const hasLedger = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_schema_migration'")
    .get();
  let pending = false;
  for (const { id, checksum } of prepareMigrations(scope)) {
    if (!hasLedger || !isMigrationApplied(db, id, checksum)) pending = true;
  }
  if (!pending) return "none";
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('tasks_schema_migration', 'sqlite_sequence') LIMIT 1",
    )
    .get()
    ? "upgrade"
    : "initialize";
}

function adoptSchema(db: DatabaseSync): void {
  db.exec(TASK_INDEX_SCHEMA + AUTOMATION_SCHEMA + OFF_PEAK_SCHEMA);
  for (const [table, column, definition] of columns) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some((entry) => entry.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    if (table === "automations" && column === "scheduled_run_count") {
      db.exec("UPDATE automations SET scheduled_run_count=run_count");
    }
  }
  db.exec(indexes);
  // 沿用已裁决的旧重复绑定保留策略，但不再吞掉权限/语法/磁盘等真实 SQL 错误。
  const duplicate = db
    .prepare(`SELECT 1 FROM off_peak_tasks WHERE ${activePredicate}
    GROUP BY workspace_key, session_id HAVING count(*)>1 LIMIT 1`)
    .get();
  if (!duplicate) db.exec(boundIndex);
}
