// easel 的狀態契約。素材紀錄存在專案的 art/<素材>/meta.json，這裡只放畫面要讀的值。

export type EaselVersion = {
  n: number
  file: string
  /** 畫這一版的 Codex 對話。版本太多時可以換新對話，所以每版各記一個。 */
  threadId: string
  /** 以第幾版為底；新圖是 null */
  base: number | null
  prompt: string
  refs: string[]
  createdAt: number
  elapsedS: number
  width: number
  height: number
  alpha: boolean
  selfCheck: 'pending' | 'pass' | 'fail'
  selfNote: string
  review: 'pending' | 'approved' | 'rejected'
  note: string
}

export type EaselMeta = {
  asset: string
  /** 這個素材要透明背景 */
  transparent: boolean
  codexVersion: string
  versions: EaselVersion[]
}

export type EaselView =
  | { kind: 'home' }
  | { kind: 'detail'; asset: string; version: number }
  | { kind: 'compare'; asset: string; version: number }

export type EaselJob = {
  asset: string
  version: number
  base: number | null
  prompt: string
  phase: 'send' | 'draw' | 'save'
  startedAt: number
}

export type EaselUsage = {
  usedPercent: number
  windowMins: number
  resetsAt: number
  plan: string
  freeResets: number
  at: number
}

/** easel 跑得起來的三種環境 */
export type EaselPlatform = 'macos' | 'wsl' | 'linux'

/** 這台電腦能不能用：還沒查、沒裝 Codex、沒登入、可以用。platform 查過才有，決定教哪一種裝法、縮圖做不出來時怎麼說 */
export type EaselSetup = { state: 'unknown' | 'missing' | 'logged-out' | 'ready'; version: string; platform?: EaselPlatform }

export type EaselLogin = { state: 'idle' } | { state: 'starting' } | { state: 'waiting'; url: string; code: string; until: number } | { state: 'failed'; message: string }

/** 上一次沒成功的事，顯示在面板直到處理掉 */
export type EaselNotice = {
  asset: string
  kind: 'failed' | 'no-image' | 'no-alpha'
  title: string
  detail: string
  /** 重試時送給 Claude 的話 */
  retry: string
}

/** 啟動時沒成功的一項，顯示在對話框上方與面板，直到下次啟動 */
export type EaselStartupProblem = { label: string; message: string }

declare module 'claude-code' {
  interface PluginState {
    easel: {
      view: EaselView
      assets: EaselMeta[]
      jobs: EaselJob[]
      usage: EaselUsage | null
      imageTimes: number[]
      setup: EaselSetup
      login: EaselLogin
      notices: EaselNotice[]
      startup: EaselStartupProblem[]
      tick: number
    }
  }
}
