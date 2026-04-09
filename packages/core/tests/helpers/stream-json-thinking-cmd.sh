#!/bin/sh
# Emits realistic Claude Code stream-json NDJSON output with thinking blocks.
# Simulates: init → thinking → tool_use (Read) → text streaming → assistant → result

# system init
echo '{"type":"system","subtype":"init","session_id":"test-session-456","tools":["Read","Bash"]}'

# stream_event: content_block_start with thinking
echo '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}'

# stream_event: thinking_delta chunks
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me look "}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"at the project structure."}}}'

# stream_event: content_block_stop (thinking complete)
echo '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}'

# stream_event: content_block_start with tool_use
echo '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_456","name":"Read","input":{}}}}'

# stream_event: input_json_delta for tool input
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"/tmp/test.txt\"}"}}}'

# stream_event: content_block_stop (tool call complete)
echo '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}'

# stream_event: content_block_start with text
echo '{"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}}'

# stream_event: text_delta chunks
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"The project "}}}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"is ready."}}}'

# stream_event: content_block_stop
echo '{"type":"stream_event","event":{"type":"content_block_stop","index":2}}'

# assistant complete message
echo '{"type":"assistant","message":{"id":"msg_456","role":"assistant","content":[{"type":"thinking","thinking":"Let me look at the project structure."},{"type":"tool_use","id":"toolu_456","name":"Read","input":{"file_path":"/tmp/test.txt"}},{"type":"text","text":"The project is ready."}]},"session_id":"test-session-456"}'

# result
echo '{"type":"result","subtype":"success","is_error":false,"result":"The project is ready.","session_id":"test-session-456","total_cost_usd":0.02}'
