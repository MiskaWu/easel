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
  /**
   * 這一版是自動修改畫出來的（接在自檢不合格、人還沒審過的版本後面 revise）。用來數連續自動修改了幾次。
   * 0.1.4 起才記；更舊的 meta.json 沒有這個欄位，照它的底圖推回來（model.ts 的 wasAuto）。
   */
  auto?: boolean
  /**
   * 人在面板上對這一版提修改要求的時間（審稿頁的「想改什麼？」、比較頁的「改用這版當底再畫」）。
   * 只有面板寫，算「人審過」：以它為底的 revise 不必先自檢，也不算自動修改。0.1.4 起才有。
   */
  askedAt?: number
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
      /** 面板上調的自動修改上限，$.store 裡那份的鏡像，給面板重畫用；null 是沒調過（用預設值） */
      reviseLimit: number | null
    }
  }
}
