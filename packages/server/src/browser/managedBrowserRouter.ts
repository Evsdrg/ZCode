import { createServiceLogger } from "@zcode/services/node";
import type { BrowserCommandResult } from "@zcode/shared";
import {
  createHeadlessBrowserExecutor,
  type BrowserControlExecutor,
  type BrowserExecutorExecuteInput,
} from "./headlessBrowserExecutor.js";
import type { BrowserExecutorListInput } from "./headlessBrowserRuntime.js";
import type { HeadlessBrowserConfig, ManagedBrowserConfig } from "./headlessBrowserConfig.js";

interface ManagedBrowserEntry {
  browserId: string;
  executor: BrowserControlExecutor;
}

const SELECTION_POLICY =
  "Choose from agent.browsers.list() with get(id), not get('cdp'). Honor the user's browser choice; keep the same ID while continuing a task. For a new unspecified task prefer Chromium when available. Choose Firefox for Firefox-specific or cross-engine checks, or evidence of engine incompatibility. Do not switch for a timeout, fresh kernel, or missing tab alone. After explicit selection use that browser's tabs, not top-level agent.browsers.open(). Browsers do not share login state; do not replay side-effecting actions when switching.";

export function createManagedBrowserRouter(
  entries: readonly ManagedBrowserEntry[],
): BrowserControlExecutor {
  const byId = new Map(entries.map((entry) => [entry.browserId, entry.executor]));
  if (byId.size !== entries.length) throw new Error("Duplicate managed browser ID");
  const logger = createServiceLogger("browser-use:router");
  let disposed = false;
  let shutdownPromise: Promise<void> | undefined;

  const unavailable = (message: string): BrowserCommandResult => ({
    ok: false,
    elapsedMs: 0,
    error: { code: "backend_unavailable", message },
  });

  async function list(input: BrowserExecutorListInput) {
    if (disposed) return [];
    const results = await Promise.allSettled(entries.map((entry) => entry.executor.list(input)));
    if (disposed) return [];
    return results.flatMap((result, index) => {
      if (result.status === "rejected") {
        logger.warn(undefined, "Managed browser discovery failed", {
          browserId: entries[index]!.browserId,
        });
        return [];
      }
      return result.value
        .filter((descriptor) => descriptor.id === entries[index]!.browserId)
        .map((descriptor) => ({
          ...descriptor,
          metadata: { ...descriptor.metadata, selectionPolicy: SELECTION_POLICY },
        }));
    });
  }

  async function execute(input: BrowserExecutorExecuteInput): Promise<BrowserCommandResult> {
    if (disposed) return unavailable("Managed browser router is closed");
    if (!input.browserId || input.browserGeneration === undefined) {
      return unavailable("Select an available browser by ID and generation before executing");
    }
    const executor = byId.get(input.browserId);
    if (!executor) return unavailable("Requested managed browser ID is unavailable");
    try {
      return await executor.execute(input);
    } catch {
      logger.warn(undefined, "Managed browser execution failed", {
        browserId: input.browserId,
        method: input.command.method,
      });
      return {
        ok: false,
        elapsedMs: 0,
        error: { code: "execution_error", message: "Managed browser execution failed" },
      };
    }
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    disposed = true;
    shutdownPromise = (async () => {
      const results = await Promise.allSettled(entries.map((entry) => entry.executor.shutdown()));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected")
          logger.warn(undefined, "Managed browser shutdown failed", {
            browserId: entries[index]!.browserId,
          });
      }
    })();
    return shutdownPromise;
  }

  return { list, execute, shutdown };
}

export function createConfiguredBrowserExecutor(
  config: ManagedBrowserConfig,
  createExecutor: (
    config: HeadlessBrowserConfig,
  ) => BrowserControlExecutor = createHeadlessBrowserExecutor,
): BrowserControlExecutor {
  if (!("engines" in config)) return createExecutor(config);
  return createManagedBrowserRouter(
    config.engines.map((engine) => ({
      browserId: `server-headless-${engine.engine}`,
      executor: createExecutor(engine),
    })),
  );
}
