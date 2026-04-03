export type ExecutionEventType =
  | "start"
  | "queued"
  | "stdout"
  | "stderr"
  | "complete"
  | "error"
  | "permission-request"
  | "permission-response"
  | "stream-text"
  | "tool-use";

export interface ExecutionEvent {
  executionId: string;
  channelId: string;
  chatId: string;
  type: ExecutionEventType;
  timestamp: number;
  threadId?: number;
  payload?: {
    text?: string;
    code?: number | null;
    reason?: string;
    response?: string;
    agentName?: string;

    // Permission request/response fields
    toolName?: string;
    toolInput?: Record<string, unknown>;
    permissionRequestId?: string;
    decision?: "allow" | "deny";

    // Streaming fields
    sessionId?: string;

    // Source message metadata (e.g. for reactions)
    messageId?: number;
  };
}
