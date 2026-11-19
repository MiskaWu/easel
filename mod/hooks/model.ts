// easel 的純函式：素材紀錄、提示詞、Codex 指令、事件解析、用量換算。不碰 $，可以單獨測。
// 這裡的每條規則都來自 2026-11-06 的實測（數據在規格文件的「Phase 0 實測結果」），改之前先看那裡。

import type { EaselMeta, EaselPlatform, EaselUsage, EaselVersion } from '../types'

/** 素材放在專案的這個資料夾底下，一個素材一個子資料夾。 */
export const ROOT = 'art'
/** 單次生圖的等待上限。實測最慢 118 秒，而且那次還含模型自己重試。 */
export const TIMEOUT_S = 180
/** 額度到這裡開始提醒。 */
export const WARN_PERCENT = 75

const NAME = /^[a-z0-9][a-z0-9-]{0,47}$/

/** 素材名會變成資料夾名，所以只收小寫英數與連字號。 */
export function isValidName(name: string): boolean {
  return NAME.test(name)
}

export function emptyMeta(asset: string, transparent: boolean, codexVersion: string): EaselMeta {
  return { asset, transparent, codexVersion, versions: [] }
}

export function nextVersion(meta: EaselMeta): number {
  return meta.versions.reduce((max, v) => Math.max(max, v.n), 0) + 1
}

export function latest(meta: EaselMeta): EaselVersion | undefined {
  return meta.versions.reduce<EaselVersion | undefined>((best, v) => (best && best.n > v.n ? best : v), undefined)
}

export function findVersion(meta: EaselMeta, n: number): EaselVersion | undefined {
  return meta.versions.find(v => v.n === n)
}

/** 換掉某一版的部分欄位，其他版本原封不動。 */
export function patchVersion(meta: EaselMeta, n: number, patch: Partial<EaselVersion>): EaselMeta {
  return { ...meta, versions: meta.versions.map(v => (v.n === n ? { ...v, ...patch } : v)) }
}

// ---- 審稿狀態與首頁的份量 --------------------------------------------------------
//
// 素材的狀態看最新一版的 review：待審、已核准、退回，以及中性的「收起」（不核准也不退回，只是不列在「等你審」）。
// 收起來的素材有新的一版時，新版照常是待審，所以收起只對那一版有效，不用另外記。
//
// 首頁的份量要有上限：原本每個待審素材都畫一張帶 160 縮圖的卡，44 個待審時整頁約 45 萬字元、46 張 Svg，
// 重新載入後第一次打開要跑 88 次外部程式做縮圖（實測，見 CLAUDE.md）。現在卡片、清單都只畫一頁，沒畫的不做縮圖。

export type Review = EaselVersion['review']

export const REVIEW_TEXT: Record<Review, string> = { pending: '待審', approved: '已核准', rejected: '退回', shelved: '收起' }

/** 「等你審」最多畫幾張帶大縮圖的卡（最新的幾張），其餘收成一列「另有 N 個較早的」。 */
export const PENDING_CARDS = 5
/** 清單一頁幾列：展開的較早待審、素材清單都照這個分頁。 */
export const LIST_PAGE = 8
/** status 最多列幾個待審，其餘給總數。 */
export const STATUS_PENDING_LINES = 10

/** 素材現在的狀態：最新一版的 review。沒有版本的素材回 null。 */
export function reviewOf(meta: EaselMeta): Review | null {
  return latest(meta)?.review ?? null
}

/** 等你審的素材，新到舊（看最新一版的時間）。正在畫的不算：它們列在「正在畫」。面板、status、「全部收起來」都用這一份。 */
export function pendingByRecency(metas: readonly EaselMeta[], busy: ReadonlySet<string>): EaselMeta[] {
  return metas.filter(meta => reviewOf(meta) === 'pending' && !busy.has(meta.asset)).sort((a, b) => (latest(b)?.createdAt ?? 0) - (latest(a)?.createdAt ?? 0))
}

/** 最新的幾張畫成卡，其餘是較早的。list 要先照新到舊排好。 */
export function splitPending<T>(list: readonly T[], cards = PENDING_CARDS): { cards: T[]; earlier: T[] } {
  return { cards: list.slice(0, cards), earlier: list.slice(cards) }
}

/** 取第 page 頁（從 0 起）。頁數超出就夾到最後一頁：收起或核准讓清單變短時，不會停在空白頁。 */
export function pageOf<T>(list: readonly T[], page: number, size = LIST_PAGE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(list.length / size))
  const at = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1)
  return { items: list.slice(at * size, (at + 1) * size), page: at, pages }
}

/** 照最新一版的狀態數素材；正在畫的另外數（busy），不算進待審。 */
export function reviewCounts(metas: readonly EaselMeta[], busy: ReadonlySet<string>): Record<Review, number> {
  const counts: Record<Review, number> = { pending: 0, approved: 0, rejected: 0, shelved: 0 }
  for (const meta of metas) {
    const review = reviewOf(meta)
    if (review && !(review === 'pending' && busy.has(meta.asset))) counts[review]++
  }
  return counts
}

// ---- 自動修改的上限 ----------------------------------------------------------
//
// 自檢不合格時 Claude 會自己 revise 重畫。這裡決定「最多連續幾次」，程式真的會數，到了就拒絕、不啟動 codex。
// 上限有三層，後者蓋過前者：程式的預設值 → 人在 /easel 面板上調的值（$.store，跨對話保存）→ 使用者在對話裡當次說的（revise 的 limit）。
// 持久的只有面板那一層：再多一個持久的地方（例如外掛設定）兩邊會打架，看不出現在是誰說了算。

/** 預設值、可調的範圍。改預設值會改到每個沒調過的人，維持 2。 */
export const REVISE_LIMIT = { default: 2, min: 0, max: 10 } as const

/** 上限從哪一層來：預設值、面板上調的、這次 revise 帶的 limit。 */
export type LimitSource = 'default' | 'panel' | 'call'

export const LIMIT_SOURCE_TEXT: Record<LimitSource, string> = { default: '預設', panel: '你在面板調的', call: '這次指定' }

export type ReviseLimit = { limit: number; source: LimitSource }

/** 收進範圍：不是數字（含 NaN、字串、沒給）回 null；小數四捨五入；超出就夾住。 */
export function clampLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(REVISE_LIMIT.max, Math.max(REVISE_LIMIT.min, Math.round(value)))
}

/** 這次的上限：當次指定 → 面板上存的 → 預設值，取第一個有效的。stored 是 $.store 裡的原值，壞掉就當沒調過。 */
export function resolveLimit(stored: unknown, requested?: unknown): ReviseLimit {
  const call = clampLimit(requested)
  if (call !== null) return { limit: call, source: 'call' }
  const panel = clampLimit(stored)
  if (panel !== null) return { limit: panel, source: 'panel' }
  return { limit: REVISE_LIMIT.default, source: 'default' }
}

/** 面板按了增加或減少之後要存的值。調回預設值就不存（回 null），來源跟著回到「預設」，只有一種 2。 */
export function storedLimitAfter(current: number, delta: number): number | null {
  const next = clampLimit(current + delta) ?? REVISE_LIMIT.default
  return next === REVISE_LIMIT.default ? null : next
}

/** 給人看的上限：0 是「不自動修改」。 */
export function limitText(limit: number): string {
  return limit === 0 ? '不自動修改' : `最多 ${limit} 次`
}

/**
 * 人審過這一版：在面板核准、退回過，或在面板上對它提了修改要求（askedAt）。
 * 這三件都只有面板的按鈕與輸入框寫得到，工具寫不到，所以 Claude 沒辦法替人「審過」。
 * 「收起來」（shelved）不算：那是為了清版面，不是對圖的判斷，「全部收起來」一次就收幾十個。
 */
export function humanReviewed(v: EaselVersion): boolean {
  return v.review === 'approved' || v.review === 'rejected' || typeof v.askedAt === 'number'
}

/** 人已經接手的版本：自檢合格，或人審過。連續自動修改數到這裡就停。 */
function handedOver(v: EaselVersion): boolean {
  return v.selfCheck === 'pass' || humanReviewed(v)
}

/** 接在這一版後面的 revise 算自動修改：自檢不合格，而且人還沒審過。 */
export function isAutoBase(v: EaselVersion): boolean {
  return v.selfCheck === 'fail' && !humanReviewed(v)
}

/** 這一版是不是自動修改畫出來的。0.1.4 起寫在 auto；更舊的 meta.json 沒有這個欄位，就看它的底圖現在是不是「不合格、沒人審」。 */
export function wasAuto(meta: EaselMeta, v: EaselVersion): boolean {
  if (typeof v.auto === 'boolean') return v.auto
  if (v.base === null) return false
  const base = findVersion(meta, v.base)
  return base ? isAutoBase(base) : false
}

/**
 * 這個素材目前已經連續自動修改了幾次：照版本號從最新往回數，數到人接手的版本、不是自動修改的版本（第一版、使用者要求的修改）為止。
 * 照版本號數、不照底圖的鏈數：指定 base 回到更早的不合格版本，不會讓次數歸零。
 */
export function autoStreak(meta: EaselMeta): number {
  let count = 0
  for (const v of meta.versions.slice().sort((a, b) => b.n - a.n)) {
    if (handedOver(v) || !wasAuto(meta, v)) break
    count++
  }
  return count
}

/**
 * 以 from 為底 revise 是哪一種，只看底圖那一版：
 * - 自檢合格或人審過 → manual：使用者要求的修改，不受上限限制；
 * - 自檢不合格且人沒審 → auto：自動修改，k 是連續第幾次；
 * - 還沒自檢、人也沒審 → unchecked：不能改，要先自檢。沒有這一條的話，跳過 self_check 就能繞過上限。
 */
export type ReviseStep = { kind: 'manual' } | { kind: 'auto'; k: number } | { kind: 'unchecked' }

export function reviseStep(meta: EaselMeta, from: EaselVersion): ReviseStep {
  if (from.selfCheck === 'pass' || humanReviewed(from)) return { kind: 'manual' }
  if (from.selfCheck === 'fail') return { kind: 'auto', k: autoStreak(meta) + 1 }
  return { kind: 'unchecked' }
}

/** 底圖還沒自檢、這次不畫時回給 Claude 的話。 */
export function uncheckedText(asset: string, n: number): string {
  return (
    `${asset} v${n} 還沒自檢，這次不畫。請先用 Read 看 v${n} 的圖，對照要求用 self_check 記錄這一版，再決定要不要修改：` +
    '合格之後的修改是使用者要求的；不合格之後的修改算自動修改，受上限限制。'
  )
}

/** 到上限、這次不畫時回給 Claude 的話：連續幾次、上限幾次、哪一層定的、怎麼繼續。 */
export function limitReachedText(asset: string, done: number, cap: ReviseLimit): string {
  const head =
    cap.limit === 0
      ? `${asset} 的自動修改上限是 0（${LIMIT_SOURCE_TEXT[cap.source]}，不自動修改），這次不畫。`
      : `${asset} 已經連續自動修改 ${done} 次，上限是 ${cap.limit} 次（${LIMIT_SOURCE_TEXT[cap.source]}），這次不畫。`
  return (
    head +
    '請停下來，把各版的自檢結果交給使用者判斷。' +
    '使用者要你繼續改的話，請他說這次可以改到幾次，再把那個數字帶在 revise 的 limit；要長期調整，請他在 /easel 面板調「自動修改上限」。'
  )
}

/** 自動修改畫好後補在結果後面的一句。 */
export function autoStepText(k: number, cap: ReviseLimit): string {
  return `這是連續第 ${k} 次自動修改，上限 ${cap.limit} 次（${LIMIT_SOURCE_TEXT[cap.source]}）。`
}

/** 寫壞或舊版的 meta.json 不要把面板弄掛：讀不懂就當沒有這個素材。 */
export function parseMeta(text: string): EaselMeta | null {
  try {
    const value = JSON.parse(text) as Partial<EaselMeta>
    if (typeof value.asset !== 'string' || !Array.isArray(value.versions)) return null
    return value as EaselMeta
  } catch {
    return null
  }
}

// ---- 提示詞 ------------------------------------------------------------------

// 圖由 easel 從生圖資料夾收走，模型不用自己存檔：實測模型複製時曾先拿到不透明的那張。
// 寫明不准改走程式或 CLI：內建技能的備援要 API key，而程式畫的圖不算生圖。
const RULES = '規則：只呼叫內建 image_gen，完成後直接結束。不要複製、移動或檢查檔案，生成的圖會由外部工具收走。不要用程式畫圖，也不要改走需要 API key 的 CLI。'
// 實測模型沒設這個參數時生出不透明的圖，白花兩張額度，所以要明講參數名。
const TRANSPARENT = '這張要真正透明的背景：呼叫 image_gen 時把 transparent_background 設成 true。'

export function newPrompt(prompt: string, transparent: boolean): string {
  return [`$imagegen ${prompt}`, RULES, ...(transparent ? [TRANSPARENT] : [])].join('\n')
}

/**
 * 模型拿「對話裡最後一張看得到的圖」當底，不一定是最新版（實測背景從黃昏退回白天），
 * 所以修改一律附上底圖（-i），並在提示詞寫明它就是底圖。
 */
export function revisePrompt(prompt: string, base: number, transparent: boolean): string {
  return [
    `$imagegen 附圖是目前的版本 v${base}，請以它為底圖修改。`,
    `修改要求：${prompt}`,
    '沒有提到的地方都保持不變。',
    RULES,
    ...(transparent ? [TRANSPARENT] : []),
  ].join('\n')
}

// ---- Codex 指令 --------------------------------------------------------------

// $.process 的 env 只能蓋不能移除，所以用 env -u：環境裡有 API key 時不會悄悄改走 API 計費。
const CLEAN_ENV = ['env', '-u', 'OPENAI_API_KEY', '-u', 'CODEX_API_KEY']
const EXEC = ['codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write']

export function codexArgv(rest: readonly string[]): string[] {
  return [...CLEAN_ENV, 'codex', ...rest]
}

/** 開新對話。exec 的 -i 會吃掉後面所有引數（實測），所以提示詞走 stdin，不放在指令列。 */
export function newArgv(workDir: string, refs: readonly string[]): string[] {
  return ['timeout', '-k', '5', String(TIMEOUT_S), ...CLEAN_ENV, ...EXEC, '-C', workDir, ...refs.flatMap(r => ['-i', r])]
}

/** 接回對話。--sandbox 與 -C 只能放在 resume 前面（放後面會報錯，實測）；一律指定編號，不用 --last。 */
export function reviseArgv(workDir: string, threadId: string, base: string): string[] {
  return ['timeout', '-k', '5', String(TIMEOUT_S), ...CLEAN_ENV, ...EXEC, '-C', workDir, 'resume', threadId, '-', '-i', base]
}

/**
 * 用量走官方 app-server。標準輸入一關它就結束、等不到回覆（實測），而 $.process 的 input 寫完就關，
 * 所以用 sh 把標準輸入撐幾秒。
 */
export function usageArgv(): string[] {
  const lines = [
    '{"method":"initialize","id":1,"params":{"clientInfo":{"name":"easel","title":"easel","version":"0.1.0"}}}',
    '{"method":"initialized"}',
    '{"method":"account/rateLimits/read","id":2}',
  ]
  const script = `{ printf '%s\\n' ${lines.map(l => `'${l}'`).join(' ')}; timeout 4 tail -f /dev/null; } | timeout 8 env -u OPENAI_API_KEY -u CODEX_API_KEY codex app-server 2>/dev/null`
  return ['sh', '-c', script]
}

// ---- 事件解析 ----------------------------------------------------------------

/** 把一塊塊送來的輸出切成完整的行。 */
export function splitLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const parts = (buffer + chunk).split('\n')
  return { lines: parts.slice(0, -1), rest: parts.at(-1) ?? '' }
}

export type CodexEvent = { kind: 'thread'; threadId: string } | { kind: 'failed'; message: string } | { kind: 'other' }

/** exec --json 的一行。事件裡沒有生圖項目（實測），所以這裡只取對話編號與錯誤。 */
export function parseEvent(line: string): CodexEvent {
  let value: { type?: string; thread_id?: string; message?: string; error?: { message?: string } }
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: 'other' }
  }
  if (value.type === 'thread.started' && value.thread_id) return { kind: 'thread', threadId: value.thread_id }
  if (value.type === 'turn.failed') return { kind: 'failed', message: value.error?.message ?? 'Codex 回報這一輪失敗。' }
  if (value.type === 'error') return { kind: 'failed', message: value.message ?? 'Codex 回報錯誤。' }
  return { kind: 'other' }
}

/** 把 exit code 換成給人看的原因。 */
export function failureText(code: number | null, message: string | null): string {
  if (code === 124 || code === 137) return `Codex 在 ${TIMEOUT_S} 秒內沒有畫完。`
  if (message) return message
  return `Codex 異常結束（代碼 ${code ?? '無'}）。`
}

/** 一張圖檔：絕對路徑與修改時間（毫秒）。列檔的結果一律用這個形狀，不經過任何指令的文字輸出。 */
export type ImageFile = { path: string; mtimeMs: number }

/** generated_images/<對話編號>/ 底下比生圖前多出來的最新一張。算不算新只看路徑，時間只用來在多張新圖裡挑最新的。 */
export function newestNewImage(files: readonly ImageFile[], before: ReadonlySet<string>): string | null {
  const fresh = files.filter(file => file.path.endsWith('.png') && !before.has(file.path))
  return fresh.reduce<ImageFile | null>((best, file) => (best && best.mtimeMs >= file.mtimeMs ? best : file), null)?.path ?? null
}

export type PngInfo = { width: number; height: number; alpha: boolean }

/** 從 PNG 檔頭讀尺寸與有沒有透明通道；不是 PNG 回 null。 */
export function parsePng(base64Head: string): PngInfo | null {
  const bytes = decodeBase64(base64Head)
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 26 || magic.some((b, i) => bytes[i] !== b)) return null
  const byte = (at: number) => bytes[at] ?? 0
  const u32 = (at: number) => byte(at) * 2 ** 24 + byte(at + 1) * 2 ** 16 + byte(at + 2) * 2 ** 8 + byte(at + 3)
  const colorType = byte(25)
  return { width: u32(16), height: u32(20), alpha: colorType === 4 || colorType === 6 }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decodeBase64(text: string): number[] {
  const out: number[] = []
  let bits = 0
  let count = 0
  for (const ch of text) {
    const value = B64.indexOf(ch)
    if (value < 0) continue
    bits = (bits << 6) | value
    count += 6
    if (count >= 8) {
      count -= 8
      out.push((bits >> count) & 0xff)
      bits &= (1 << count) - 1
    }
  }
  return out
}

// ---- 用量 --------------------------------------------------------------------

type RateLimits = {
  id?: number
  result?: {
    rateLimits?: {
      primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }
      planType?: string
      spendControlReached?: boolean
    }
    rateLimitResetCredits?: { availableCount?: number }
  }
}

export function parseUsage(stdout: string, at: number): EaselUsage | null {
  for (const line of stdout.split('\n')) {
    let value: RateLimits
    try {
      value = JSON.parse(line) as RateLimits
    } catch {
      continue
    }
    const primary = value.result?.rateLimits?.primary
    if (value.id !== 2 || typeof primary?.usedPercent !== 'number') continue
    return {
      usedPercent: primary.usedPercent,
      windowMins: primary.windowDurationMins ?? 0,
      resetsAt: primary.resetsAt ?? 0,
      plan: value.result?.rateLimits?.planType ?? 'unknown',
      freeResets: value.result?.rateLimitResetCredits?.availableCount ?? 0,
      at,
    }
  }
  return null
}

export type UsageView = {
  percent: number
  /** 時間過了這個週期的幾成，0–100 */
  pace: number
  /** 粗估還能生幾張；張數太少、算不準時是 null */
  remaining: number | null
  today: number
  tone: 'none' | 'warn' | 'crit'
  reset: string
}

/**
 * 官方只給文字與生圖共用的百分比，沒有每張的額度，張數是 easel 用本機圖檔自己數的。
 * 百分比只到整數，所以張數太少不估，估了也捨去到十位，別讓人以為很準。
 */
export function usageView(usage: EaselUsage, imageTimes: readonly number[], now: number, startOfDay: number): UsageView {
  const end = usage.resetsAt * 1000
  const start = end - usage.windowMins * 60_000
  const inWindow = imageTimes.filter(t => t >= start).length
  const span = end - start
  const percent = usage.usedPercent
  const estimate = percent >= 1 && inWindow >= 5 ? Math.floor(((100 - percent) / percent) * inWindow / 10) * 10 : null
  return {
    percent,
    pace: span > 0 ? Math.min(100, Math.max(0, ((now - start) / span) * 100)) : 0,
    remaining: percent >= 100 ? 0 : estimate,
    today: imageTimes.filter(t => t >= startOfDay).length,
    tone: percent >= 100 ? 'crit' : percent >= WARN_PERCENT ? 'warn' : 'none',
    reset: shortDate(end),
  }
}

export function planName(plan: string): string {
  const known: Record<string, string> = { free: 'Free', go: 'Go', plus: 'Plus', pro: 'Pro', team: 'Team', business: 'Business', enterprise: 'Enterprise' }
  return `ChatGPT ${known[plan] ?? plan}`
}

export function shortDate(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

export function ago(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return '剛剛'
  if (minutes < 60) return `${minutes} 分鐘前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小時前`
  return shortDate(ms)
}

// ---- 平台 --------------------------------------------------------------------

/** easel 跑得起來的三種環境。列檔走引擎的 $.fs 不分平台；會因平台而異的事都列在下面的 PLATFORMS 表。 */
export type Platform = EaselPlatform

/** 問這台電腦是哪一種：印出 uname，有 wslpath 再多印一行 wsl（WSL 的 uname 也是 Linux）。 */
export const PLATFORM_PROBE = ['sh', '-c', 'uname -s; if command -v wslpath >/dev/null 2>&1; then echo wsl; fi']

export function platformOf(probe: string): Platform {
  const lines = probe.split('\n').map(line => line.trim())
  if (lines[0] === 'Darwin') return 'macos'
  return lines.includes('wsl') ? 'wsl' : 'linux'
}

/** 找不到 Codex 時教的裝法。command 有值才顯示成一行指令並給「複製指令」。 */
export type CodexInstall = { text: string; command: string | null }

/**
 * 做面板縮圖的方式。桌面與手機只能把圖嵌進 Svg，所以要先縮小、轉成瀏覽器認得的格式。
 * ext 是快取檔的副檔名，mime 是嵌進 Svg 時 data URI 的類型，兩個都要跟實際轉出來的格式一致。
 */
export type Thumbnailer = {
  ext: string
  mime: string
  /** 把 file 縮到 width 寬、存成 out 的指令；quality 是 0–100 */
  argv: (file: string, out: string, width: number, quality: number) => string[]
  /** 做不出來時畫在圖位上的話 */
  failed: string
}

type PlatformRow = {
  /** 用預設程式開一個檔的指令 */
  open: (file: string) => string[]
  codexInstall: CodexInstall
  thumbnail: Thumbnailer
}

const FFMPEG_WEBP: Thumbnailer = {
  ext: 'webp',
  mime: 'image/webp',
  argv: (file, out, width, quality) => ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', file, '-vf', `scale=${width}:-2:flags=lanczos`, '-c:v', 'libwebp', '-q:v', String(quality), out],
  failed: '縮圖做不出來，請確認有裝 ffmpeg',
}

// macOS 用系統內建的 sips，不必另外裝東西。它寫不出 WebP（實測 27.2 只能讀），所以轉 JPEG；
// JPEG 沒有透明，透明的地方會變白底，面板上的棋盤格看不到，原圖不受影響。
const SIPS_JPEG: Thumbnailer = {
  ext: 'jpg',
  mime: 'image/jpeg',
  argv: (file, out, width, quality) => ['sips', '--resampleWidth', String(width), '-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), file, '--out', out],
  failed: '縮圖做不出來（系統內建的 sips 沒有成功）',
}

const INSTALL_SCRIPT: CodexInstall = { text: '請在終端機跑官方安裝指令：', command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' }

// 會因平台而異的事都在這張表，一個平台一列；新平台或新差異加在這裡，不要到別處寫 if。
// WSL 開檔要先把路徑換成 Windows 的寫法，explorer.exe 成功也回 1，所以後面補 true。
// macOS 不教 curl | sh：那邊的人多半有自己管理工具的方式，照他的方式裝。
const PLATFORMS: Record<Platform, PlatformRow> = {
  macos: {
    open: file => ['open', file],
    codexInstall: { text: '請用你平常管理工具的方式安裝官方 Codex CLI，裝法見 https://github.com/openai/codex 。裝好後再試一次。', command: null },
    thumbnail: SIPS_JPEG,
  },
  wsl: { open: file => ['sh', '-c', 'explorer.exe "$(wslpath -w "$1")"; true', 'sh', file], codexInstall: INSTALL_SCRIPT, thumbnail: FFMPEG_WEBP },
  linux: { open: file => ['xdg-open', file], codexInstall: INSTALL_SCRIPT, thumbnail: FFMPEG_WEBP },
}

/** 用預設程式開一個檔的指令。 */
export function openArgv(platform: Platform, file: string): string[] {
  return PLATFORMS[platform].open(file)
}

export function thumbnailer(platform: Platform): Thumbnailer {
  return PLATFORMS[platform].thumbnail
}

export function codexInstall(platform: Platform): CodexInstall {
  return PLATFORMS[platform].codexInstall
}

/** 找不到 Codex 時回給 Claude 的一句話。 */
export function codexMissingText(platform: Platform): string {
  const { text, command } = codexInstall(platform)
  return `這台電腦找不到官方 Codex。${text}${command ?? ''}`
}

// ---- 登入 --------------------------------------------------------------------

/** `codex login --device-auth` 的畫面文字裡找網址與代碼（會帶 ANSI 色碼）。 */
export function parseDeviceAuth(text: string): { url: string; code: string } | null {
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '')
  const url = plain.match(/https:\/\/\S+/)?.[0]
  const code = plain.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,}\b/)?.[0]
  return url && code ? { url, code } : null
}

// ---- 防繞路 ------------------------------------------------------------------

/** Claude 想自己叫 codex 生圖時擋下來：那樣 easel 收不到圖，也沒有檢查。其他 codex 用法不管。 */
export function isDirectImageCall(command: string): boolean {
  return /\bcodex\s+exec\b/.test(command) && /imagegen|image_gen|生圖|畫一/.test(command)
}
