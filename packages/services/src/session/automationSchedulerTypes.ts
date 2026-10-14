// automation / off-peak 调度消息类型（端口契约）。
// 独立成模块，供 automationScheduler 与 automationOffPeakScheduler 共享，避免循环依赖。
import type { ModelSelection, ZCodeTaskMode } from "@zcode/shared";
import type { OffPeakDispatchResult } from "./automationOffPeakSettlement.js";

export interface AutomationDispatchRequest {
  type: "automation";
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface AutomationDispatchResult {
  runId: string;
  ok: boolean;
  taskId?: string;
  sessionId?: string;
  error?: string;
  failureKind?: "transient" | "permanent";
}

export interface OffPeakDispatchRequest {
  type: "offpeak";
  offPeakTaskId: string;
  prompt: string;
  permissionMode: string;
  modelSelection: ModelSelection;
  conversationId?: string;
  sessionId?: string;
  serverTicketId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

export type OffPeakDispatchResultMessage = OffPeakDispatchResult;
