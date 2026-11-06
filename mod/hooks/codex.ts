// 碰外面世界的部分：跑官方 codex、收圖、驗圖、縮圖、查用量、讀寫素材紀錄。
// 合規界線：只執行官方 codex，不讀 ~/.codex/auth.json，不自己打 API。

import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { EaselMeta, EaselSetup, EaselUsage } from '../types'
import { ROOT, codexArgv, failureText, newestNewImage, parseEvent, parseMeta, parsePng, parseTimes, parseUsage, splitLines, usageArgv } from './model'
import type { PngInfo } from './model'

type $ = EngineInterface
export type CodexStream = AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> & { readonly result: Promise<ProcessSpawnResult> }

export async function homeDir($: $): Promise<string> {
  const { stdout } = await $.process.run(['sh', '-c', 'printf %s "$HOME"'])
  return stdout
}

export async function checkSetup($: $): Promise<EaselSetup> {
  let version = ''
  try {
    const run = await $.process.run(codexArgv(['--version']))
    if (run.exitCode !== 0) return { state: 'missing', version: '' }
    version = run.stdout.trim().replace(/^codex-cli\s*/, '')
  } catch {
    return { state: 'missing', version: '' }
  }
  const status = await $.process.run(codexArgv(['login', 'status']))
  return { state: /Logged in using ChatGPT/.test(status.stdout + status.stderr) ? 'ready' : 'logged-out', version }
}

export async function fetchUsage($: $, at: number): Promise<EaselUsage | null> {
  try {
    const { stdout } = await $.process.run(usageArgv(), { timeoutMs: 12_000 })
    return parseUsage(stdout, at)
  } catch {
    return null
  }
}

/** 本機生過的每張圖的時間。官方不給張數，只能自己數。 */
export async function fetchImageTimes($: $, home: string): Promise<number[]> {
  const { stdout } = await $.process.run(['find', `${home}/.codex/generated_images`, '-type', 'f', '-name', '*.png', '-printf', '%T@\\n'])
  return parseTimes(stdout)
}

export const assetDir = (cwd: string, asset: string) => `${cwd}/${ROOT}/${asset}`

export async function loadAssets($: $, cwd: string): Promise<EaselMeta[]> {
  const root = `${cwd}/${ROOT}`
  if (!(await $.fs.exists(root))) return []
  const entries = await $.fs.list(root)
  const metas = await Promise.all(
    entries
      .filter(entry => entry.kind === 'dir')
      .map(async entry => {
        const path = `${root}/${entry.name}/meta.json`
        return (await $.fs.exists(path)) ? parseMeta(await $.fs.read(path)) : null
      }),
  )
  return metas.filter((meta): meta is EaselMeta => meta !== null)
}

export async function loadMeta($: $, cwd: string, asset: string): Promise<EaselMeta | null> {
  const path = `${assetDir(cwd, asset)}/meta.json`
  return (await $.fs.exists(path)) ? parseMeta(await $.fs.read(path)) : null
}

export async function saveMeta($: $, cwd: string, meta: EaselMeta): Promise<void> {
  await $.fs.write(`${assetDir(cwd, meta.asset)}/meta.json`, `${JSON.stringify(meta, null, 2)}\n`)
}

/** 同一段對話不能同時接回去。mkdir 是原子的，所以用它當鎖；不同素材互不影響。 */
export async function takeLock($: $, dir: string): Promise<boolean> {
  // 對話或 Codex 中途掛掉時鎖會留著。超過等待上限很久的就是殘留，清掉才不會永遠「正在畫」
  await $.process.run(['find', dir, '-maxdepth', '1', '-name', '.lock', '-mmin', '+6', '-exec', 'rm', '-rf', '{}', '+'])
  await $.process.run(['mkdir', '-p', dir])
  const { exitCode } = await $.process.run(['mkdir', `${dir}/.lock`])
  return exitCode === 0
}

export async function dropLock($: $, dir: string): Promise<void> {
  await $.process.run(['rm', '-rf', `${dir}/.lock`, `${dir}/.work`])
}

async function listImages($: $, home: string, threadId: string): Promise<string> {
  const { stdout } = await $.process.run(['find', `${home}/.codex/generated_images/${threadId}`, '-maxdepth', '1', '-name', '*.png', '-printf', '%T@ %p\\n'])
  return stdout
}

export type DrawRequest = {
  home: string
  dir: string
  version: number
  argv: string[]
  input: string
  /** 接回時的對話編號，用來分辨哪些圖是這次才多出來的 */
  threadId: string | null
}

export type DrawResult =
  | { kind: 'ok'; threadId: string; file: string; png: PngInfo; elapsedS: number }
  | { kind: 'failed'; message: string }
  | { kind: 'no-image'; threadId: string | null }
  | { kind: 'cancelled' }

type Hooks = {
  onThread: () => Promise<void>
  onSaving: () => Promise<void>
  onStream: (stream: CodexStream) => void
  isCancelled: () => boolean
}

/** 跑一次生圖並把圖收回素材資料夾。成功與否看生圖資料夾有沒有多一張新圖，不看模型怎麼說。 */
export async function draw($: $, request: DrawRequest, hooks: Hooks): Promise<DrawResult> {
  const { home, dir, version, argv, input } = request
  const startedAt = await $.clock.now()
  const before = new Set(
    request.threadId
      ? (await listImages($, home, request.threadId))
          .split('\n')
          .filter(Boolean)
          .map(line => line.slice(line.indexOf(' ') + 1))
      : [],
  )
  await $.process.run(['mkdir', '-p', `${dir}/.work`, `${dir}/.log`])

  let threadId = request.threadId
  let message: string | null = null
  let buffer = ''
  let log = ''
  let code: number | null = null
  const stream = $.process.spawn({ argv, cwd: `${dir}/.work`, input }) as CodexStream
  hooks.onStream(stream)

  try {
    for await (const chunk of stream) {
      if (chunk.stream !== 'stdout') continue
      if (log.length < 200_000) log += chunk.text
      const split = splitLines(buffer, chunk.text)
      buffer = split.rest
      for (const line of split.lines) {
        const event = parseEvent(line)
        if (event.kind === 'failed') message = event.message
        if (event.kind === 'thread') {
          threadId = event.threadId
          await hooks.onThread()
        }
      }
    }
    code = (await stream.result).code
  } catch (error) {
    if (!hooks.isCancelled()) message = error instanceof Error ? error.message : String(error)
  }
  await $.fs.write(`${dir}/.log/v${version}.jsonl`, log)

  if (hooks.isCancelled()) return { kind: 'cancelled' }
  if (!threadId) return { kind: 'failed', message: failureText(code, message) }

  const found = newestNewImage(await listImages($, home, threadId), before)
  if (!found) return code === 0 ? { kind: 'no-image', threadId } : { kind: 'failed', message: failureText(code, message) }

  await hooks.onSaving()
  const file = `${dir}/v${version}.png`
  await $.process.run(['cp', found, file])
  const head = await $.process.run(['sh', '-c', 'head -c 26 "$1" | base64 -w0', 'sh', file])
  const png = parsePng(head.stdout)
  if (!png) return { kind: 'no-image', threadId }
  return { kind: 'ok', threadId, file: `v${version}.png`, png, elapsedS: Math.round(((await $.clock.now()) - startedAt) / 1000) }
}

const SVG_LIMIT = 120_000
const cache = new Map<string, string>()

async function encode($: $, file: string, out: string, width: number, quality: number): Promise<string | null> {
  const { exitCode } = await $.process.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `scale=${width}:-2:flags=lanczos`, '-c:v', 'libwebp', '-q:v', String(quality), out], {
    timeoutMs: 20_000,
  })
  if (exitCode !== 0) return null
  const bytes = await $.fs.read(out, { as: 'bytes' })
  return bytes.base64
}

/** 桌面與手機只能把圖嵌進 Svg，上限約 13 萬字元，所以先轉成 WebP 縮圖；太大就再縮一級。回 base64，失敗回 null（多半是沒裝 ffmpeg）。 */
export async function thumbnail($: $, dir: string, name: string, width: number): Promise<string | null> {
  const file = `${dir}/${name}.png`
  const key = `${file}:${width}`
  const hit = cache.get(key)
  if (hit) return hit
  if (!(await $.fs.exists(file))) return null
  try {
    await $.process.run(['mkdir', '-p', `${dir}/.thumbs`])
    const out = `${dir}/.thumbs/${name}-${width}.webp`
    let data = await encode($, file, out, width, width > 200 ? 72 : 60)
    if (data && data.length > SVG_LIMIT) data = await encode($, file, out, Math.round(width * 0.7), 60)
    if (data) cache.set(key, data)
    return data
  } catch {
    return null
  }
}

/** 在這台電腦上用預設程式開原圖。WSL 走 Windows 的檔案總管。 */
export async function openFile($: $, file: string): Promise<void> {
  await $.process.run(['sh', '-c', 'if command -v wslpath >/dev/null 2>&1; then explorer.exe "$(wslpath -w "$1")"; else xdg-open "$1"; fi; true', 'sh', file])
}

/** 素材放在專案根目錄：git 專案就用它的根，不是 git 專案就用目前資料夾。 */
export async function projectRoot($: $, cwd: string): Promise<string> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'])
    return (exitCode === 0 && stdout.trim()) || cwd
  } catch {
    return cwd
  }
}
