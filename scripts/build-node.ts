// The Node side the installed app runs (bridge, terminal host, MCP server, the switchboard
// command), as plain JavaScript in out/node: electron-builder.yml puts it beside the .ts files
// in Resources/node, and src/main/appRoot.ts nodeEntry runs it when it is there. Node strips
// the types of a .ts file each time it loads one, with a compiler that costs a process about
// 17 MB; here the same stripping (module.stripTypeScriptTypes, which keeps every line and
// column) runs once, at build time, and relative imports of .ts files point at the .mjs files.
// Run from the repo, the .ts files run as they are.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = join(ROOT, 'out', 'node')

// What the app and its launchers start; whatever these import comes along.
export const ENTRIES = ['bridge/server.ts', 'bridge/start.ts', 'mcp/server.ts', 'mcp/hook.ts', 'scripts/switchboard.ts', 'src/main/termHost.ts']

// import ... from './x.ts', export ... from './x.ts', import './x.ts', import('./x.ts')
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g

// Relative imports of anything else (.js files).
const RELATIVE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+\.m?js)['"]/g

export function rewriteImports(code: string): { code: string; imports: string[] } {
  const imports: string[] = []
  const out = code.replace(SPECIFIER, (_all, lead: string, quote: string, path: string) => {
    imports.push(`${path}.ts`)
    return `${lead}${quote}${path}.mjs${quote}`
  })
  return { code: out, imports }
}

export function buildNode(root = ROOT, out = OUT, entries = ENTRIES): string[] {
  rmSync(out, { recursive: true, force: true })
  const done = new Set<string>()
  const queue = entries.map(entry => join(root, entry))
  while (queue.length > 0) {
    const file = queue.pop()!
    if (done.has(file)) continue
    done.add(file)
    const source = readFileSync(file, 'utf8')
    const target = join(out, relative(root, file)).replace(/\.ts$/, '.mjs')
    mkdirSync(dirname(target), { recursive: true })
    // Plain JavaScript (bridge/mobile/*.js, shared with the phone page) goes as it is.
    if (!file.endsWith('.ts')) {
      writeFileSync(target, source)
      for (const [, path] of source.matchAll(RELATIVE)) queue.push(resolve(dirname(file), path!))
      continue
    }
    const { code, imports } = rewriteImports(stripTypeScriptTypes(source, { mode: 'strip' }))
    // A .ts specifier left over (built from a string, say) would load the compiler after all.
    const left = code.match(/['"][^'"\n]*\.ts['"]/g)?.filter(s => !/\.d\.ts['"]$/.test(s))
    if (left?.length) throw new Error(`${relative(root, file)}: a .ts path is still named: ${left.join(', ')}`)
    writeFileSync(target, code)
    for (const path of imports) queue.push(resolve(dirname(file), path))
    for (const [, path] of code.matchAll(RELATIVE)) if (!path!.endsWith('.mjs')) queue.push(resolve(dirname(file), path!))
  }
  return [...done].map(file => relative(root, file).split('\\').join('/')).sort()
}

if (import.meta.main) {
  const files = buildNode()
  console.log(`out/node: ${files.length} files`)
}
