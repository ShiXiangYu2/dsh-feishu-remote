# DSH Patch: Fix tool-name clobbering for SiliconFlow streaming

This plugin depends on a small **DSH core patch** that fixes tool calls when using
DeepSeek models served through **SiliconFlow** (and similar OpenAI-compatible
gateways). Without it, every model tool call fails with an empty tool name (`""`).

## Symptom

The agent reports something like:

> 所有工具调用都失败了，工具名称都是空的 `""`.

or "tool name is empty" — every tool call fails even though the tools are
correctly registered and the model clearly intends to call them.

## Root cause

SiliconFlow's streaming `chat.completions` responses split a tool call across
multiple chunks:

```
chunk 1: delta.tool_calls[0] = { index: 0, id: "...", function: { name: "generate_image", arguments: "" } }
chunk 2: delta.tool_calls[0] = { index: 0, id: null,    function: { name: "",          arguments: "{" } }
chunk 3: delta.tool_calls[0] = { index: 0, id: null,    function: { name: "",          arguments: "\"prompt\": ..." } }
```

The DSH DeepSeek adapter (`@deepseek-ai/dsh-llm-deepseek`) parsed tool calls like
this:

```ts
if (call.function?.name !== undefined) block.name = call.function.name
```

An **empty string** (`""`) is `!== undefined`, so the adapter happily overwrote
the already-captured tool name (`generate_image`) with `""` on chunk 2. Every
subsequent chunk clobbered the name, and the final tool call had `name: ""`.

## The fix

File: `packages/llm/llm-deepseek/src/translate.ts` (in the DSH source checkout)

Before:

```ts
if (call.id !== undefined) block.callId = call.id
if (call.function?.name !== undefined) block.name = call.function.name
```

After:

```ts
if (call.id !== undefined) block.callId = call.id
// Some gateways (e.g. SiliconFlow) send function.name only on the first
// chunk and an EMPTY STRING on subsequent chunks; only adopt non-empty
// names so the tool name is not clobbered mid-stream.
if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
  block.name = call.function.name
}
```

## How to re-apply after a DSH upgrade

DSH upgrades overwrite `packages/**`, so re-apply the patch after each update:

### Option A — manual edit (fast)

Open `packages/llm/llm-deepseek/src/translate.ts`, find the `if (call.id !==
undefined) block.callId = call.id` line inside the `delta?.tool_calls` loop, and
apply the change above (add the non-empty-name guard).

### Option B — scripted patch

```sh
# From the DSH source root:
python3 - <<'PY'
import re
p = 'packages/llm/llm-deepseek/src/translate.ts'
src = open(p).read()
old = "if (call.function?.name !== undefined) block.name = call.function.name"
new = (
    "// Some gateways (e.g. SiliconFlow) send function.name only on the first\n"
    "// chunk and an EMPTY STRING on subsequent chunks; only adopt non-empty\n"
    "// names so the tool name is not clobbered mid-stream.\n"
    "if (typeof call.function?.name === 'string' && call.function.name.length > 0) {\n"
    "  block.name = call.function.name\n"
    "}"
)
assert src.count(old) == 1, 'expected exactly one match'
open(p, 'w').write(src.replace(old, new))
print('patched', p)
PY
```

### Option C — check in a tiny patch file

`apply-patch.mjs` (in this repo) automates Option B. Run it from the DSH source
root after an upgrade:

```sh
node apply-patch.mjs /path/to/deepseek-harness
```

## Verify

After patching and restarting the resident (`feishu-resident.mjs`), ask the bot
to use a tool, e.g.:

> 用 generate_image 生成一张猫的图片

The agent should now call `generate_image` successfully (instead of reporting
empty tool names).
