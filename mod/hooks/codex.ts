// 碰外面世界的部分：跑官方 codex、收圖、驗圖、縮圖、查用量、讀寫素材紀錄。
// 合規界線：只執行官方 codex，不讀 ~/.codex/auth.json，不自己打 API。

import type { EngineInterface, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { EaselMeta, EaselSetup, EaselUsage } from '../types'
import { PLATFORM_PROBE, ROOT, codexArgv, failureText, newestNewImage, openArgv, parseEvent, parseMeta, parsePng, parseUsage, platformOf, splitLines, thumbnailer, usageArgv } from './model'
import type { ImageFile, Platform, PngInfo, Thumbnailer } from './model'

type $ = EngineInterface
export type CodexStream = AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> & { readonly result: Promise<ProcessSpawnResult> }

export async function homeDir($: $): Promise<string> {
  const { stdout } = await $.process.run(['sh', '-c', 'printf %s "$HOME"'])
  return stdout
}

let knownPlatform: Platform | null = null

/** 這台電腦是哪一種環境。同一場對話裡不會變，問到一次就記住；問不到就當 Linux，下次再問。 */
export async function detectPlatform($: $): Promise<Platform> {
  if (knownPlatform) return knownPlatform
  try {
    const probe = await $.process.run(PLATFORM_PROBE)
    knownPlatform = platformOf(probe.stdout)
    return knownPlatform
  } catch {
    return 'linux'
  }
}

export async function checkSetup($: $): Promise<EaselSetup> {
  let version = ''
  try {
    const run = await $.process.run(codexArgv(['--version']))
    if (run.exitCode !== 0) return { state: 'missing', version: '', platform: await detectPlatform($) }
    version = run.stdout.trim().replace(/^codex-cli\s*/, '')
  } catch {
    return { state: 'missing', version: '', platform: await detectPlatform($) }
  }
  const status = await $.process.run(codexArgv(['login', 'status']))
  return { state: /Logged in using ChatGPT/.test(status.stdout + status.stderr) ? 'ready' : 'logged-out', version, platform: await detectPlatform($) }
}

export async function fetchUsage($: $, at: number): Promise<EaselUsage | null> {
  try {
    const { stdout } = await $.process.run(usageArgv(), { timeoutMs: 12_000 })
    return parseUsage(stdout, at)
  } catch {
    return null
  }
}

/**
 * 列出資料夾裡的 PNG 與修改時間。easel 只有這一處列圖檔，走引擎的 $.fs.list，不叫 find、stat 這類指令：
 * 原本用 GNU find 的 -printf，macOS 內建的 BSD find 不認得，會把真的畫出來的圖報成「沒有新圖」。
 * depth 是往下找幾層子資料夾，0 只看這一層；連結不跟。
 * 資料夾不存在＝沒有圖；資料夾在卻讀不到就把錯誤丟出去，不能默默當成沒有圖。
 */
export async function listPngs($: $, dir: string, depth = 0): Promise<ImageFile[]> {
  let entries: Awaited<ReturnType<$['fs']['list']>>
  try {
    entries = await $.fs.list(dir)
  } catch (error) {
    if (await $.fs.exists(dir)) throw error
    return []
  }
  const here = entries.filter(entry => entry.kind === 'file' && entry.name.endsWith('.png')).map(entry => ({ path: `${dir}/${entry.name}`, mtimeMs: entry.mtimeMs }))
  if (depth <= 0) return here
  const below = await Promise.all(entries.filter(entry => entry.kind === 'dir').map(entry => listPngs($, `${dir}/${entry.name}`, depth - 1)))
  return [...here, ...below.flat()]
}

const imagesRoot = (home: string) => `${home}/.codex/generated_images`

/** 本機生過的每張圖的時間（毫秒）。官方不給張數，只能自己數。圖放在 generated_images/<對話編號>/ 底下，所以往下一層。 */
export async function fetchImageTimes($: $, home: string): Promise<number[]> {
  try {
    const files = await listPngs($, imagesRoot(home), 1)
    return files.map(file => file.mtimeMs).filter(t => Number.isFinite(t) && t > 0)
  } catch {
    // 這裡只是粗估張數用，讀不到就不估，不擋其他功能
    return []
  }
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

/** 某段對話到目前為止生過的圖。 */
function threadImages($: $, home: string, threadId: string): Promise<ImageFile[]> {
  return listPngs($, `${imagesRoot(home)}/${threadId}`)
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
  const before = new Set(request.threadId ? (await threadImages($, home, request.threadId)).map(file => file.path) : [])
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

  let after: ImageFile[]
  try {
    after = await threadImages($, home, threadId)
  } catch (error) {
    // Codex 已經跑完、額度可能已經花了：讀不到資料夾要照實說，不能報成「沒有新圖」
    return { kind: 'failed', message: `easel 讀不到生圖資料夾 ${imagesRoot(home)}/${threadId}（${error instanceof Error ? error.message : String(error)}）。Codex 已經跑完，圖可能其實畫好了，先看那個資料夾再決定要不要重畫。` }
  }
  const found = newestNewImage(after, before)
  if (!found) return code === 0 ? { kind: 'no-image', threadId } : { kind: 'failed', message: failureText(code, message) }

  await hooks.onSaving()
  const file = `${dir}/v${version}.png`
  await $.process.run(['cp', found, file])
  // base64 的 -w0 是 GNU 才有的寫法，換行改用 tr 去掉，GNU 與 BSD 都通
  const head = await $.process.run(['sh', '-c', 'head -c 26 "$1" | base64 | tr -d \'\\n\'', 'sh', file])
  const png = parsePng(head.stdout)
  if (!png) return { kind: 'no-image', threadId }
  return { kind: 'ok', threadId, file: `v${version}.png`, png, elapsedS: Math.round(((await $.clock.now()) - startedAt) / 1000) }
}

const SVG_LIMIT = 120_000
/** 縮圖塞不進 Svg 時，每次縮到七成寬再做，最多縮這麼多次；還是太大就當作做不出來 */
const SHRINK_STEPS = 4
const cache = new Map<string, string>()

async function encode($: $, maker: Thumbnailer, file: string, out: string, width: number, quality: number): Promise<string | null> {
  const { exitCode } = await $.process.run(maker.argv(file, out, width, quality), { timeoutMs: 20_000 })
  if (exitCode !== 0) return null
  const bytes = await $.fs.read(out, { as: 'bytes' })
  return bytes.base64
}

/**
 * 桌面與手機只能把圖嵌進 Svg，上限約 13 萬字元，所以先做成縮圖；太大就一級一級縮到塞得進去。
 * 用哪個程式、轉成什麼格式查 model.ts 的平台表（Linux 與 WSL 是 ffmpeg 轉 WebP，macOS 是內建的 sips 轉 JPEG）。
 * 回可以直接放進 <image href> 的 data URI，類型跟著實際格式走；做不出來或怎麼縮都太大就回 null。
 * 絕不回塞不進去的圖：整張 Svg 超過上限時引擎會拒絕畫，面板會整片空白。JPEG 比 WebP 大，macOS 上常常要縮不只一級。
 */
export async function thumbnail($: $, dir: string, name: string, width: number): Promise<string | null> {
  const file = `${dir}/${name}.png`
  const key = `${file}:${width}`
  const hit = cache.get(key)
  if (hit) return hit
  if (!(await $.fs.exists(file))) return null
  try {
    const maker = thumbnailer(await detectPlatform($))
    await $.process.run(['mkdir', '-p', `${dir}/.thumbs`])
    const out = `${dir}/.thumbs/${name}-${width}.${maker.ext}`
    let size = width
    for (let step = 0; step <= SHRINK_STEPS; step++) {
      const data = await encode($, maker, file, out, size, step === 0 && width > 200 ? 72 : 60)
      if (!data) return null
      if (data.length <= SVG_LIMIT) {
        const uri = `data:${maker.mime};base64,${data}`
        cache.set(key, uri)
        return uri
      }
      size = Math.round(size * 0.7)
    }
    return null
  } catch {
    return null
  }
}

/** 在這台電腦上用預設程式開原圖。哪個平台用哪個指令查 model.ts 的表：macOS 用 open，WSL 走 Windows 的檔案總管，Linux 用 xdg-open。 */
export async function openFile($: $, file: string): Promise<void> {
  try {
    await $.process.run(openArgv(await detectPlatform($), file))
  } catch {
    // 沒有可用的開檔程式（例如沒有桌面的 Linux）時不讓按鈕出錯，路徑還能用旁邊的「複製路徑」
  }
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
