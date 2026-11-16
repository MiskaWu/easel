import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { EaselMeta, EaselVersion } from '../types'

const CWD = '/proj'
const HOME = '/home/u'
const THREAD = '00000000-0000-7000-8000-000000000001'
const RGB_HEAD = 'iVBORw0KGgoAAAANSUhEUgAABOYAAATmCAI='

const PANE = {
  plugin: 'easel',
  component: 'Pane',
  requestId: 'easel',
  props: { title: 'easel', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const version = (n: number, over: Partial<EaselVersion> = {}): EaselVersion => ({
  n,
  file: `v${n}.png`,
  threadId: THREAD,
  base: n > 1 ? n - 1 : null,
  prompt: `第 ${n} 版的要求`,
  refs: [],
  createdAt: 1,
  elapsedS: 40,
  width: 1254,
  height: 1254,
  alpha: false,
  selfCheck: 'pass',
  selfNote: '背景維持黃昏',
  review: 'pending',
  note: '',
  ...over,
})

const meta = (asset: string, versions: EaselVersion[]): EaselMeta => ({ asset, transparent: false, codexVersion: '0.167.0', versions })

type Png = { path: string; mtimeMs: number }

type World = {
  metas?: EaselMeta[]
  /** codex login status 的回答 */
  login?: string
  /** 沒裝 codex */
  noCodex?: boolean
  /** 生圖後資料夾多出來的檔；空的＝模型沒真的生圖。只給路徑時，時間照順序遞增 */
  images?: (string | Png)[]
  /** 生圖前就在磁碟上的圖 */
  old?: Png[]
  /** 存在但讀不到的資料夾 */
  unreadable?: string[]
  /** uname -s 的回答，預設 Linux */
  uname?: string
  /** 有 wslpath＝在 WSL 裡 */
  wsl?: boolean
  /** 做縮圖的程式跑不起來（沒裝，或轉檔失敗） */
  noThumbTool?: boolean
  /** 縮圖檔讀出來的 base64，照讀的順序給；用完之後都回短的。用來模擬第一張太大 */
  thumbs?: string[]
  /** 縮圖怎麼縮都太大 */
  hugeThumbs?: boolean
  /** 引擎拒絕註冊 /easel 指令時回的理由 */
  refuseCommand?: string
  /** 引擎拒絕註冊的工具名與理由 */
  refuseTools?: Record<string, string>
  /** 生圖的 stdout 行 */
  events?: string[]
  /** 別的對話正在畫這個素材 */
  locked?: boolean
  /** git 專案的根目錄 */
  gitRoot?: string
  /** 引擎回報的專案根目錄 */
  sessionRoot?: string
}

function world(on: On, opts: World = {}) {
  const files: Record<string, string> = {}
  const runs: string[][] = []
  const spawns: { argv: readonly string[]; input?: string }[] = []
  const lists: string[] = []
  const tools: string[] = []
  const commands: string[] = []
  const logs: string[] = []
  const thumbs = [...(opts.thumbs ?? [])]
  /** 磁碟上的圖：路徑對修改時間 */
  const pngs: Record<string, number> = {}
  for (const png of opts.old ?? []) pngs[png.path] = png.mtimeMs
  const paths = () => [...Object.keys(files), ...Object.keys(pngs)]
  for (const m of opts.metas ?? []) {
    files[`${CWD}/art/${m.asset}/meta.json`] = JSON.stringify(m)
    for (const v of m.versions) files[`${CWD}/art/${m.asset}/${v.file}`] = 'png'
  }
  const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  // 這兩個替身原本一律回成功，所以「/easel 指令被引擎拒絕、整個啟動被跳過」在測試裡不會發生。現在可以照引擎的方式拒絕。
  on('command.register', ($, e) => {
    if (opts.refuseCommand) return { deny: opts.refuseCommand }
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    const refusal = opts.refuseTools?.[e.name]
    if (refusal) return { deny: refusal }
    tools.push(`mcp__easel__${e.name}`)
    return { value: { tool: `mcp__easel__${e.name}` } }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: opts.sessionRoot ?? CWD }))
  mock.clock(on, { now: 1_790_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: paths().some(f => f === e.path || f.startsWith(`${e.path}/`)) || (opts.unreadable ?? []).includes(e.path) }))
  on('fs.read', ($, e) => {
    if (/\/\.thumbs\/[^/]+\.(webp|jpg)$/.test(e.path)) return { value: { base64: opts.hugeThumbs ? 'A'.repeat(130_000) : (thumbs.shift() ?? 'QUJD') } }
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  // 照引擎的 $.fs.list 回答：檔案帶自己的修改時間，資料夾的時間是 0；資料夾不存在就丟 ENOENT
  on('fs.list', ($, e) => {
    lists.push(e.path)
    if ((opts.unreadable ?? []).includes(e.path)) throw new Error(`EACCES ${e.path}`)
    const inside = paths().filter(f => f.startsWith(`${e.path}/`))
    if (inside.length === 0) throw new Error(`ENOENT ${e.path}`)
    const names = new Set(inside.map(f => f.slice(e.path.length + 1).split('/')[0] as string))
    return {
      value: [...names].map(name => {
        const full = `${e.path}/${name}`
        const isFile = full in files || full in pngs
        return { name, kind: isFile ? ('file' as const) : ('dir' as const), size: isFile ? 1 : 0, mtimeMs: isFile ? (pngs[full] ?? 1) : 0, isLink: false }
      }),
    }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const line = argv.join(' ')
    if (argv[0] === 'sh' && line.includes('$HOME')) return out(HOME)
    if (argv[0] === 'sh' && line.includes('uname -s')) return out(`${opts.uname ?? 'Linux'}\n${opts.wsl ? 'wsl\n' : ''}`)
    if (line.includes('--version')) return opts.noCodex ? out('', 127) : out('codex-cli 0.167.0\n')
    if (line.includes('login status')) return out(opts.login ?? 'Logged in using ChatGPT\n')
    if (line.includes('app-server')) {
      return out(`${JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 43200, resetsAt: 2_000_000_000 }, planType: 'go' }, rateLimitResetCredits: { availableCount: 2 } } })}\n`)
    }
    if (argv[0] === 'git') return opts.gitRoot ? out(`${opts.gitRoot}\n`) : out('', 128)
    if (argv[0] === 'find') return out('')
    if (argv[0] === 'mkdir' && opts.locked && argv[1]?.endsWith('/.lock')) return out('', 1)
    if (argv[0] === 'sh' && line.includes('base64')) return out(RGB_HEAD)
    if (argv[0] === 'ffmpeg' || argv[0] === 'sips') return opts.noThumbTool ? out('', 127) : out('')
    return out('')
  })
  on('process.spawn', async function* ($, e) {
    spawns.push({ argv: e.argv, ...(e.input === undefined ? {} : { input: e.input }) })
    ;(opts.images ?? []).forEach((image, i) => {
      if (typeof image === 'string') pngs[image] = 100_500 + i * 1000
      else pngs[image.path] = image.mtimeMs
    })
    for (const line of opts.events ?? [`{"type":"thread.started","thread_id":"${THREAD}"}`]) yield { stream: 'stdout' as const, text: `${line}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { files, runs, spawns, lists, tools, commands, logs }
}

const start = ($: Engine) => $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
const openPane = ($: Engine) => $.command.run({ command: 'easel', args: '' } as never)

type Drawing = { find: (q: { text: RegExp }) => Promise<unknown>; findAll: (q: { type?: string }) => Promise<{ props: Record<string, unknown> }[]> }
const seen = async (ui: Drawing, text: RegExp) => (await ui.find({ text })) !== undefined || (await ui.findAll({ type: 'Svg' })).some(el => text.test(String(el.props.alt ?? '')))

test('首頁：待審排最上面，桌面有圖、終端機沒有 Svg', async ($, on) => {
  world(on, { metas: [meta('hero-fox', [version(1), version(2)]), meta('cabin', [version(1, { review: 'approved' })])] })
  await start($)
  await openPane($)

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await seen(desktop, /等你審（1）/)).toBe(true)
  expect(await seen(desktop, /hero-fox/)).toBe(true)
  expect(await seen(desktop, /素材（1）/)).toBe(true)
  expect((await desktop.findAll({ type: 'Svg' })).length).toBeGreaterThan(1)
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await seen(terminal, /hero-fox/)).toBe(true)
  expect((await terminal.findAll({ type: 'Svg' })).length).toBe(0)
  await terminal.unmount()
})

test('審稿：核准寫回 meta.json，版本切換走 Button', async ($, on) => {
  const w = world(on, { metas: [meta('hero-fox', [version(1), version(2)])] })
  await start($)
  await openPane($)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-hero-fox' })
  expect(await seen(ui, /第 2 版的要求/)).toBe(true)
  await ui.press({ key: 'ver-1' })
  expect(await seen(ui, /第 1 版的要求/)).toBe(true)
  await ui.press({ key: 'ver-2' })
  await ui.press({ key: 'approve' })
  const saved = JSON.parse(w.files[`${CWD}/art/hero-fox/meta.json`] ?? '{}') as EaselMeta
  expect(saved.versions[1]?.review).toBe('approved')
  expect(saved.versions[0]?.review).toBe('pending')
  await ui.unmount()
})

test('比較兩版：第一版沒有比較鈕', async ($, on) => {
  world(on, { metas: [meta('hero-fox', [version(1), version(2)])] })
  await start($)
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open-hero-fox' })
  await ui.press({ key: 'compare' })
  expect(await seen(ui, /v1 與 v2/)).toBe(true)
  await ui.press({ key: 'back' })
  await ui.press({ key: 'ver-1' })
  expect(await ui.find({ key: 'compare' })).toBeUndefined()
  await ui.unmount()
})

test('手機沒有輸入框，改請他在對話裡說', async ($, on) => {
  world(on, { metas: [meta('hero-fox', [version(1)])] })
  await start($)
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  await ui.press({ key: 'open-hero-fox' })
  expect(await seen(ui, /在對話裡告訴 Claude/)).toBe(true)
  await ui.unmount()
})

test('沒裝 Codex 時教他裝，沒登入時給登入鈕', async ($, on) => {
  world(on, { noCodex: true })
  await start($)
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await seen(ui, /curl -fsSL https:\/\/chatgpt\.com\/codex\/install\.sh \| sh/)).toBe(true)
  await ui.unmount()
})

test('macOS 沒裝 Codex：請他用自己管理工具的方式裝，不教 curl | sh，也沒有複製指令鈕', async ($, on) => {
  world(on, { noCodex: true, uname: 'Darwin' })
  await start($)
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await seen(ui, /找不到官方 Codex。請用你平常管理工具的方式安裝/)).toBe(true)
  expect(await seen(ui, /curl/)).toBe(false)
  expect(await ui.find({ key: 'copy-install' })).toBeUndefined()
  expect(await ui.find({ key: 'recheck' })).toBeDefined()
  await ui.unmount()
  const out = await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  const deny = String((out as { deny?: string }).deny)
  expect(deny).toContain('管理工具的方式')
  expect(deny).not.toContain('curl')
})

test('沒登入時面板給登入鈕，工具也拒絕', async ($, on) => {
  world(on, { login: 'Not logged in\n' })
  await start($)
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'login' })).toBeDefined()
  await ui.unmount()
  const out = await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  expect('deny' in out && String(out.deny)).toContain('登入')
})

test('新圖：多一張新圖才算數，紀錄寫進 meta.json，不再靠模型複製', async ($, on) => {
  const image = `${HOME}/.codex/generated_images/${THREAD}/exec-a.png`
  const w = world(on, { images: [image] })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸', transparent: false } as never)
  expect(JSON.stringify(out)).toContain('v1.png')
  expect(w.runs.some(argv => argv[0] === 'cp' && argv[1] === image && argv[2] === `${CWD}/art/fox/v1.png`)).toBe(true)
  const saved = JSON.parse(w.files[`${CWD}/art/fox/meta.json`] ?? '{}') as EaselMeta
  expect(saved.versions[0]?.threadId).toBe(THREAD)
  expect(saved.versions[0]?.width).toBe(1254)
  expect(w.spawns[0]?.input).toContain('狐狸')
  expect(w.runs.some(argv => argv.join(' ') === `rm -rf ${CWD}/art/fox/.lock ${CWD}/art/fox/.work`)).toBe(true)
})

test('Codex 說完成但沒有新圖：不算數，也不留下版本', async ($, on) => {
  const w = world(on, { images: [] })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  expect(String((out as { deny?: string }).deny)).toContain('不算數')
  expect(w.files[`${CWD}/art/fox/meta.json`]).toBeUndefined()
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await seen(ui, /不算數/)).toBe(true)
  await ui.unmount()
})

test('修改：接回畫底圖那段對話並附上底圖，失敗的 turn 會回報', async ($, on) => {
  const w = world(on, {
    metas: [meta('fox', [version(1), version(2, { threadId: 'thread-2' })])],
    events: [`{"type":"thread.started","thread_id":"thread-2"}`, '{"type":"turn.failed","error":{"message":"額度用完"}}'],
    images: [],
  })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__easel__revise', asset: 'fox', prompt: '圍巾改紅', base: 2 } as never)
  const argv = w.spawns[0]?.argv ?? []
  expect(argv.slice(argv.indexOf('resume'))).toEqual(['resume', 'thread-2', '-', '-i', `${CWD}/art/fox/v2.png`])
  expect(w.spawns[0]?.input).toContain('v2')
  expect(JSON.stringify(out)).toContain('不算數')
})

test('同一個素材不能同時畫：鎖拿不到就拒絕', async ($, on) => {
  const w = world(on, { metas: [meta('fox', [version(1)])], locked: true })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__easel__revise', asset: 'fox', prompt: '改' } as never)
  expect(String((out as { deny?: string }).deny)).toContain('正在畫')
  expect(w.spawns.length).toBe(0)
})

test('素材名不合法、重複開新素材都拒絕', async ($, on) => {
  world(on, { metas: [meta('fox', [version(1)])] })
  await start($)
  const bad = await $.tool.call({ tool: 'mcp__easel__new', asset: '../x', prompt: 'p' } as never)
  expect(String((bad as { deny?: string }).deny)).toContain('素材名')
  const dup = await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: 'p' } as never)
  expect(String((dup as { deny?: string }).deny)).toContain('已經存在')
})

test('自檢結果寫回去，面板看得到', async ($, on) => {
  const w = world(on, { metas: [meta('fox', [version(1, { selfCheck: 'pending', selfNote: '' })])] })
  await start($)
  await $.tool.call({ tool: 'mcp__easel__self_check', asset: 'fox', version: 1, pass: false, note: '圍巾顏色不對' } as never)
  const saved = JSON.parse(w.files[`${CWD}/art/fox/meta.json`] ?? '{}') as EaselMeta
  expect(saved.versions[0]?.selfCheck).toBe('fail')
  expect(saved.versions[0]?.selfNote).toBe('圍巾顏色不對')
})

test('Claude 直接叫 codex 生圖會被擋，其他 Bash 照常', async ($, on) => {
  world(on)
  on('tool.call', { tool: 'Bash' }, () => ({ result: 'ok' }))
  await start($)
  const blocked = await $.tool.call({ tool: 'Bash', command: "codex exec '$imagegen 畫貓'" })
  expect(String((blocked as { deny?: string }).deny)).toContain('easel')
  const fine = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect('deny' in fine && fine.deny !== undefined).toBe(false)
})

test('上一次中途掛掉留下的鎖要先清掉，才拿新鎖', async ($, on) => {
  const w = world(on, { images: [] })
  await start($)
  await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  const lines = w.runs.map(argv => argv.join(' '))
  const sweep = lines.findIndex(line => line.includes('-name .lock -mmin +6'))
  const take = lines.findIndex(line => line === `mkdir ${CWD}/art/fox/.lock`)
  expect(sweep).toBeGreaterThan(-1)
  expect(sweep).toBeLessThan(take)
})

test('啟動的背景工作還沒跑完就呼叫工具，也要找得到生圖資料夾', async ($, on) => {
  const image = `${HOME}/.codex/generated_images/${THREAD}/exec-a.png`
  const w = world(on, { images: [image] })
  await start($)
  await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  expect(w.lists).toContain(`${HOME}/.codex/generated_images/${THREAD}`)
})

test('對話中途 cd 到別的資料夾再重新載入，素材不會消失：看引擎的專案根，不看工作目錄', async ($, on) => {
  const w = world(on, { metas: [meta('fox', [version(1)])] })
  await start($)
  await $.session.start({ cwd: `${CWD}/sub/dir`, surface: 'desktop', isInteractive: true })
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await seen(ui, /fox/)).toBe(true)
  await ui.unmount()
  expect(w.files[`${CWD}/art/fox/meta.json`]).toBeDefined()
})

test('在 git 專案的子資料夾開對話，素材放在專案根目錄', async ($, on) => {
  const w = world(on, { images: [`${HOME}/.codex/generated_images/${THREAD}/exec-a.png`], gitRoot: CWD, sessionRoot: `${CWD}/src/ui` })
  await start($)
  await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  expect(w.files[`${CWD}/art/fox/meta.json`]).toBeDefined()
})

// ---- 列圖檔與開檔：不分平台 ----------------------------------------------------
// 起因：原本用 GNU find 的 -printf 列圖，macOS 的 BSD find 不認得，真的畫出來的圖會被報成「沒有新圖」。
// 當時的測試只餵 GNU 格式的字串給解析函式，所以沒抓到。現在列檔只走引擎的 $.fs.list，下面直接驗它讀到什麼。

const IMAGES = `${HOME}/.codex/generated_images`

test('數本機的圖只走引擎的 $.fs.list：每段對話的資料夾都數到，時間照實讀，不叫 find 也不靠指令的輸出格式', async ($, on) => {
  const NOW = 1_790_000_000_000
  const w = world(on, {
    old: [
      { path: `${IMAGES}/t1/a.png`, mtimeMs: NOW - 60_000 },
      { path: `${IMAGES}/t2/b.png`, mtimeMs: NOW - 120_000 },
      { path: `${IMAGES}/t2/last-week.png`, mtimeMs: NOW - 7 * 86_400_000 },
      { path: `${IMAGES}/t2/notes.txt`, mtimeMs: NOW - 60_000 },
    ],
  })
  await start($)
  await $.tool.call({ tool: 'mcp__easel__status' } as never)
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // 時間單位錯（秒當毫秒）、沒往對話資料夾裡找、或把不是 PNG 的也算進去，這個數字都會不對
  expect(await seen(ui, /今天 2 張/)).toBe(true)
  await ui.unmount()
  expect(w.lists).toContain(IMAGES)
  expect(w.lists).toContain(`${IMAGES}/t1`)
  expect(w.lists).toContain(`${IMAGES}/t2`)
  expect(w.runs.some(argv => argv[0] === 'stat' || argv.includes('-printf') || (argv[0] === 'find' && argv.join(' ').includes('generated_images')))).toBe(false)
})

test('同一段對話多出好幾張時收最新的那張：看修改時間，不看列出來的順序；原本就在的圖再新也不算', async ($, on) => {
  const dir = `${IMAGES}/${THREAD}`
  const w = world(on, {
    metas: [meta('fox', [version(1)])],
    old: [{ path: `${dir}/before.png`, mtimeMs: 9_999_999_999_999 }],
    images: [
      { path: `${dir}/final.png`, mtimeMs: 300_000 },
      { path: `${dir}/first-try.png`, mtimeMs: 200_000 },
    ],
  })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__easel__revise', asset: 'fox', prompt: '圍巾改紅' } as never)
  expect(JSON.stringify(out)).toContain('v2.png')
  const copies = w.runs.filter(argv => argv[0] === 'cp')
  expect(copies).toEqual([['cp', `${dir}/final.png`, `${CWD}/art/fox/v2.png`]])
  expect(w.runs.some(argv => argv[0] === 'find' && argv.join(' ').includes('generated_images'))).toBe(false)
})

test('Codex 跑完但生圖資料夾讀不到：照實說圖可能已經畫好，不報成「沒有新圖」', async ($, on) => {
  const w = world(on, { unreadable: [`${IMAGES}/${THREAD}`] })
  await start($)
  const out = await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  const deny = String((out as { deny?: string }).deny)
  expect(deny).toContain('讀不到生圖資料夾')
  expect(deny).not.toContain('不算數')
  expect(w.files[`${CWD}/art/fox/meta.json`]).toBeUndefined()
})

for (const [name, opts, expected] of [
  ['macOS', { uname: 'Darwin' }, ['open', `${CWD}/art/fox/v1.png`]],
  ['Linux', { uname: 'Linux' }, ['xdg-open', `${CWD}/art/fox/v1.png`]],
  ['WSL', { uname: 'Linux', wsl: true }, ['sh', '-c', 'explorer.exe "$(wslpath -w "$1")"; true', 'sh', `${CWD}/art/fox/v1.png`]],
] as const) {
  test(`開原圖：${name} 用這個平台自己的開檔程式`, async ($, on) => {
    const w = world(on, { metas: [meta('fox', [version(1)])], ...opts })
    await start($)
    await openPane($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'open-fox' })
    await ui.press({ key: 'open-file' })
    await ui.unmount()
    const openers = w.runs.filter(argv => ['open', 'xdg-open'].includes(argv[0] ?? '') || argv.join(' ').includes('explorer.exe'))
    expect(openers).toEqual([[...expected]])
  })
}

test('讀 PNG 檔頭不用 GNU 才有的 base64 -w0', async ($, on) => {
  const w = world(on, { images: [`${IMAGES}/${THREAD}/exec-a.png`] })
  await start($)
  await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  const head = w.runs.find(argv => argv[0] === 'sh' && argv.join(' ').includes('base64'))
  expect(head?.[2]).toBe("head -c 26 \"$1\" | base64 | tr -d '\\n'")
})

// ---- 啟動：各項註冊互不牽連，失敗要看得到 --------------------------------------
// 起因：技能和 plugin 同名時，引擎拒絕註冊 /easel 指令；那一行丟錯讓整個 session.start 被跳過，
// 排在後面的四個工具沒註冊，而且哪裡都看不到原因。當時的替身一律回成功，所以測試全綠。

const ALL_TOOLS = ['mcp__easel__new', 'mcp__easel__revise', 'mcp__easel__self_check', 'mcp__easel__status']
const REFUSAL = '"/easel" refused: it is the plugin\'s /easel:easel'
const BAND = { plugin: 'easel', component: 'AbovePrompt', props: { maxRows: 5, hasSurvey: false } } as const

test('啟動順利：四個工具與 /easel 指令都註冊，沒有任何啟動訊息', async ($, on) => {
  const w = world(on)
  await start($)
  expect(w.tools.slice().sort()).toEqual(ALL_TOOLS)
  expect(w.commands).toEqual(['easel'])
  expect(w.logs).toEqual([])
  await openPane($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await seen(ui, /啟動不完整/)).toBe(false)
  await ui.unmount()
})

test('/easel 指令被引擎拒絕：四個工具照樣註冊、照樣能畫，原因在對話、對話框上方、面板與 status 都看得到', async ($, on) => {
  const w = world(on, { refuseCommand: REFUSAL, images: [`${IMAGES}/${THREAD}/exec-a.png`] })
  await start($)

  expect(w.tools.slice().sort()).toEqual(ALL_TOOLS)
  expect(w.commands).toEqual([])
  expect(w.logs.length).toBe(1)
  expect(w.logs[0]).toContain('/easel 指令')
  expect(w.logs[0]).toContain('refused')

  const drawn = await $.tool.call({ tool: 'mcp__easel__new', asset: 'fox', prompt: '狐狸' } as never)
  expect(JSON.stringify(drawn)).toContain('v1.png')
  const status = await $.tool.call({ tool: 'mcp__easel__status' } as never)
  expect(JSON.stringify(status)).toContain('/easel 指令')

  for (const surface of ['desktop', 'terminal'] as const) {
    // /easel 開不了面板時，對話框上方那一列的「打開」是僅有的入口：按下去要回到首頁，首頁要看得到原因
    const band = await $.ui.mount({ ...BAND, surface } as never)
    expect(await seen(band as never, /啟動不完整：\/easel 指令/)).toBe(true)
    await (band as unknown as { press: (q: { key: string }) => Promise<void> }).press({ key: 'band-open' })
    await band.unmount()
    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await seen(pane, /啟動不完整/)).toBe(true)
    expect(await seen(pane, /refused/)).toBe(true)
    await pane.unmount()
  }
})

test('某一個工具註冊被拒：其他三個工具與 /easel 指令不受牽連，被拒的那個有回報', async ($, on) => {
  const w = world(on, { refuseTools: { revise: 'policy says no' } })
  await start($)
  expect(w.tools.slice().sort()).toEqual(ALL_TOOLS.filter(name => name !== 'mcp__easel__revise'))
  expect(w.commands).toEqual(['easel'])
  expect(w.logs.length).toBe(1)
  expect(w.logs[0]).toContain('工具 revise')
  expect(w.logs[0]).toContain('policy says no')
})

test('重新載入後問題排除了，上次的啟動訊息要清掉', async ($, on) => {
  const opts: World = { refuseCommand: REFUSAL }
  world(on, opts)
  await start($)
  delete opts.refuseCommand
  await start($)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await seen(pane, /啟動不完整/)).toBe(false)
  await pane.unmount()
})

// ---- 縮圖：做法因平台而異，一律查平台表 ----------------------------------------
// Linux 與 WSL 用 ffmpeg 轉 WebP；macOS 用系統內建的 sips 轉 JPEG，不必另外裝 ffmpeg。

const sources = async (ui: Drawing) => (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source ?? ''))

for (const [name, uname, tool, ext, mime] of [
  ['macOS', 'Darwin', 'sips', 'jpg', 'image/jpeg'],
  ['Linux', 'Linux', 'ffmpeg', 'webp', 'image/webp'],
] as const) {
  const other = tool === 'sips' ? 'ffmpeg' : 'sips'
  const widthOf = (argv: string[]) => (tool === 'sips' ? Number(argv[argv.indexOf('--resampleWidth') + 1]) : Number(/scale=(\d+):/.exec(argv.join(' '))?.[1]))
  const qualityOf = (argv: string[]) => Number(argv[argv.indexOf(tool === 'sips' ? 'formatOptions' : '-q:v') + 1])

  test(`縮圖：${name} 用 ${tool}，快取檔副檔名與嵌進圖裡的類型都是 ${ext}`, async ($, on) => {
    const w = world(on, { metas: [meta('fox', [version(1)])], uname })
    await start($)
    await openPane($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'open-fox' })
    const made = w.runs.filter(argv => argv[0] === tool)
    expect(made.length).toBeGreaterThan(0)
    expect(w.runs.some(argv => argv[0] === other)).toBe(false)
    const big = made.find(argv => widthOf(argv) === 840)
    expect(big).toContain(`${CWD}/art/fox/v1.png`)
    expect(big?.at(-1)).toBe(`${CWD}/art/fox/.thumbs/v1-840.${ext}`)
    expect(qualityOf(big ?? [])).toBe(72)
    const drawn = (await sources(ui)).join('\n')
    expect(drawn).toContain(`href="data:${mime};base64,QUJD"`)
    expect(drawn).not.toContain(`data:${mime === 'image/jpeg' ? 'image/webp' : 'image/jpeg'}`)
    await ui.unmount()
  })

  test(`縮圖太大塞不進 Svg：${name} 也要再縮一級重做`, async ($, on) => {
    const w = world(on, { metas: [meta('fox', [version(1)])], uname, thumbs: ['A'.repeat(130_000)] })
    await start($)
    await openPane($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const first = w.runs.filter(argv => argv[0] === tool)
    expect(first.slice(0, 2).map(widthOf)).toEqual([160, 112])
    expect(first.slice(0, 2).map(qualityOf)).toEqual([60, 60])
    expect((await sources(ui)).some(source => source.length > 131_072)).toBe(false)
    await ui.unmount()
  })

  test(`縮圖怎麼縮都太大：${name} 縮幾級就放棄，面板照樣畫得出來，不把塞不進去的圖交出去`, async ($, on) => {
    const w = world(on, { metas: [meta('fox', [version(1)])], uname, hugeThumbs: true })
    await start($)
    await openPane($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'open-fox' })
    const big = w.runs.filter(argv => argv[0] === tool && argv.at(-1) === `${CWD}/art/fox/.thumbs/v1-840.${ext}`)
    expect(big.map(widthOf)).toEqual([840, 588, 412, 288, 202])
    expect(big.map(qualityOf)).toEqual([72, 60, 60, 60, 60])
    const drawn = await sources(ui)
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.some(source => source.length > 131_072)).toBe(false)
    expect(drawn.join('\n')).toContain('縮圖做不出來')
    await ui.unmount()
  })

  test(`縮圖做不出來：${name} 圖位上的話${tool === 'sips' ? '不提 ffmpeg' : '請他確認 ffmpeg'}`, async ($, on) => {
    world(on, { metas: [meta('fox', [version(1)])], uname, noThumbTool: true })
    await start($)
    await openPane($)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'open-fox' })
    const drawn = (await sources(ui)).join('\n')
    expect(drawn).toContain('縮圖做不出來')
    expect(drawn.includes('ffmpeg')).toBe(tool === 'ffmpeg')
    await ui.unmount()
  })
}
