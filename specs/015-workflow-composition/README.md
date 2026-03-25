---
status: draft
created: 2026-03-20
priority: medium
tags:
- strategy
- platform
- long-term
depends_on:
- 014-bidirectional-agent-human
created_at: 2026-03-20T06:48:52.594456898Z
updated_at: 2026-03-20T06:51:26.332170147Z
---

# Workflow Composition - Multi-Step Agent Pipelines

## Overview

Chain agents and channels into multi-step workflows. This is the long-term platform play that turns Telegramable from a tool into a composable orchestration layer.

**Status: Draft** — Models and frameworks are evolving fast (MCP, Agent SDK, OpenAI Agents). This spec should be revisited as the ecosystem matures to avoid building what becomes native capability.

## Design

### Workflow Primitives

- **Sequential**: A → B → C (output of one agent feeds into next)
- **Fan-out/Fan-in**: A → [B, C] → D (parallel execution, merge results)
- **Conditional**: A → if(condition) B else C
- **Human gate**: A → wait for human approval → B
- **Channel hop**: receive on Slack → process → respond on email

### Example Workflows

**Code review pipeline**:
```
Slack message → Claude Code writes code → post diff to email
  → reviewer replies "approve" → agent commits and pushes
```

**Multi-agent comparison**:
```
Telegram trigger → fan-out [Claude, Gemini]
  → compare results → return best to user
```

### Configuration Format (TBD)

Lightweight DSL or JSON/YAML workflow definition. Should not reinvent Temporal/Airflow — keep it minimal and IM-native.

## Plan

- [ ] Design workflow definition format
- [ ] Implement sequential pipeline execution
- [ ] Implement fan-out/fan-in parallel execution
- [ ] Add conditional routing
- [ ] Integrate human-in-the-loop gates (depends on 014-bidirectional-agent-human)
- [ ] Channel-hop support (cross-adapter message routing)

## Test

- [ ] Sequential pipeline: 3 agents chained, output flows correctly
- [ ] Fan-out: 2 agents run in parallel, results merged
- [ ] Human gate: workflow pauses for approval, resumes on reply

## Notes

- **Risk**: This space is moving fast. MCP tool composition, Agent SDK multi-agent patterns, and LangGraph-style frameworks may make custom workflow engines redundant.
- **Mitigation**: Keep the abstraction thin. Telegramable's value is the IM↔agent bridge, not the orchestration engine. Compose existing tools rather than building a new workflow runtime.
- Revisit this spec quarterly against ecosystem developments.
- Depends on bidirectional communication (spec 014) for human-in-the-loop gates.
