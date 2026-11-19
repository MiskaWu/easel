// easel：用官方 Codex 生圖，在 Claude 裡看圖、審稿與看額度。
//
// Claude 透過這裡註冊的工具生圖；人在 /easel 面板看圖、核准、要求修改。
// 素材紀錄放在專案的 art/<素材>/meta.json，面板只是把它畫出來。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { EaselHome, EaselJob, EaselLogin, EaselMeta, EaselNotice, EaselSetup, EaselStartupProblem, EaselUsage, EaselVersion, EaselView } from '../types'
import { assetDir, checkSetup, dropLock, draw, fetchImageTimes, fetchUsage, homeDir, loadAssets, loadMeta, openFile, projectRoot, saveMeta, takeLock, thumbnail } from './codex'
import type { CodexStream } from './codex'
import { LIMIT_SOURCE_TEXT, PENDING_CARDS, REVIEW_TEXT, REVISE_LIMIT, ROOT, STATUS_PENDING_LINES, ago, autoStepText, autoStreak, codexArgv, codexInstall, codexMissingText, emptyMeta, findVersion, isDirectImageCall, isValidName, latest, limitReachedText, limitText, newArgv, newPrompt, nextVersion, pageOf, parseDeviceAuth, pendingByRecency, patchVersion, planName, resolveLimit, reviseArgv, revisePrompt, reviseStep, reviewCounts, splitPending, storedLimitAfter, thumbnailer, uncheckedText, usageView } from './model'
import type { ReviseLimit, UsageView } from './model'
import { STEPS, alertCard, assetCard, assetRow, bigPicture, compare, hero, jobCard, limitCard, loginCode, moreCard, setupRow, versionInfo, versionThumb } from './visual'
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
const startupAtom = atom({ plugin: 'easel', key: 'startup' } as const, [] as EaselStartupProblem[])
const tickAtom = atom({ plugin: 'easel', key: 'tick' } as const, 0)
/** 面板上調的自動修改上限。真正的值在 $.store（跨對話），這裡是給面板重畫用的鏡像，只由 storeLimit 寫。 */
const limitAtom = atom({ plugin: 'easel', key: 'reviseLimit' } as const, null as number | null)
/** $.store 裡存面板上限的鍵 */
const LIMIT_KEY = 'reviseLimit'
const HOME: EaselHome = { earlierOpen: false, earlierPage: 0, assetsPage: 0, confirm: null }
/** 首頁的分頁與「全部收起來」的確認 */
const homeAtom = atom({ plugin: 'easel', key: 'home' } as const, HOME)

type NewInput = { asset?: string; prompt?: string; transparent?: boolean; refs?: string[] }
type ReviseInput = { asset?: string; prompt?: string; base?: number; limit?: number }
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
      '預設以最新版為底；要回到舊版改時才指定 base。' +
      '底圖那一版要先有自檢結果：還沒自檢（人也還沒在面板審過）就會拒絕，先用 Read 看圖、用 self_check 記錄，再決定要不要改。' +
      `接在自檢不合格的版本後面的修改算自動修改，easel 會數連續幾次：上限預設 ${REVISE_LIMIT.default} 次，使用者可以在 /easel 面板調。` +
      '到上限時這個工具會拒絕、不畫，這時停下來把各版的自檢結果交給使用者判斷。現在的上限用 status 查，每次自動修改的結果也會寫是第幾次。',
    inputSchema: {
      type: 'object',
      properties: {
        asset: { type: 'string', description: '素材名' },
        prompt: { type: 'string', description: '修改要求' },
        base: { type: 'number', description: '以第幾版為底，預設最新版' },
        limit: {
          type: 'integer',
          description:
            `這次的自動修改上限（${REVISE_LIMIT.min} 到 ${REVISE_LIMIT.max}，超出會夾住，0 是不自動修改）。` +
            '只有使用者在對話裡說了這次可以改幾次才帶，這一輪接下來的 revise 都帶同一個數字；使用者沒說就不要帶，也不要自己加大。',
        },
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

// ---- 自動修改的上限 ------------------------------------------------------------
// 唯一的來源是 $.store 的 reviseLimit：revise 的判斷、status、面板都經過 readLimit 讀它，按鈕經過 storeLimit 寫它。

/** 現在的上限。requested 是這次 revise 帶的 limit；順手把 $.store 的值同步到面板的鏡像（別的對話可能調過）。 */
async function readLimit($: $, requested?: unknown): Promise<ReviseLimit> {
  const stored = await $.store.get(LIMIT_KEY)
  const panel = resolveLimit(stored)
  const mirror = panel.source === 'panel' ? panel.limit : null
  if ((await read($, limitAtom)) !== mirror) await update($, limitAtom, () => mirror)
  return resolveLimit(stored, requested)
}

/** 存面板上調的值；null 是恢復預設。立刻生效：下一次 revise、status 讀到的就是它，面板跟著重畫。 */
async function storeLimit($: $, value: number | null): Promise<void> {
  if (value === null) await $.store.delete(LIMIT_KEY)
  else await $.store.set(LIMIT_KEY, value)
  await update($, limitAtom, () => value)
}

/** 面板的增加、減少：從 $.store 現在的值算，不從畫面上的數字算。 */
async function stepLimit($: $, delta: number): Promise<void> {
  const { limit } = await readLimit($)
  await storeLimit($, storedLimitAfter(limit, delta))
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

const NOT_LOCATED = 'easel 啟動時沒找到專案或家目錄的位置，這次不能畫。請對方輸入 /reload-plugins 再試，並看 /easel 面板上的啟動訊息。'

async function ready($: $): Promise<string | null> {
  // 啟動時沒找到這兩個位置就不能畫：素材會寫錯地方，畫好的圖也收不回來
  if (!root || !home) return NOT_LOCATED
  const setup = await refreshSetup($)
  if (setup.state === 'missing') return codexMissingText(setup.platform ?? 'linux')
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
  /** 這次是自動修改（記進這一版的 auto，下次數連續次數用） */
  auto: boolean
  /** 畫好時補在結果後面的話，例如「這是連續第 1 次自動修改，上限 2 次」；沒有就是空字串 */
  note: string
}

/** 新圖與修改共用的流程：上鎖、跑 Codex、驗圖、寫紀錄。回給 Claude 的是一段話，失敗就拒絕這次呼叫。 */
async function runJob($: $, job: Job): Promise<{ result: string } | { deny: string }> {
  const { meta, version, base, prompt, input, argv, refs, retry, auto, note } = job
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
      auto,
    }
    await saveMeta($, root, { ...meta, versions: [...meta.versions, entry] })
    await refreshAssets($)
    await update($, viewAtom, (): EaselView => ({ kind: 'detail', asset, version }))
    $.ui.toast(`${asset} v${version} 畫好了`)
    const file = `${dir}/${outcome.file}`
    if (meta.transparent && !outcome.png.alpha) {
      await notify($, failureNotice(asset, '這張沒有透明背景', '你要求透明，但輸出的圖沒有透明通道。', retry, 'no-alpha'))
      return { result: `已存成 ${file}（v${version}，${outcome.png.width}×${outcome.png.height}），但這張沒有透明通道，不符合要求。請用 revise 重畫。${note}` }
    }
    return { result: `已存成 ${file}（v${version}，${outcome.png.width}×${outcome.png.height}，${outcome.elapsedS} 秒）。請用 Read 看圖，對照要求自檢，再呼叫 self_check。${note}` }
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
    auto: false,
    note: '',
  })
}

async function startRevise($: $, input: ReviseInput): Promise<{ result: string } | { deny: string }> {
  const { asset, prompt, base, limit } = input
  if (!asset || !prompt) return { deny: '缺素材名或修改要求。' }
  if (!root || !home) return { deny: NOT_LOCATED }
  const meta = await loadMeta($, root, asset)
  if (!meta) return { deny: `找不到素材 ${asset}。新素材請用 new。` }
  const from = base === undefined ? latest(meta) : findVersion(meta, base)
  if (!from) return { deny: `${asset} 沒有 v${base}。` }
  // 自檢與上限都在問 Codex 的狀態之前判斷：擋下來時連 codex --version 都不跑
  const step = reviseStep(meta, from)
  if (step.kind === 'unchecked') return { deny: uncheckedText(asset, from.n) }
  let note = ''
  if (step.kind === 'auto') {
    const cap = await readLimit($, limit)
    if (step.k > cap.limit) return { deny: limitReachedText(asset, step.k - 1, cap) }
    note = autoStepText(step.k, cap)
  }
  const problem = await ready($)
  if (problem) return { deny: problem }
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
    auto: step.kind === 'auto',
    note,
  })
}

async function changeVersion($: $, asset: string, n: number, patch: Partial<EaselVersion>): Promise<boolean> {
  const meta = await loadMeta($, root, asset)
  if (!meta || !findVersion(meta, n)) return false
  await saveMeta($, root, patchVersion(meta, n, patch))
  await refreshAssets($)
  return true
}

/**
 * 人在面板上對某一版提修改：先在那一版記下 askedAt（人審過），再把要求送進對話，由 Claude 呼叫 revise。
 * 面板和對話走的是同一個 revise 工具，分辨「人在面板發起」靠的就是這筆紀錄：只有這裡寫得到，工具寫不到，
 * 所以不能用 revise 的參數來分（Claude 自己就能帶）。以它為底的 revise 不必先自檢，也不算自動修改。
 */
async function askFromPanel($: $, asset: string, n: number, text: string): Promise<void> {
  await changeVersion($, asset, n, { askedAt: await $.clock.now() })
  await $.prompt.submit({ text, asUser: true })
}

// ---- 收起來 ------------------------------------------------------------------
// 第三種處置：不核准也不退回，只是不列在「等你審」。只有面板的按鈕會呼叫，沒有工具能做，Claude 代按不了。

/**
 * 把這幾版收起來。只收「還是那個素材的最新一版、而且還是待審」的：按下確認前有新的一版、或已經被審過的，就不動它。
 * 回實際收了幾個。
 */
async function shelveMany($: $, targets: readonly { asset: string; n: number }[]): Promise<number> {
  let done = 0
  for (const { asset, n } of targets) {
    const meta = await loadMeta($, root, asset)
    const last = meta && latest(meta)
    if (!meta || !last || last.n !== n || last.review !== 'pending') continue
    await saveMeta($, root, patchVersion(meta, n, { review: 'shelved' }))
    done++
  }
  await refreshAssets($)
  return done
}

/** 按下「全部收起來」：先算出要收哪幾版（卡片以外、較早的待審），記下來等確認，不直接收。 */
async function askShelve($: $): Promise<void> {
  const busy = new Set((await read($, jobsAtom)).map(job => job.asset))
  const { earlier } = splitPending(pendingByRecency(await read($, assetsAtom), busy))
  const targets = earlier.flatMap(meta => {
    const last = latest(meta)
    return last ? [{ asset: meta.asset, n: last.n }] : []
  })
  await update($, homeAtom, home => ({ ...home, confirm: targets.length > 0 ? targets : null }))
}

/** 「全部收起來」確認之後：收那幾個、關掉確認、收合較早的清單。 */
async function confirmShelve($: $): Promise<void> {
  const { confirm } = await read($, homeAtom)
  if (!confirm) return
  const done = await shelveMany($, confirm)
  await update($, homeAtom, home => ({ ...home, confirm: null, earlierOpen: false, earlierPage: 0 }))
  $.ui.toast(`已收起 ${done} 個，可以在「素材」裡找到`)
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

// ---- 啟動 ------------------------------------------------------------------

async function locate($: $): Promise<void> {
  // 用引擎的專案根，不用 e.cwd：工作目錄會跟著 shell 的 cd 變，素材不能跟著跑
  root = await projectRoot($, await $.session.root())
  home = await homeDir($)
}

async function loadState($: $): Promise<void> {
  await refreshAssets($)
  await refreshSetup($)
  await refreshUsage($)
}

function pollUsage($: $): void {
  $.clock.every(USAGE_EVERY_MS, () => {
    refreshUsage($).catch(() => undefined)
  })
}

/**
 * 啟動時要做的事，一項一筆，照順序跑。每一項各自成敗：失敗只回報那一項，後面的照跑。
 * 起因：這些原本寫成一串 await。/easel 指令被引擎拒絕（當時技能也叫 easel，先佔了 /easel）時整個 session.start 被跳過，
 * 排在後面的四個工具跟著沒註冊，而且對話和面板上都看不到原因。
 * 要加新的工具或指令就在這裡加一筆，不要回 session.start 手寫順序或 try/catch。
 * 引擎不准把 $ 交給存在清單裡的函式，所以清單只放資料，實際呼叫由下面的 runStep 照 kind 對應；新的 kind 要在那裡補一行。
 * when：register 在第一輪對話前做完，工具才趕得上第一輪；background 不擋開場，在背景做。
 */
type StartupStep = { label: string; when: 'register' | 'background' } & (
  | { kind: 'tool'; spec: (typeof TOOLS)[number] }
  | { kind: 'command'; spec: { name: string; description: string } }
  | { kind: 'locate' | 'load-limit' | 'load-state' | 'poll-usage' }
)

const STARTUP: readonly StartupStep[] = [
  ...TOOLS.map((spec): StartupStep => ({ label: `工具 ${spec.name}`, when: 'register', kind: 'tool', spec })),
  { label: '找專案與家目錄', when: 'register', kind: 'locate' },
  { label: '/easel 指令', when: 'register', kind: 'command', spec: { name: 'easel', description: '打開 easel：看圖、審稿與 Codex 額度' } },
  { label: '讀取自動修改上限', when: 'background', kind: 'load-limit' },
  { label: '讀取素材與 Codex 狀態', when: 'background', kind: 'load-state' },
  { label: '定時更新額度', when: 'background', kind: 'poll-usage' },
]

async function runStep($: $, step: StartupStep): Promise<void> {
  if (step.kind === 'tool') await $.tool.register(step.spec)
  else if (step.kind === 'command') await $.command.register(step.spec)
  else if (step.kind === 'locate') await locate($)
  else if (step.kind === 'load-limit') await readLimit($)
  else if (step.kind === 'load-state') await loadState($)
  else pollUsage($)
}

/** 跑清單裡某一段的每一項。失敗的寫一行到對話，並記進狀態給對話框上方、面板與 status 工具顯示。 */
async function runStartup($: $, when: StartupStep['when']): Promise<void> {
  const failed: EaselStartupProblem[] = []
  for (const step of STARTUP) {
    if (step.when !== when) continue
    try {
      await runStep($, step)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failed.push({ label: step.label, message })
      $.ui.log(`easel 啟動時「${step.label}」沒成功：${message}`)
    }
  }
  try {
    // register 是每次啟動的第一段，順便清掉上次啟動留下的紀錄
    await update($, startupAtom, list => (when === 'register' ? failed : [...list, ...failed]))
  } catch (error) {
    $.ui.log(`easel 記不下啟動結果：${error instanceof Error ? error.message : String(error)}`)
  }
}

export const register: Register = on => {
  // ---- 引擎事件 --------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await runStartup($, 'register')
    const started = await next(e)
    void runStartup($, 'background')
    return started
  })

  on('command.run', { command: 'easel' }, async $ => {
    await refreshAssets($)
    await readLimit($)
    await refreshSetup($)
    refreshUsage($).catch(() => undefined)
    await update($, viewAtom, (): EaselView => ({ kind: 'home' }))
    // 上次沒按完的「全部收起來」確認不留著：要收的那批是按下去那一刻算的，隔了一段時間就過期了
    await update($, homeAtom, home => ({ ...home, confirm: null }))
    await $.ui.open(PANE_ARGS)
    return { text: 'easel 面板已開啟。' }
  })

  // 四個工具一律在 tool.run 服務（權限檢查通過、真的要執行的那一刻），不在 tool.call（權限檢查之前）。
  // 2.1.326 起內建的 sec-default 會擋「權限檢查之前」由外掛啟動的外部程式：在 tool.call 裡 spawn codex 會得到
  // 「$.process.spawn: this repeats a Bash call that is not allowed; serve an allowed call at tool.run」，事先允許工具也一樣。
  // 這裡的 { deny } 是這次呼叫的錯誤（和工具自己出錯一樣），模型讀得到原因。
  on('tool.run', { tool: 'mcp__easel__new' }, ($, e) => startNew($, e as unknown as NewInput)).catch(() => ({ deny: 'easel 內部出錯，這次沒有畫。' }))
  on('tool.run', { tool: 'mcp__easel__revise' }, ($, e) => startRevise($, e as unknown as ReviseInput)).catch(() => ({ deny: 'easel 內部出錯，這次沒有畫。' }))

  on('tool.run', { tool: 'mcp__easel__self_check' }, async ($, e) => {
    const { asset, version, pass, note = '' } = e as unknown as CheckInput
    if (!asset || version === undefined) return { deny: '缺素材名或版本。' }
    const done = await changeVersion($, asset, version, { selfCheck: pass ? 'pass' : 'fail', selfNote: note })
    if (!done) return { deny: `找不到 ${asset} v${version}。` }
    // 不合格時先講清楚還能不能自動修改，Claude 不用撞到拒絕才知道到上限了
    const meta = pass ? null : await loadMeta($, root, asset)
    const checked = meta && findVersion(meta, version)
    const step = meta && checked ? reviseStep(meta, checked) : null
    if (!meta || step?.kind !== 'auto') return { result: `已記錄 ${asset} v${version} 的自檢。` }
    const cap = await readLimit($)
    return {
      result:
        step.k > cap.limit
          ? `已記錄 ${asset} v${version} 的自檢。${limitReachedText(asset, step.k - 1, cap)}`
          : `已記錄 ${asset} v${version} 的自檢。要自動修改的話，以 v${version} 為底 revise 會是連續第 ${step.k} 次，上限 ${cap.limit} 次（${LIMIT_SOURCE_TEXT[cap.source]}）。`,
    }
  }).catch(() => ({ deny: 'easel 內部出錯，沒有記錄。' }))

  on('tool.run', { tool: 'mcp__easel__status' }, async $ => {
    await ready($)
    if (!(await read($, usageAtom))) await refreshUsage($)
    const assets = await refreshAssets($)
    const usage = await currentUsage($)
    const cap = await readLimit($)
    const jobs = await read($, jobsAtom)
    const busy = new Set(jobs.map(job => job.asset))
    const counts = reviewCounts(assets, busy)
    // 只列待審（新到舊，最多 STATUS_PENDING_LINES 個）與正在畫的；收起、核准、退回只給總數，素材一多也不會洗版
    const pending = pendingByRecency(assets, busy)
    const selfText = { pass: '合格', fail: '不合格', pending: '還沒做' } as const
    const pendingLines = pending.slice(0, STATUS_PENDING_LINES).map(meta => {
      const last = latest(meta) as EaselVersion
      const streak = autoStreak(meta)
      return `- ${meta.asset}：最新 v${last.n}（共 ${meta.versions.length} 版），自檢${selfText[last.selfCheck]}${streak > 0 ? `，已連續自動修改 ${streak} 次` : ''}`
    })
    const more = pending.length - pendingLines.length
    const broken = (await read($, startupAtom)).map(problem => `啟動時「${problem.label}」沒成功：${problem.message}`)
    return {
      result: [
        usage ? `Codex 額度已用 ${usage.percent}%，${usage.reset} 重置。` : 'Codex 額度未知。',
        `自動修改上限：${limitText(cap.limit)}（${LIMIT_SOURCE_TEXT[cap.source]}，可在 /easel 面板調）。`,
        `素材 ${assets.length} 個：待審 ${counts.pending}、收起 ${counts.shelved}、已核准 ${counts.approved}、退回 ${counts.rejected}、正在畫 ${jobs.length}。`,
        ...(pendingLines.length > 0 ? ['待審（新到舊）：', ...pendingLines] : []),
        ...(more > 0 ? [`…另有 ${more} 個較早的待審。要清版面的話，請使用者在 /easel 面板按「全部收起來」（收起不算核准也不算退回）。`] : []),
        ...(jobs.length > 0 ? ['正在畫：', ...jobs.map(job => `- ${job.asset} v${job.version}`)] : []),
        ...broken,
      ].join('\n'),
    }
  }).catch(() => ({ deny: 'easel 內部出錯，查不到狀態。' }))

  // Claude 自己叫 codex 生圖的話，easel 收不到圖也沒有檢查。其他 codex 用法不受影響。
  // 這個是閘門，要在權限檢查之前擋，所以留在 tool.call；它不啟動任何程式。
  on('tool.call', { tool: 'Bash' }, ($, e, next) => (isDirectImageCall(e.command) ? { deny: '生圖請用 easel 的 new 或 revise 工具，不要直接呼叫 codex。' } : next(e))).catch(($, e, next) => next(e))

  // 對話框上方：有事才出現，一次只講最要緊的一件。照 mod 共用的約定疊在下層上面，不獨佔。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const jobs = await read($, jobsAtom)
    const assets = await read($, assetsAtom)
    const usage = await currentUsage($)
    const job = jobs[0]
    const waiting = assets.filter(meta => latest(meta)?.review === 'pending' && !jobs.some(j => j.asset === meta.asset))
    const first = waiting[0]
    const broken = await read($, startupAtom)
    const line = job
      ? `正在畫 ${job.asset} v${job.version}`
      : broken[0]
        ? `easel 啟動不完整：${broken[0].label}${broken.length > 1 ? ` 等 ${broken.length} 項` : ''}沒成功`
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
          <Text color={job ? 'suggestion' : broken.length > 0 || (usage?.tone === 'warn' && waiting.length === 0) ? 'warning' : undefined}>{job ? '●' : '▲'}</Text>
          <Text>{line}</Text>
          <Button
            key="band-open"
            label="打開"
            onPress={async () => {
              if (!job && broken.length > 0) await update($, viewAtom, (): EaselView => ({ kind: 'home' }))
              else if (!job && first) {
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
    // 核准、退回、收起來都只在這裡（面板的按鈕）寫，沒有工具能寫，Claude 代按不了
    const review = (asset: string, n: number, state: 'approved' | 'rejected' | 'shelved') => () => changeVersion($, asset, n, { review: state })

    /** 縮圖做不出來時寫在圖位上的話，跟著這台電腦做縮圖的方式走 */
    const noThumb = thumbnailer((await read($, setupAtom)).platform ?? 'linux').failed

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

    /** 啟動時沒成功的事。/easel 指令沒註冊成功時，這裡和對話框上方的那一列是僅有的入口。 */
    const startupCards = async (): Promise<RenderElement[]> => {
      const broken = await read($, startupAtom)
      if (broken.length === 0) return []
      return [
        frame(
          'startup',
          'warning',
          art('startup-art', alertCard({ tone: 'warn', title: 'easel 啟動不完整', detail: broken.map(problem => `${problem.label}：${problem.message}`).join('；') })),
          <Text dimColor>排除後輸入 /reload-plugins，或開一個新對話。</Text>,
        ),
      ]
    }

    const setupCards = async (): Promise<RenderElement[]> => {
      const setup = await read($, setupAtom)
      if (setup.state === 'ready' || setup.state === 'unknown') return []
      if (setup.state === 'missing') {
        const { text, command } = codexInstall(setup.platform ?? 'linux')
        return [
          section(
            'setup',
            '開始使用',
            frame(
              'setup-missing',
              'warning',
              <Text>{`這台電腦找不到官方 Codex。${text}`}</Text>,
              command ? <Text>{command}</Text> : null,
              row(
                'setup-btns',
                command ? <Button key="copy-install" label="複製指令" onPress={() => $.ui.copy({ text: command })} /> : null,
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

    /**
     * 自動修改上限：桌面與手機畫卡片，終端機一行字。調整一律用 Button（手機沒有 Input）；
     * 到 0 就沒有「減少」、到上限就沒有「增加」，沒調過就沒有「恢復預設」。數字讀面板的鏡像，按鈕寫回 $.store。
     */
    const limitSection = async (): Promise<RenderElement> => {
      const cap = resolveLimit(await read($, limitAtom))
      const adjusted = cap.source === 'panel'
      const title = limitText(cap.limit)
      const source = adjusted ? '你調的' : '預設'
      const sub = cap.limit === 0 ? '自檢不合格時直接交給你，不自己重畫' : '自檢不合格時 Claude 自己重畫，到上限就交給你'
      return section(
        'limit',
        '自動修改上限',
        frame(
          'limit-box',
          undefined,
          Svg ? (
            art('limit-art', limitCard({ value: cap.limit, max: REVISE_LIMIT.max, title, sub, badge: { tone: adjusted ? 'a' : 'none', text: source } }))
          ) : (
            <Text>{`${title}（${source}）・${sub}`}</Text>
          ),
          row(
            'limit-btns',
            cap.limit > REVISE_LIMIT.min ? <Button key="limit-down" label="減少" onPress={() => stepLimit($, -1)} /> : null,
            cap.limit < REVISE_LIMIT.max ? <Button key="limit-up" label="增加" onPress={() => stepLimit($, 1)} /> : null,
            adjusted ? <Button key="limit-reset" label="恢復預設" onPress={() => storeLimit($, null)} /> : null,
          ),
        ),
      )
    }

    /** 分頁列：一頁放得下就不畫。上一頁、下一頁只在有得翻時出現。 */
    const pager = (key: string, at: { page: number; pages: number }, turn: (page: number) => () => Promise<unknown>): RenderElement | null =>
      at.pages > 1
        ? row(
            key,
            at.page > 0 ? <Button key={`${key}-prev`} label="‹ 上一頁" onPress={turn(at.page - 1)} /> : null,
            <Text dimColor>{`第 ${at.page + 1}／${at.pages} 頁`}</Text>,
            at.page < at.pages - 1 ? <Button key={`${key}-next`} label="下一頁 ›" onPress={turn(at.page + 1)} /> : null,
          )
        : null

    const homePage = async (): Promise<RenderElement> => {
      const assets = (await read($, assetsAtom)).slice().sort((a, b) => (latest(b)?.createdAt ?? 0) - (latest(a)?.createdAt ?? 0))
      const jobs = await read($, jobsAtom)
      const usage = await currentUsage($)
      const busy = new Set(jobs.map(job => job.asset))
      const pending = pendingByRecency(assets, busy)
      const others = assets.filter(meta => !pending.includes(meta))
      const now = await $.clock.now()
      const home = await read($, homeAtom)
      // 份量有上限：卡片只畫最新幾張，較早的與素材清單都只畫一頁；沒畫的不做縮圖
      const { cards, earlier } = splitPending(pending)
      const earlierPage = pageOf(earlier, home.earlierPage)
      const assetsPage = pageOf(others, home.assetsPage)
      const setHome = (patch: Partial<EaselHome>) => () => update($, homeAtom, current => ({ ...current, ...patch }))

      const card = async (meta: EaselMeta): Promise<RenderElement> => {
        const last = latest(meta) as EaselVersion
        // 終端機沒有 Svg，縮圖做了也畫不出來
        const data = Svg ? await thumbnail($, path(meta.asset), `v${last.n}`, 160) : null
        const note = last.selfCheck === 'pending' ? undefined : `${last.selfCheck === 'pass' ? '✓' : '✗'} 自檢：${last.selfNote}`
        return frame(
          `pending-${meta.asset}`,
          'warning',
          art(`pending-art-${meta.asset}`, assetCard({ name: meta.asset, sub: `v${last.n}・${ago(last.createdAt, now)}${last.base ? `・以 v${last.base} 為底` : ''}`, ...(note ? { note, noteTone: last.selfCheck === 'pass' ? 'ok' : 'crit' } : {}), badge: { tone: 'warn', text: '待審' }, thumb: data, alpha: last.alpha })),
          row(
            `pending-btn-${meta.asset}`,
            <Button key={`open-${meta.asset}`} label="打開審稿" variant="primary" onPress={go({ kind: 'detail', asset: meta.asset, version: last.n })} />,
            <Button key={`quick-${meta.asset}`} label="直接核准" onPress={review(meta.asset, last.n, 'approved')} />,
            <Button key={`shelve-${meta.asset}`} label="收起來" onPress={review(meta.asset, last.n, 'shelved')} />,
          ),
        )
      }

      const listRow = async (meta: EaselMeta): Promise<RenderElement | null> => {
        const last = latest(meta)
        if (!last) return null
        const data = Svg ? await thumbnail($, path(meta.asset), `v${last.n}`, 96) : null
        const badge = { tone: last.review === 'approved' ? 'ok' : last.review === 'pending' ? 'warn' : 'none', text: REVIEW_TEXT[last.review] }
        return row(
          `row-${meta.asset}`,
          art(`row-art-${meta.asset}`, assetRow({ name: meta.asset, sub: `v${last.n}・${ago(last.createdAt, now)}${meta.transparent ? '・透明' : ''}`, badge, thumb: data, alpha: last.alpha })),
          <Button key={`row-open-${meta.asset}`} label="打開" onPress={go({ kind: 'detail', asset: meta.asset, version: last.n })} />,
        )
      }

      /** 「另有 N 個較早的待審」：預設收著（不做任何縮圖）；展開後分頁畫成清單列，不畫大卡。 */
      const earlierCards = async (): Promise<RenderElement[]> => {
        if (earlier.length === 0) return []
        const title = `另有 ${earlier.length} 個較早的待審`
        const sub = `這裡只畫最新 ${PENDING_CARDS} 張；收起來的會移到下方「素材」`
        const list = home.earlierOpen ? ((await Promise.all(earlierPage.items.map(listRow))).filter(Boolean) as RenderElement[]) : []
        return [
          frame(
            'earlier',
            undefined,
            Svg ? art('earlier-art', moreCard({ title, sub })) : <Text>{`${title}（${sub}）`}</Text>,
            row(
              'earlier-btns',
              <Button key="earlier-toggle" label={home.earlierOpen ? '收合' : '展開'} onPress={setHome({ earlierOpen: !home.earlierOpen, earlierPage: 0 })} />,
              home.confirm ? null : <Button key="shelve-earlier" label="全部收起來" onPress={() => askShelve($)} />,
            ),
            ...list,
            home.earlierOpen ? pager('earlier-pager', earlierPage, page => setHome({ earlierPage: page })) : null,
          ),
          ...(home.confirm
            ? [
                frame(
                  'shelve-confirm',
                  'warning',
                  art(
                    'shelve-confirm-art',
                    alertCard({
                      tone: 'warn',
                      title: `要把 ${home.confirm.length} 個較早的待審收起來嗎？`,
                      detail: '不算核准也不算退回，只是不列在「等你審」。它們會移到下方「素材」，打開後照樣能核准或退回；之後有新的一版，新版會回到「等你審」。',
                    }),
                  ),
                  row(
                    'shelve-confirm-btns',
                    <Button key="shelve-earlier-confirm" label={`收起 ${home.confirm.length} 個`} variant="primary" onPress={() => confirmShelve($)} />,
                    <Button key="shelve-earlier-cancel" label="取消" onPress={setHome({ confirm: null })} />,
                  ),
                ),
              ]
            : []),
        ]
      }

      const empty = assets.length === 0 && jobs.length === 0
      return (
        <Box flexDirection="column" gap={2}>
          {art('hero', hero(usage))}
          {!Svg && usage ? <Text>{`額度已用 ${usage.percent}%，${usage.reset} 重置・今天 ${usage.today} 張`}</Text> : null}
          {usage?.tone === 'crit' ? frame('out', 'error', art('out-art', alertCard({ tone: 'crit', title: `額度用完了，${usage.reset} 才能再畫`, detail: `${usage.freeResets > 0 ? `你的帳號還有 ${usage.freeResets} 次免費重置。` : ''}現有素材照常能看與核准。` }))) : null}
          {/* 固定排在額度後面：下面的清單再長都擠不到它 */}
          {await limitSection()}
          {await startupCards()}
          {await setupCards()}
          {await noticeCards()}
          {pending.length > 0 ? section('pending', `等你審（${pending.length}）`, ...(await Promise.all(cards.map(card))), ...(await earlierCards())) : null}
          {jobs.length > 0 ? section('jobs', `正在畫（${jobs.length}）`, ...(await Promise.all(jobs.map(jobFrame)))) : null}
          {others.length > 0
            ? section(
                'assets',
                `素材（${others.length}）`,
                frame('assets-box', undefined, ...((await Promise.all(assetsPage.items.map(listRow))).filter(Boolean) as RenderElement[]), pager('assets-pager', assetsPage, page => setHome({ assetsPage: page }))),
              )
            : null}
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
      const big = Svg ? await thumbnail($, dir, `v${n}`, 840) : null
      const strip = await Promise.all(sorted.map(async v => ({ n: v.n, data: Svg ? await thumbnail($, dir, `v${v.n}`, 128) : null, selected: v.n === n, approved: v.review === 'approved', alpha: v.alpha })))
      const badge = REVIEW_TEXT[current.review]
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
            art('big', bigPicture({ data: big, width: current.width, height: current.height, alpha: current.alpha, alt: `${asset} 第 ${n} 版。${current.prompt}`, missing: noThumb }))
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
          {current.review === 'pending' || current.review === 'shelved'
            ? section(
                'review',
                '審稿',
                frame(
                  'review-box',
                  current.review === 'pending' ? 'warning' : undefined,
                  // 收起來的照樣能核准或退回；「收起來」本身只對待審的有
                  current.review === 'shelved' ? <Text dimColor>這一版已收起來，不列在「等你審」。核准、退回或修改都照常可以。</Text> : null,
                  row(
                    'review-btns',
                    <Button key="approve" label={`核准 v${n}`} variant="primary" onPress={review(asset, n, 'approved')} />,
                    <Button key="reject" label="退回" onPress={review(asset, n, 'rejected')} />,
                    current.review === 'pending' ? <Button key="shelve" label="收起來" onPress={review(asset, n, 'shelved')} /> : null,
                  ),
                  Input ? (
                    <Input
                      key="ask"
                      label="想改什麼？"
                      placeholder="例如：圍巾再長一點"
                      submitLabel="送出"
                      onSubmit={async value => {
                        if (value.trim()) await askFromPanel($, asset, n, `請用 easel 改 ${asset}（以 v${n} 為底）：${value.trim()}`)
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
      const [a, b] = Svg ? await Promise.all([thumbnail($, dir, `v${left.n}`, 420), thumbnail($, dir, `v${right.n}`, 420)]) : [null, null]
      return (
        <Box flexDirection="column" gap={2}>
          {row('head', <Button key="back" label="‹ 審稿" onPress={go({ kind: 'detail', asset, version: n })} />, <Text bold>{`v${left.n} 與 v${right.n}`}</Text>)}
          {art('pair', compare({ left: { label: `v${left.n}`, badge: '上一版', data: a }, right: { label: `v${right.n}`, badge: '這一版', data: b }, ratio: right.height / Math.max(1, right.width), alpha: right.alpha, missing: noThumb }))}
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
                <Button key="keep-left" label={`改用 v${left.n} 當底再畫`} onPress={() => askFromPanel($, asset, left.n, `請用 easel 以 ${asset} 的 v${left.n} 為底再畫一版，先問我要改什麼。`)} />,
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
