import { EventBus } from "../../events/eventBus";

export interface AgentSession {
  readonly sessionId: string;
  readonly channelId: string;
  readonly chatId: string;
  send(userText: string, executionId: string, eventBus: EventBus): Promise<string>;
  close(): Promise<void>;

  /** The native/SDK session ID used for resuming conversations. */
  readonly resumeId?: string;
  /** Restore a previously persisted resume ID so the session can continue a prior conversation. */
  setResumeId?(id: string): void;
}

export interface SessionManager {
  getOrCreate(channelId: string, chatId: string, agentName: string): AgentSession;
  close(channelId: string, chatId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export interface NativeSessionState {
  strategy: "native";
  nativeSessionId: string;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  content: string;
}

export interface TranscriptSessionState {
  strategy: "transcript";
  turns: TranscriptTurn[];
}

export type SessionFactory = (channelId: string, chatId: string, agentName: string) => AgentSession;