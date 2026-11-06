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

type World = {
  metas?: EaselMeta[]
  /** codex login status 的回答 */
  login?: string
  /** 沒裝 codex */
  noCodex?: boolean
  /** 生圖後資料夾多出來的檔；空的＝模型沒真的生圖 */
  images?: string[]
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
  let drawn = false
  for (const m of opts.metas ?? []) {
    files[`${CWD}/art/${m.asset}/meta.json`] = JSON.stringify(m)
    for (const v of m.versions) files[`${CWD}/art/${m.asset}/${v.file}`] = 'png'
  }
  const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  on('command.register', () => ({ value: { command: 'easel' } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__easel__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: opts.sessionRoot ?? CWD }))
  mock.clock(on, { now: 1_790_000_000_000 })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', ($, e) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('.webp')) return { value: { base64: 'QUJD' } }
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const names = new Set(
      Object.keys(files)
        .filter(f => f.startsWith(`${e.path}/`))
        .map(f => f.slice(e.path.length + 1).split('/')[0] as string),
    )
    return { value: [...names].map(name => ({ name, kind: 'dir' as const, size: 1, mtimeMs: 1, isLink: false })) }
  })
  on('process.run', ($, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const line = argv.join(' ')
    if (argv[0] === 'sh' && line.includes('$HOME')) return out(HOME)
    if (line.includes('--version')) return opts.noCodex ? out('', 127) : out('codex-cli 0.167.0\n')
    if (line.includes('login status')) return out(opts.login ?? 'Logged in using ChatGPT\n')
    if (line.includes('app-server')) {
      return out(`${JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 43200, resetsAt: 2_000_000_000 }, planType: 'go' }, rateLimitResetCredits: { availableCount: 2 } } })}\n`)
    }
    if (argv[0] === 'find' && line.includes(THREAD)) {
      return out(drawn ? (opts.images ?? []).map((p, i) => `${100 + i}.5 ${p}\n`).join('') : '')
    }
    if (argv[0] === 'git') return opts.gitRoot ? out(`${opts.gitRoot}\n`) : out('', 128)
    if (argv[0] === 'find') return out('')
    if (argv[0] === 'mkdir' && opts.locked && argv[1]?.endsWith('/.lock')) return out('', 1)
    if (argv[0] === 'sh' && line.includes('base64')) return out(RGB_HEAD)
    return out('')
  })
  on('process.spawn', async function* ($, e) {
    spawns.push({ argv: e.argv, ...(e.input === undefined ? {} : { input: e.input }) })
    drawn = true
    for (const line of opts.events ?? [`{"type":"thread.started","thread_id":"${THREAD}"}`]) yield { stream: 'stdout' as const, text: `${line}\n` }
    return { value: { code: 0, signal: null } }
  })
  return { files, runs, spawns }
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
  expect(await seen(ui, /make install TAGS=codex/)).toBe(true)
  await ui.unmount()
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
  expect(w.runs.some(argv => argv[0] === 'find' && argv[1] === `${HOME}/.codex/generated_images/${THREAD}`)).toBe(true)
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
