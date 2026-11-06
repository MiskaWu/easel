// easel 的純函式：素材紀錄、提示詞、Codex 指令、事件解析、用量換算。不碰 $，可以單獨測。
// 這裡的每條規則都來自 2026-11-06 的實測（數據在規格文件的「Phase 0 實測結果」），改之前先看那裡。

import type { EaselMeta, EaselUsage, EaselVersion } from '../types'

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

/** generated_images/<對話編號>/ 底下比生圖前多出來的最新一張：`<時間> <路徑>` 一行一筆。 */
export function newestNewImage(listing: string, before: ReadonlySet<string>): string | null {
  const rows = listing
    .split('\n')
    .map(line => {
      const at = line.indexOf(' ')
      return { time: Number(line.slice(0, at)), path: line.slice(at + 1) }
    })
    .filter(row => row.path.endsWith('.png') && !before.has(row.path))
  return rows.reduce<{ time: number; path: string } | null>((best, row) => (best && best.time >= row.time ? best : row), null)?.path ?? null
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

/** `find -printf '%T@\n'` 的輸出換成毫秒。 */
export function parseTimes(listing: string): number[] {
  return listing
    .split('\n')
    .map(line => Number(line) * 1000)
    .filter(t => Number.isFinite(t) && t > 0)
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
