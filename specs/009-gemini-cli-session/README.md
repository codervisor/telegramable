---
status: complete
created: 2026-02-24
priority: medium
tags:
- agent-runtime
- session
- gemini
depends_on:
- 011-session-runtime-foundation
parent: 007-agent-session-runtime
created_at: 2026-02-24T06:34:36.395083Z
updated_at: 2026-02-24T07:04:05.523486Z
completed_at: 2026-02-24T07:04:05.523486Z
transitions:
- status: complete
  at: 2026-02-24T07:04:05.523486Z
---

# Gemini CLI Session Integration

> **Status**: planned · **Priority**: high · **Created**: 2026-02-24
> **North Star**: Wire the Gemini CLI (`gemini`) into the `AgentSession` interface using its native chat session flag (`--chat-id`), so multi-turn conversations with Gemini persist across user messages.

## Overview

The Gemini CLI supports stateful chat sessions identified by a chat ID. After the first call, subsequent calls pass `--chat-id <id>` to resume the same session. Like `ClaudeSession`, `GeminiSession` delegates all context management to the CLI — telegramable stores only the short session identifier.

This spec builds on the core session infrastructure from spec 007 and produces a concrete `GeminiSession` implementation.

## Design

### Invocation Pattern

| Turn       | Command                                               |
| ---------- | ----------------------------------------------------- |
| First      | `gemini -p "<user text>"`                             |
| Subsequent | `gemini --chat-id <nativeSessionId> -p "<user text>"` |

### Session ID Discovery

The Gemini CLI returns the chat ID in its response metadata or stdout. `GeminiSession` parses the chat ID from the first-call output and stores it as `nativeSessionId`. Exact output format to be verified against the installed `gemini` binary version during implementation.

### `GeminiSession` Sketch

```ts
export class GeminiSession implements AgentSession {
  private state: NativeSessionState | undefined;

  async send(userText: string, executionId: string, eventBus: EventBus): Promise<string> {
    const args = this.state
      ? ["--chat-id", this.state.nativeSessionId, "-p", userText]
      : ["-p", userText];

    const { stdout } = await spawnAndCollect("gemini", args);

    if (!this.state) {
      this.state = { strategy: "native", nativeSessionId: parseChatId(stdout) };
    }

    return stripAnsi(stdout);
  }
}
```

### Fallback

If `--chat-id <id>` fails (session expired or unavailable), `GeminiSession` falls back to a fresh session and resets `state`.

## Plan

- [x] Implement `GeminiSession` in `runtime/session/geminiSession.ts`
- [x] Add `parseChatId` helper to extract the chat ID from Gemini CLI stdout or response metadata
- [x] Register `"session-gemini"` in the `createRuntime` factory (from spec 007)
- [x] Add unit tests: first call builds correct args; second call includes `--chat-id <id>`; fallback on expired session

## Test

- [x] First call to `GeminiSession.send()` invokes `gemini -p "<text>"` with no `--chat-id` flag
- [x] Second call includes `--chat-id <parsedChatId> -p "<text>"`
- [x] Chat ID is correctly parsed from a sample stdout fixture
- [x] ANSI codes are stripped from the returned response string
- [x] If `--chat-id` fails, `GeminiSession` retries as a fresh session and updates `nativeSessionId`