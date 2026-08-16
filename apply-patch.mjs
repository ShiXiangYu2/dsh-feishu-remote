#!/usr/bin/env node
/**
 * Re-apply the DSH tool-name fix after a DSH upgrade.
 *
 * Usage:
 *   node apply-patch.mjs [path-to-dsh-source]
 *
 * Defaults to /www/wwwroot/deepseek-harness if no path is given.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.argv[2] || '/www/wwwroot/deepseek-harness'
const target = join(root, 'packages/llm/llm-deepseek/src/translate.ts')

const OLD = 'if (call.function?.name !== undefined) block.name = call.function.name'
// The replacement mirrors the 8-space indentation used inside the loop body.
const NEW =
  '        // Some gateways (e.g. SiliconFlow) send function.name only on the first\n' +
  '        // chunk and an EMPTY STRING on subsequent chunks; only adopt non-empty\n' +
  '        // names so the tool name is not clobbered mid-stream.\n' +
  "        if (typeof call.function?.name === 'string' && call.function.name.length > 0) {\n" +
  '          block.name = call.function.name\n' +
  '        }'

try {
  const src = readFileSync(target, 'utf8')
  const count = src.split(OLD).length - 1
  if (count === 0) {
    if (src.includes(NEW)) {
      console.log(`✓ already patched: ${target}`)
      process.exit(0)
    }
    console.error(`✗ pattern not found in ${target} — DSH layout may have changed.`)
    process.exit(1)
  }
  if (count > 1) {
    console.error(`✗ expected exactly one match, found ${count} in ${target}`)
    process.exit(1)
  }
  writeFileSync(target, src.replace(OLD, NEW))
  console.log(`✓ patched ${target}`)
  process.exit(0)
} catch (e) {
  console.error(`✗ failed: ${e.message}`)
  process.exit(1)
}
