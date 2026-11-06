// easel：用官方 Codex 生圖，在 Claude 裡看圖、審稿與看額度。
//
// Claude 透過這裡註冊的工具生圖；人在 /easel 面板看圖、核准、要求修改。
// 素材紀錄放在專案的 art/<素材>/meta.json，面板只是把它畫出來。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { EaselJob, EaselLogin, EaselMeta, EaselNotice, EaselSetup, EaselUsage, EaselVersion, EaselView } from '../types'
import { assetDir, checkSetup, dropLock, draw, fetchImageTimes, fetchUsage, homeDir, loadAssets, loadMeta, openFile, projectRoot, saveMeta, takeLock, thumbnail } from './codex'
import type { CodexStream } from './codex'
import { ROOT, ago, codexArgv, emptyMeta, findVersion, isDirectImageCall, isValidName, latest, newArgv, newPrompt, nextVersion, parseDeviceAuth, patchVersion, planName, reviseArgv, revisePrompt, usageView } from './model'
import type { UsageView } from './model'
import { STEPS, alertCard, assetCard, assetRow, bigPicture, compare, hero, jobCard, loginCode, setupRow, versionInfo, versionThumb } from './visual'
import type { Drawing } from './visual'

type $ = EngineInterface

const PANE = 'easel'
const PANE_ARGS = { id: PANE, title: 'easel', columns: 64 } as const
const USAGE_EVERY_MS = 10 * 60_000
const LOGIN_MS = 15 * 60_000

const viewAtom = atom({ plugin: 'easel', key: 'view' } as const, { kind: 'home' } as EaselView)
const assetsAtom = atom({ plugin: 'easel', key: 'assets' } as const, [] as EaselMeta[])
const jobsAtom = atom({ plugin: 'easel', key: 'jobs' } as const, [] as EaselJob[])
const usageAtom = atom({ plugin: 'easel', key: 'usage' } as const, null as EaselUsage | null)
const timesAtom = atom({ plugin: 'easel', key: 'imageTimes' } as const, [] as number[])
const setupAtom = atom({ plugin: 'easel', key: 'setup' } as const, { state: 'unknown', version: '' } as EaselSetup)
const loginAtom = atom({ plugin: 'easel', key: 'login' } as const, { state: 'idle' } as EaselLogin)
const noticesAtom = atom({ plugin: 'easel', key: 'notices' } as const, [] as EaselNotice[])
const tickAtom = atom({ plugin: 'easel', key: 'tick' } as const, 0)

type NewInput = { asset?: string; prompt?: string; transparent?: boolean; refs?: string[] }
type ReviseInput = { asset?: string; prompt?: string; base?: number }
type CheckInput = { asset?: string; version?: number; pass?: boolean; note?: string }

const TOOLS = [
  {
    name: 'new',
    isDeferred: false,
    description:
      '用官方 Codex 畫一張新圖，開一個新素材。畫好後回傳圖檔路徑：請用 Read 看圖，對照要求自檢，再呼叫 self_check 記錄結果。' +
      '提示詞請寫清楚用途、素材類型、主體、風格、構圖、尺寸與禁止事項；尺寸和畫質只能寫在提示詞裡。一張約 40 秒。',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: '素材名，小寫英數與連字號，例如 hero-fox' },
        prompt: { type: 'string', description: '生圖提示詞' },
        transparent: { type: 'boolean', description: '要透明背景時設成 true（遊戲角色、圖示等）' },
        refs: { type: 'array', items: { type: 'string' }, description: '參考圖的絕對路徑，例如要對齊的畫風' },
      },
      required: ['asset', 'prompt'],
    },
  },
  {
    name: 'revise',
    isDeferred: false,
    description:
      '修改既有素材，畫下一版。會接回畫底圖的那段 Codex 對話，並自動附上底圖。提示詞要寫明「保留什麼、改什麼」。' +
      '預設以最新版為底；要回到舊版改時才指定 base。自檢不合格時自動修改最多 2 次，之後交給人判斷。',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: '素材名' },
        prompt: { type: 'string', description: '修改要求' },
        base: { type: 'number', description: '以第幾版為底，預設最新版' },
      },
      required: ['asset', 'prompt'],
    },
  },
  {
    name: 'self_check',
    isDeferred: false,
    description: '記錄你看圖自檢的結論，會顯示在審稿面板給人看。自檢要對照要求逐項看，不合格就說明哪裡不對。',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: '素材名' },
        version: { type: 'number', description: '第幾版' },
        pass: { type: 'boolean', description: '是否符合要求' },
        note: { type: 'string', description: '一句話結論，例如「背景維持黃昏，只有圍巾變色」' },
      },
      required: ['asset', 'version', 'pass', 'note'],
    },
  },
  { name: 'status', isDeferred: false, description: '列出這個專案的素材、版本與審稿狀態，以及 Codex 額度。', inputSchema: { type: 'object', properties: {} } },
]

const failureNotice = (asset: string, title: string, detail: string, retry: string, kind: EaselNotice['kind']): EaselNotice => ({ asset, kind, title, detail, retry })

let root = ''
let home = ''
let loginStream: CodexStream | null = null
let tickTimer: Timer | null = null
const streams = new Map<string, CodexStream>()
const cancelled = new Set<string>()

const path = (asset: string) => assetDir(root, asset)

async function refreshAssets($: $): Promise<EaselMeta[]> {
  const list = await loadAssets($, root)
  await update($, assetsAtom, () => list)
  return list
}

async function refreshUsage($: $): Promise<void> {
  const setup = await read($, setupAtom)
  if (setup.state !== 'ready') {
    $.ui.status(undefined)
    return
  }
  const [usage, times] = await Promise.all([fetchUsage($, await $.clock.now()), fetchImageTimes($, home)])
  await update($, timesAtom, () => times)
  if (usage) {
    await update($, usageAtom, () => usage)
    $.ui.status(`Codex ${usage.usedPercent}%`)
  }
}

async function refreshSetup($: $): Promise<EaselSetup> {
  const setup = await checkSetup($)
  await update($, setupAtom, () => setup)
  return setup
}

async function currentUsage($: $): Promise<(UsageView & { plan: string; freeResets: number }) | null> {
  const usage = await read($, usageAtom)
  if (!usage) return null
  const now = await $.clock.now()
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  return { ...usageView(usage, await read($, timesAtom), now, day.getTime()), plan: planName(usage.plan), freeResets: usage.freeResets }
}

// ---- 生圖 ------------------------------------------------------------------

function startTick($: $): void {
  if (tickTimer) return
  tickTimer = $.clock.every(1000, () => {
    update($, tickAtom, n => n + 1).catch(() => undefined)
  })
}

async function endJob($: $, asset: string): Promise<void> {
  streams.delete(asset)
  cancelled.delete(asset)
  await update($, jobsAtom, jobs => jobs.filter(job => job.asset !== asset))
  if ((await read($, jobsAtom)).length === 0 && tickTimer) {
    tickTimer.cancel()
    tickTimer = null
  }
}

async function setPhase($: $, asset: string, phase: EaselJob['phase']): Promise<void> {
  await update($, jobsAtom, jobs => jobs.map(job => (job.asset === asset ? { ...job, phase } : job)))
}

async function notify($: $, notice: EaselNotice): Promise<void> {
  await update($, noticesAtom, list => [...list.filter(n => n.asset !== notice.asset), notice])
}

async function clearNotice($: $, asset: string): Promise<void> {
  await update($, noticesAtom, list => list.filter(n => n.asset !== asset))
}

async function ready($: $): Promise<string | null> {
  const setup = await refreshSetup($)
  if (setup.state === 'missing') return '這台電腦找不到官方 Codex。請在 dev-env-ansible 跑 make install TAGS=codex。'
  if (setup.state === 'logged-out') return 'Codex 還沒登入。請對方打開 /easel 面板完成登入。'
  return null
}

type Job = {
  meta: EaselMeta
  version: number
  base: EaselVersion | null
  prompt: string
  input: string
  argv: string[]
  refs: string[]
  retry: string
}

/** 新圖與修改共用的流程：上鎖、跑 Codex、驗圖、寫紀錄。回給 Claude 的是一段話，失敗就拒絕這次呼叫。 */
async function runJob($: $, job: Job): Promise<{ result: string } | { deny: string }> {
  const { meta, version, base, prompt, input, argv, refs, retry } = job
  const asset = meta.asset
  const dir = path(asset)
  if (!(await takeLock($, dir))) return { deny: `${asset} 正在畫，等它結束再改。不同素材可以同時畫。` }

  const ignore = `${root}/${ROOT}/.gitignore`
  if (!(await $.fs.exists(ignore))) await $.fs.write(ignore, '.work/\n.log/\n.thumbs/\n.lock/\n')
  await clearNotice($, asset)
  await update($, jobsAtom, (jobs): EaselJob[] => [...jobs, { asset, version, base: base?.n ?? null, prompt, phase: 'send', startedAt: Date.now() }])
  startTick($)
  $.ui.open(PANE_ARGS).catch(() => undefined)
  try {
    const outcome = await draw(
      $,
      { home, dir, version, argv, input, threadId: base?.threadId ?? null },
      {
        onThread: () => setPhase($, asset, 'draw'),
        onSaving: () => setPhase($, asset, 'save'),
        onStream: stream => streams.set(asset, stream),
        isCancelled: () => cancelled.has(asset),
      },
    )
    if (outcome.kind === 'cancelled') return { deny: `${asset} v${version} 已被取消。` }
    if (outcome.kind === 'failed') {
      await notify($, failureNotice(asset, `v${version} 沒畫出來`, outcome.message, retry, 'failed'))
      return { deny: `Codex 沒畫出來：${outcome.message}` }
    }
    if (outcome.kind === 'no-image') {
      await notify($, failureNotice(asset, '這次不算數，沒有多一張新圖', 'Codex 回報完成，但生圖資料夾沒有新圖，可能是用程式畫的。', retry, 'no-image'))
      return { deny: 'Codex 回報完成，但生圖資料夾沒有多一張新圖，所以這次不算數。' }
    }
    const entry: EaselVersion = {
      n: version,
      file: outcome.file,
      threadId: outcome.threadId,
      base: base?.n ?? null,
      prompt,
      refs,
      createdAt: Date.now(),
      elapsedS: outcome.elapsedS,
      width: outcome.png.width,
      height: outcome.png.height,
      alpha: outcome.png.alpha,
      selfCheck: 'pending',
      selfNote: '',
      review: 'pending',
      note: '',
    }
    await saveMeta($, root, { ...meta, versions: [...meta.versions, entry] })
    await refreshAssets($)
    await update($, viewAtom, (): EaselView => ({ kind: 'detail', asset, version }))
    $.ui.toast(`${asset} v${version} 畫好了`)
    const file = `${dir}/${outcome.file}`
    if (meta.transparent && !outcome.png.alpha) {
      await notify($, failureNotice(asset, '這張沒有透明背景', '你要求透明，但輸出的圖沒有透明通道。', retry, 'no-alpha'))
      return { result: `已存成 ${file}（v${version}，${outcome.png.width}×${outcome.png.height}），但這張沒有透明通道，不符合要求。請用 revise 重畫。` }
    }
    return { result: `已存成 ${file}（v${version}，${outcome.png.width}×${outcome.png.height}，${outcome.elapsedS} 秒）。請用 Read 看圖，對照要求自檢，再呼叫 self_check。` }
  } finally {
    await dropLock($, dir)
    await endJob($, asset)
    refreshUsage($).catch(() => undefined)
  }
}

async function startNew($: $, input: NewInput): Promise<{ result: string } | { deny: string }> {
  const { asset, prompt, transparent = false, refs = [] } = input
  if (!asset || !isValidName(asset)) return { deny: '素材名只能用小寫英數與連字號，例如 hero-fox。' }
  if (!prompt) return { deny: '缺提示詞。' }
  const problem = await ready($)
  if (problem) return { deny: problem }
  if (await loadMeta($, root, asset)) return { deny: `${asset} 已經存在。要改它請用 revise，要新素材請換名字。` }
  const setup = await read($, setupAtom)
  const meta = emptyMeta(asset, transparent, setup.version)
  return runJob($, {
    meta,
    version: 1,
    base: null,
    prompt,
    input: newPrompt(prompt, transparent),
    argv: newArgv(`${path(asset)}/.work`, refs),
    refs,
    retry: `請用 easel 重畫 ${asset}：${prompt}`,
  })
}

async function startRevise($: $, input: ReviseInput): Promise<{ result: string } | { deny: string }> {
  const { asset, prompt, base } = input
  if (!asset || !prompt) return { deny: '缺素材名或修改要求。' }
  const problem = await ready($)
  if (problem) return { deny: problem }
  const meta = await loadMeta($, root, asset)
  if (!meta) return { deny: `找不到素材 ${asset}。新素材請用 new。` }
  const from = base === undefined ? latest(meta) : findVersion(meta, base)
  if (!from) return { deny: `${asset} 沒有 v${base}。` }
  const version = nextVersion(meta)
  return runJob($, {
    meta,
    version,
    base: from,
    prompt,
    input: revisePrompt(prompt, from.n, meta.transparent),
    argv: reviseArgv(`${path(asset)}/.work`, from.threadId, `${path(asset)}/${from.file}`),
    refs: [],
    retry: `請用 easel 改 ${asset}（以 v${from.n} 為底）：${prompt}`,
  })
}

async function changeVersion($: $, asset: string, n: number, patch: Partial<EaselVersion>): Promise<boolean> {
  const meta = await loadMeta($, root, asset)
  if (!meta || !findVersion(meta, n)) return false
  await saveMeta($, root, patchVersion(meta, n, patch))
  await refreshAssets($)
  return true
}

// ---- 登入 ------------------------------------------------------------------

async function startLogin($: $): Promise<void> {
  if (loginStream) void loginStream.return({ code: null, signal: null })
  await update($, loginAtom, (): EaselLogin => ({ state: 'starting' }))
  const stream = $.process.spawn({ argv: codexArgv(['login', '--device-auth']) }) as CodexStream
  loginStream = stream
  void (async () => {
    let text = ''
    try {
      for await (const chunk of stream) {
        text += chunk.text
        const found = parseDeviceAuth(text)
        if (found && (await read($, loginAtom)).state === 'starting') {
          const until = (await $.clock.now()) + LOGIN_MS
          await update($, loginAtom, (): EaselLogin => ({ state: 'waiting', ...found, until }))
        }
      }
      const { code } = await stream.result
      if (loginStream !== stream) return
      loginStream = null
      if (code === 0) {
        await update($, loginAtom, (): EaselLogin => ({ state: 'idle' }))
        await refreshSetup($)
        await refreshUsage($)
        $.ui.toast('Codex 登入完成')
      } else {
        await update($, loginAtom, (): EaselLogin => ({ state: 'failed', message: text.trim().split('\n').at(-1) ?? '登入沒有完成。' }))
      }
    } catch {
      // 被「重新產生」中止，新的那條會接手
    }
  })()
}

export const register: Register = on => {
  // ---- 引擎事件 --------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    // 用引擎的專案根，不用 e.cwd：工作目錄會跟著 shell 的 cd 變，素材不能跟著跑
    root = await projectRoot($, await $.session.root())
    await $.command.register({ name: 'easel', description: '打開 easel：看圖、審稿與 Codex 額度' })
    await Promise.all(TOOLS.map(tool => $.tool.register(tool)))
    const started = await next(e)
    void (async () => {
      home = await homeDir($)
      await refreshAssets($)
      await refreshSetup($)
      await refreshUsage($)
    })().catch(() => undefined)
    $.clock.every(USAGE_EVERY_MS, () => {
      refreshUsage($).catch(() => undefined)
    })
    return started
  })

  on('command.run', { command: 'easel' }, async $ => {
    await refreshAssets($)
    await refreshSetup($)
    refreshUsage($).catch(() => undefined)
    await update($, viewAtom, (): EaselView => ({ kind: 'home' }))
    await $.ui.open(PANE_ARGS)
    return { text: 'easel 面板已開啟。' }
  })

  on('tool.call', { tool: 'mcp__easel__new' }, ($, e) => startNew($, e as unknown as NewInput)).catch(() => ({ deny: 'easel 內部出錯，這次沒有畫。' }))
  on('tool.call', { tool: 'mcp__easel__revise' }, ($, e) => startRevise($, e as unknown as ReviseInput)).catch(() => ({ deny: 'easel 內部出錯，這次沒有畫。' }))

  on('tool.call', { tool: 'mcp__easel__self_check' }, async ($, e) => {
    const { asset, version, pass, note = '' } = e as unknown as CheckInput
    if (!asset || version === undefined) return { deny: '缺素材名或版本。' }
    const done = await changeVersion($, asset, version, { selfCheck: pass ? 'pass' : 'fail', selfNote: note })
    return done ? { result: `已記錄 ${asset} v${version} 的自檢。` } : { deny: `找不到 ${asset} v${version}。` }
  }).catch(() => ({ deny: 'easel 內部出錯，沒有記錄。' }))

  on('tool.call', { tool: 'mcp__easel__status' }, async $ => {
    await ready($)
    if (!(await read($, usageAtom))) await refreshUsage($)
    const assets = await refreshAssets($)
    const usage = await currentUsage($)
    const lines = assets.map(meta => {
      const last = latest(meta)
      return `${meta.asset}: ${meta.versions.length} 版，最新 v${last?.n ?? 0}（${last?.review ?? '無'}）`
    })
    return { result: [usage ? `Codex 額度已用 ${usage.percent}%，${usage.reset} 重置。` : 'Codex 額度未知。', ...lines].join('\n') }
  }).catch(() => ({ deny: 'easel 內部出錯，查不到狀態。' }))

  // Claude 自己叫 codex 生圖的話，easel 收不到圖也沒有檢查。其他 codex 用法不受影響。
  on('tool.call', { tool: 'Bash' }, ($, e, next) => (isDirectImageCall(e.command) ? { deny: '生圖請用 easel 的 new 或 revise 工具，不要直接呼叫 codex。' } : next(e))).catch(($, e, next) => next(e))

  // 對話框上方：有事才出現，一次只講最要緊的一件。照 mod 共用的約定疊在下層上面，不獨佔。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const jobs = await read($, jobsAtom)
    const assets = await read($, assetsAtom)
    const usage = await currentUsage($)
    const job = jobs[0]
    const waiting = assets.filter(meta => latest(meta)?.review === 'pending' && !jobs.some(j => j.asset === meta.asset))
    const first = waiting[0]
    const line = job
      ? `正在畫 ${job.asset} v${job.version}`
      : first
        ? `${first.asset} v${latest(first)?.n} 等你審${waiting.length > 1 ? `（共 ${waiting.length} 個）` : ''}`
        : usage && usage.tone !== 'none'
          ? `Codex 額度已用 ${usage.percent}%`
          : null
    if (!line || e.props.hasSurvey) return next(e)

    const below = await next({ ...e, props: { ...e.props, maxRows: Math.max(0, e.props.maxRows - 1) } })
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={job ? 'suggestion' : usage?.tone === 'warn' && waiting.length === 0 ? 'warning' : undefined}>{job ? '●' : waiting.length > 0 ? '▲' : '▲'}</Text>
          <Text>{line}</Text>
          <Button
            key="band-open"
            label="打開"
            onPress={async () => {
              if (!job && first) {
                const last = latest(first)
                if (last) await update($, viewAtom, (): EaselView => ({ kind: 'detail', asset: first.asset, version: last.n }))
              }
              await $.ui.open(PANE_ARGS)
            }}
          />
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const Input = e.surface !== 'mobile' && 'Input' in table ? table.Input : undefined
    const isMobile = e.surface === 'mobile'
    await read($, tickAtom) // 生成中每秒重畫一次，秒數才會走

    /** 畫一張圖；終端機沒有 Svg，改用圖的說明文字。 */
    const art = (key: string, drawing: Drawing): RenderElement =>
      Svg ? <Svg key={key} source={drawing.source} alt={drawing.alt} {...(drawing.animated ? { isInteractive: true as const } : {})} /> : <Text>{drawing.alt}</Text>
    const section = (key: string, title: string, ...body: (RenderElement | null)[]): RenderElement => (
      <Box key={key} flexDirection="column" gap={1}>
        <Text bold dimColor>
          {title}
        </Text>
        {body}
      </Box>
    )
    const frame = (key: string, tone: string | undefined, ...body: (RenderElement | null)[]): RenderElement => (
      <Box key={key} flexDirection="column" borderStyle="round" {...(tone ? { borderColor: tone } : {})} paddingX={1} paddingY={Svg ? 1 : 0} gap={1}>
        {body}
      </Box>
    )
    const row = (key: string, ...body: (RenderElement | null)[]): RenderElement => (
      <Box key={key} flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        {body}
      </Box>
    )
    const go = (target: EaselView) => () => update($, viewAtom, () => target)
    const review = (asset: string, n: number, state: 'approved' | 'rejected') => () => changeVersion($, asset, n, { review: state })

    const noticeCards = async (asset?: string): Promise<RenderElement[]> => {
      const list = await read($, noticesAtom)
      return list
        .filter(n => asset === undefined || n.asset === asset)
        .map(n =>
          frame(
            `notice-${n.asset}`,
            n.kind === 'failed' ? 'error' : 'warning',
            art(`notice-art-${n.asset}`, alertCard({ tone: n.kind === 'failed' ? 'crit' : 'warn', title: `${n.asset}：${n.title}`, detail: n.detail })),
            row(
              `notice-btn-${n.asset}`,
              <Button
                key={`retry-${n.asset}`}
                label="重畫"
                variant="primary"
                onPress={async () => {
                  await clearNotice($, n.asset)
                  await $.prompt.submit({ text: n.retry, asUser: true })
                }}
              />,
              <Button key={`dismiss-${n.asset}`} label="知道了" onPress={() => clearNotice($, n.asset)} />,
            ),
          ),
        )
    }

    const jobFrame = async (job: EaselJob): Promise<RenderElement> => {
      const seconds = Math.max(0, Math.round((Date.now() - job.startedAt) / 1000))
      const step = job.phase === 'send' ? 0 : job.phase === 'draw' ? 1 : 2
      const label = STEPS[step]
      return frame(
        `job-${job.asset}`,
        'suggestion',
        art(`job-art-${job.asset}`, jobCard({ title: `正在畫 ${job.asset} v${job.version}`, sub: `已 ${seconds} 秒，通常約 40 秒`, step })),
        !Svg ? <Text>{`進度：${label}`}</Text> : null,
        <Button
          key={`cancel-${job.asset}`}
          label="取消"
          onPress={() => {
            cancelled.add(job.asset)
            void streams.get(job.asset)?.return({ code: null, signal: null })
          }}
        />,
      )
    }

    const setupCards = async (): Promise<RenderElement[]> => {
      const setup = await read($, setupAtom)
      if (setup.state === 'ready' || setup.state === 'unknown') return []
      if (setup.state === 'missing') {
        return [
          section(
            'setup',
            '開始使用',
            frame(
              'setup-missing',
              'warning',
              <Text>這台電腦找不到官方 Codex。請在 dev-env-ansible 安裝：</Text>,
              <Text>make install TAGS=codex</Text>,
              row(
                'setup-btns',
                <Button key="copy-install" label="複製指令" onPress={() => $.ui.copy({ text: 'make install TAGS=codex' })} />,
                <Button key="recheck" label="重新檢查" onPress={() => refreshSetup($)} />,
              ),
            ),
          ),
        ]
      }
      const login = await read($, loginAtom)
      return [
        section(
          'setup',
          '登入 ChatGPT',
          frame(
            'setup-login',
            'suggestion',
            art('setup-codex', setupRow({ label: `Codex ${setup.version}`, badge: { tone: 'ok', text: '已安裝' } })),
            art('setup-account', setupRow({ label: 'ChatGPT 帳號', badge: { tone: 'warn', text: '還沒登入' } })),
            login.state === 'waiting' ? <Text>打開登入頁，手機或電腦都可以，然後輸入下面這組代碼：</Text> : null,
            login.state === 'waiting' ? art('login-code', loginCode(login.code)) : null,
            login.state === 'waiting' ? <Text dimColor>代碼 15 分鐘內有效，登入完成這裡會自動往下。</Text> : null,
            login.state === 'failed' ? <Text color="warning">{login.message}</Text> : null,
            login.state === 'waiting' ? (
              row(
                'login-btns',
                'Link' in table ? <table.Link key="login-link" href={login.url} label="開啟登入頁" /> : <Text>{login.url}</Text>,
                <Button key="copy-code" label="複製代碼" onPress={() => $.ui.copy({ text: login.code })} />,
                <Button key="relogin" label="重新產生" onPress={() => startLogin($)} />,
              )
            ) : (
              <Button key="login" label={login.state === 'starting' ? '準備中…' : '開始登入'} variant="primary" onPress={() => startLogin($)} />
            ),
            login.state === 'waiting' ? <Text dimColor>頁面顯示這種登入沒開啟？到 ChatGPT 的安全性設定打開後，按「重新產生」。</Text> : null,
          ),
        ),
      ]
    }

    const homePage = async (): Promise<RenderElement> => {
      const assets = (await read($, assetsAtom)).slice().sort((a, b) => (latest(b)?.createdAt ?? 0) - (latest(a)?.createdAt ?? 0))
      const jobs = await read($, jobsAtom)
      const usage = await currentUsage($)
      const busy = new Set(jobs.map(job => job.asset))
      const pending = assets.filter(meta => latest(meta)?.review === 'pending' && !busy.has(meta.asset))
      const others = assets.filter(meta => !pending.includes(meta))
      const now = await $.clock.now()

      const card = async (meta: EaselMeta): Promise<RenderElement> => {
        const last = latest(meta) as EaselVersion
        const data = await thumbnail($, path(meta.asset), `v${last.n}`, 160)
        const note = last.selfCheck === 'pending' ? undefined : `${last.selfCheck === 'pass' ? '✓' : '✗'} 自檢：${last.selfNote}`
        return frame(
          `pending-${meta.asset}`,
          'warning',
          art(`pending-art-${meta.asset}`, assetCard({ name: meta.asset, sub: `v${last.n}・${ago(last.createdAt, now)}${last.base ? `・以 v${last.base} 為底` : ''}`, ...(note ? { note, noteTone: last.selfCheck === 'pass' ? 'ok' : 'crit' } : {}), badge: { tone: 'warn', text: '待審' }, thumb: data, alpha: last.alpha })),
          row(
            `pending-btn-${meta.asset}`,
            <Button key={`open-${meta.asset}`} label="打開審稿" variant="primary" onPress={go({ kind: 'detail', asset: meta.asset, version: last.n })} />,
            <Button key={`quick-${meta.asset}`} label="直接核准" onPress={review(meta.asset, last.n, 'approved')} />,
          ),
        )
      }

      const listRow = async (meta: EaselMeta): Promise<RenderElement | null> => {
        const last = latest(meta)
        if (!last) return null
        const data = await thumbnail($, path(meta.asset), `v${last.n}`, 96)
        const badge = last.review === 'approved' ? { tone: 'ok', text: '已核准' } : last.review === 'rejected' ? { tone: 'none', text: '退回' } : { tone: 'warn', text: '待審' }
        return row(
          `row-${meta.asset}`,
          art(`row-art-${meta.asset}`, assetRow({ name: meta.asset, sub: `v${last.n}・${ago(last.createdAt, now)}${meta.transparent ? '・透明' : ''}`, badge, thumb: data, alpha: last.alpha })),
          <Button key={`row-open-${meta.asset}`} label="打開" onPress={go({ kind: 'detail', asset: meta.asset, version: last.n })} />,
        )
      }

      const empty = assets.length === 0 && jobs.length === 0
      return (
        <Box flexDirection="column" gap={2}>
          {art('hero', hero(usage))}
          {!Svg && usage ? <Text>{`額度已用 ${usage.percent}%，${usage.reset} 重置・今天 ${usage.today} 張`}</Text> : null}
          {usage?.tone === 'crit' ? frame('out', 'error', art('out-art', alertCard({ tone: 'crit', title: `額度用完了，${usage.reset} 才能再畫`, detail: `${usage.freeResets > 0 ? `你的帳號還有 ${usage.freeResets} 次免費重置。` : ''}現有素材照常能看與核准。` }))) : null}
          {await setupCards()}
          {await noticeCards()}
          {pending.length > 0 ? section('pending', `等你審（${pending.length}）`, ...(await Promise.all(pending.map(card)))) : null}
          {jobs.length > 0 ? section('jobs', `正在畫（${jobs.length}）`, ...(await Promise.all(jobs.map(jobFrame)))) : null}
          {others.length > 0 ? section('assets', `素材（${others.length}）`, frame('assets-box', undefined, ...((await Promise.all(others.map(listRow))).filter(Boolean) as RenderElement[]))) : null}
          {empty ? <Text dimColor>還沒有素材。在對話裡說「幫我畫…」就會開新素材。</Text> : <Text dimColor>在對話裡說「幫我畫…」就會開新素材。</Text>}
        </Box>
      )
    }

    const missing = (text: string): RenderElement => (
      <Box flexDirection="column" gap={1}>
        <Text>{text}</Text>
        <Button key="back-home" label="‹ 素材" onPress={go({ kind: 'home' })} />
      </Box>
    )

    const detailPage = async (asset: string, n: number): Promise<RenderElement> => {
      const meta = (await read($, assetsAtom)).find(one => one.asset === asset)
      const current = meta && findVersion(meta, n)
      if (!meta || !current) return missing(`找不到 ${asset} v${n}。`)
      const dir = path(asset)
      const sorted = meta.versions.slice().sort((a, b) => a.n - b.n)
      const index = sorted.findIndex(v => v.n === n)
      const prev = sorted[index - 1]
      const file = `${dir}/${current.file}`
      const jobs = await read($, jobsAtom)
      const job = jobs.find(one => one.asset === asset)
      const big = await thumbnail($, dir, `v${n}`, 840)
      const strip = await Promise.all(sorted.map(async v => ({ n: v.n, data: await thumbnail($, dir, `v${v.n}`, 128), selected: v.n === n, approved: v.review === 'approved', alpha: v.alpha })))
      const badge = current.review === 'approved' ? '已核准' : current.review === 'rejected' ? '退回' : '待審'
      const check = current.selfCheck === 'pending' ? null : { tone: current.selfCheck === 'pass' ? 'ok' : 'crit', text: `${current.selfCheck === 'pass' ? '✓' : '✗'} 自檢：${current.selfNote}` }

      return (
        <Box flexDirection="column" gap={2}>
          {row(
            'head',
            <Button key="back" label="‹ 素材" onPress={go({ kind: 'home' })} />,
            <Text bold>{asset}</Text>,
            <Text dimColor>{`v${n}・${badge}`}</Text>,
          )}
          {await noticeCards(asset)}
          {job ? await jobFrame(job) : null}
          {Svg ? (
            art('big', bigPicture({ data: big, width: current.width, height: current.height, alpha: current.alpha, alt: `${asset} 第 ${n} 版。${current.prompt}` }))
          ) : 'Image' in table ? (
            <table.Image key="big-term" source={{ file, format: 'png' }} columns={40} rows={20} alt={`${asset} 第 ${n} 版`} />
          ) : (
            <Text>{file}</Text>
          )}
          <Box key="versions" flexDirection="row" gap={1} flexWrap="wrap">
            {strip.map(v => (
              <Box key={`ver-box-${v.n}`} flexDirection="column" gap={0} alignItems="center">
                {Svg ? art(`ver-art-${v.n}`, versionThumb(v)) : null}
                <Button key={`ver-${v.n}`} label={`v${v.n}`} {...(v.selected ? { variant: 'primary' as const } : {})} onPress={go({ kind: 'detail', asset, version: v.n })} />
              </Box>
            ))}
          </Box>
          {prev ? <Button key="compare" label={`與 v${prev.n} 比較`} onPress={go({ kind: 'compare', asset, version: n })} /> : null}
          {section(
            'this',
            '這一版',
            frame(
              'this-box',
              undefined,
              art(
                'this-art',
                versionInfo({
                  prompt: current.prompt,
                  base: current.base ? `v${current.base}` : '新圖',
                  spec: `${current.width}×${current.height}${current.alpha ? '・透明' : ''}・${current.elapsedS} 秒`,
                  check,
                }),
              ),
            ),
          )}
          {current.review === 'pending'
            ? section(
                'review',
                '審稿',
                frame(
                  'review-box',
                  'warning',
                  row(
                    'review-btns',
                    <Button key="approve" label={`核准 v${n}`} variant="primary" onPress={review(asset, n, 'approved')} />,
                    <Button key="reject" label="退回" onPress={review(asset, n, 'rejected')} />,
                  ),
                  Input ? (
                    <Input
                      key="ask"
                      label="想改什麼？"
                      placeholder="例如：圍巾再長一點"
                      submitLabel="送出"
                      onSubmit={async value => {
                        if (value.trim()) await $.prompt.submit({ text: `請用 easel 改 ${asset}（以 v${n} 為底）：${value.trim()}`, asUser: true })
                      }}
                    />
                  ) : (
                    <Text dimColor>{isMobile ? '想改什麼，在對話裡告訴 Claude 就好。' : '想改什麼，在對話裡告訴 Claude。'}</Text>
                  ),
                ),
              )
            : row(
                'reopen',
                <Text dimColor>{current.review === 'approved' ? '這一版已核准。' : '這一版已退回。'}</Text>,
                <Button key="unreview" label="改回待審" onPress={() => changeVersion($, asset, n, { review: 'pending' })} />,
              )}
          <Text dimColor>{`${ROOT}/${asset}/${current.file}`}</Text>
          {row(
            'file-btns',
            <Button key="open-file" label="開原圖" onPress={() => openFile($, file)} />,
            <Button key="copy-path" label="複製路徑" onPress={() => $.ui.copy({ text: file })} />,
          )}
        </Box>
      )
    }

    const comparePage = async (asset: string, n: number): Promise<RenderElement> => {
      const meta = (await read($, assetsAtom)).find(one => one.asset === asset)
      const right = meta && findVersion(meta, n)
      const sorted = meta?.versions.slice().sort((a, b) => a.n - b.n) ?? []
      const left = sorted[sorted.findIndex(v => v.n === n) - 1]
      if (!meta || !right || !left) return missing('沒有可以比較的上一版。')
      const dir = path(asset)
      const [a, b] = await Promise.all([thumbnail($, dir, `v${left.n}`, 420), thumbnail($, dir, `v${right.n}`, 420)])
      return (
        <Box flexDirection="column" gap={2}>
          {row('head', <Button key="back" label="‹ 審稿" onPress={go({ kind: 'detail', asset, version: n })} />, <Text bold>{`v${left.n} 與 v${right.n}`}</Text>)}
          {art('pair', compare({ left: { label: `v${left.n}`, badge: '上一版', data: a }, right: { label: `v${right.n}`, badge: '這一版', data: b }, ratio: right.height / Math.max(1, right.width), alpha: right.alpha }))}
          {section('why', '這一步改了什麼', frame('why-box', undefined, <Text>{`要求：${right.prompt}`}</Text>, right.selfNote ? <Text color={right.selfCheck === 'pass' ? 'success' : 'error'}>{`${right.selfCheck === 'pass' ? '✓' : '✗'} 自檢：${right.selfNote}`}</Text> : null))}
          {section(
            'keep',
            '要留哪一版',
            frame(
              'keep-box',
              undefined,
              row(
                'keep-btns',
                <Button key="keep-right" label={`核准 v${right.n}`} variant="primary" onPress={review(asset, right.n, 'approved')} />,
                <Button key="keep-left" label={`改用 v${left.n} 當底再畫`} onPress={() => $.prompt.submit({ text: `請用 easel 以 ${asset} 的 v${left.n} 為底再畫一版，先問我要改什麼。`, asUser: true })} />,
              ),
            ),
          )}
        </Box>
      )
    }

    const view = await read($, viewAtom)
    if (view.kind === 'detail') return detailPage(view.asset, view.version)
    if (view.kind === 'compare') return comparePage(view.asset, view.version)
    return homePage()
  })
}
