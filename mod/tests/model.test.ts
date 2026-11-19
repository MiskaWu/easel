import { describe, expect, test } from 'claude-code/testing'

import { LIST_PAGE, PENDING_CARDS, REVIEW_TEXT, REVISE_LIMIT, ago, autoStepText, autoStreak, clampLimit, codexInstall, codexMissingText, failureText, humanReviewed, isAutoBase, isDirectImageCall, isValidName, latest, limitReachedText, limitText, newArgv, newPrompt, newestNewImage, nextVersion, openArgv, parseDeviceAuth, parseEvent, parseMeta, parsePng, parseUsage, patchVersion, pageOf, pendingByRecency, platformOf, resolveLimit, reviseArgv, reviseStep, reviewCounts, splitPending, storedLimitAfter, thumbnailer, revisePrompt, splitLines, uncheckedText, usageArgv, usageView, wasAuto } from '../hooks/model'
import type { EaselMeta, EaselUsage, EaselVersion } from '../types'

const version = (n: number, over: Partial<EaselVersion> = {}): EaselVersion => ({
  n,
  file: `v${n}.png`,
  threadId: 't1',
  base: null,
  prompt: 'p',
  refs: [],
  createdAt: n,
  elapsedS: 1,
  width: 10,
  height: 10,
  alpha: false,
  selfCheck: 'pending',
  selfNote: '',
  review: 'pending',
  note: '',
  ...over,
})

const meta = (versions: EaselVersion[]): EaselMeta => ({ asset: 'fox', transparent: false, codexVersion: '0.167.0', versions })

describe('素材紀錄', () => {
  test('素材名會變成資料夾名，只收小寫英數與連字號', async () => {
    expect(isValidName('hero-fox')).toBe(true)
    expect(isValidName('Hero')).toBe(false)
    expect(isValidName('../up')).toBe(false)
    expect(isValidName('-x')).toBe(false)
  })

  test('版本編號不重複，刪掉中間的版本也不會撞號', async () => {
    expect(nextVersion(meta([]))).toBe(1)
    expect(nextVersion(meta([version(1), version(4)]))).toBe(5)
    expect(latest(meta([version(4), version(1)]))?.n).toBe(4)
  })

  test('改一版不動到其他版', async () => {
    const out = patchVersion(meta([version(1), version(2)]), 2, { review: 'approved' })
    expect(out.versions[0]?.review).toBe('pending')
    expect(out.versions[1]?.review).toBe('approved')
  })

  test('壞掉的 meta.json 當作沒有這個素材，不讓面板掛掉', async () => {
    expect(parseMeta('{oops')).toBeNull()
    expect(parseMeta('{"asset":1}')).toBeNull()
    expect(parseMeta(JSON.stringify(meta([])))?.asset).toBe('fox')
  })
})

describe('自動修改的上限', () => {
  test('預設 2 次、可調 0 到 10：已安裝的人不改設定，行為和以前一樣', async () => {
    expect(REVISE_LIMIT).toEqual({ default: 2, min: 0, max: 10 })
  })

  test('超出範圍就夾住，小數四捨五入，不是數字就當沒給', async () => {
    expect(clampLimit(3)).toBe(3)
    expect(clampLimit(-1)).toBe(0)
    expect(clampLimit(99)).toBe(10)
    expect(clampLimit(2.6)).toBe(3)
    expect(clampLimit(0)).toBe(0)
    expect(clampLimit('5')).toBeNull()
    expect(clampLimit(Number.NaN)).toBeNull()
    expect(clampLimit(Number.POSITIVE_INFINITY)).toBeNull()
    expect(clampLimit(undefined)).toBeNull()
    expect(clampLimit(null)).toBeNull()
  })

  test('三層：當次指定蓋過面板，面板蓋過預設；壞掉的值往下一層找', async () => {
    expect(resolveLimit(undefined)).toEqual({ limit: 2, source: 'default' })
    expect(resolveLimit(5)).toEqual({ limit: 5, source: 'panel' })
    expect(resolveLimit(5, 7)).toEqual({ limit: 7, source: 'call' })
    expect(resolveLimit(undefined, 0)).toEqual({ limit: 0, source: 'call' })
    expect(resolveLimit(5, 99)).toEqual({ limit: 10, source: 'call' })
    expect(resolveLimit(0)).toEqual({ limit: 0, source: 'panel' })
    expect(resolveLimit('壞掉', undefined)).toEqual({ limit: 2, source: 'default' })
    expect(resolveLimit(4, '三')).toEqual({ limit: 4, source: 'panel' })
  })

  test('面板的增減夾在範圍內；調回預設值就不存，來源回到「預設」', async () => {
    expect(storedLimitAfter(2, 1)).toBe(3)
    expect(storedLimitAfter(3, -1)).toBeNull()
    expect(storedLimitAfter(10, 1)).toBe(10)
    expect(storedLimitAfter(0, -1)).toBe(0)
    expect(storedLimitAfter(1, -1)).toBe(0)
  })

  test('0 寫成「不自動修改」', async () => {
    expect(limitText(0)).toBe('不自動修改')
    expect(limitText(3)).toBe('最多 3 次')
  })

  const fail = { selfCheck: 'fail' as const }
  const pass = { selfCheck: 'pass' as const }

  test('只有接在「不合格、人還沒審」的版本後面才算自動修改；人在面板提過修改也算審過', async () => {
    expect(isAutoBase(version(1, fail))).toBe(true)
    expect(isAutoBase(version(1, pass))).toBe(false)
    expect(isAutoBase(version(1))).toBe(false)
    expect(isAutoBase(version(1, { ...fail, review: 'rejected' }))).toBe(false)
    expect(isAutoBase(version(1, { ...fail, askedAt: 5 }))).toBe(false)
    expect(humanReviewed(version(1))).toBe(false)
    expect(humanReviewed(version(1, { review: 'approved' }))).toBe(true)
    expect(humanReviewed(version(1, { askedAt: 5 }))).toBe(true)
  })

  test('連續次數：從最新往回數自動修改的版本，數到第一版或人接手的版本為止', async () => {
    const run = meta([version(1, fail), version(2, { ...fail, base: 1, auto: true }), version(3, { ...fail, base: 2, auto: true })])
    expect(autoStreak(run)).toBe(2)
    expect(reviseStep(run, version(3, fail))).toEqual({ kind: 'auto', k: 3 })
    // 指定 base 回到更早的不合格版本，次數不會歸零
    expect(reviseStep(run, version(1, fail))).toEqual({ kind: 'auto', k: 3 })
    // 中間有一版合格：從它之後重新數
    const passed = meta([version(1, fail), version(2, { ...fail, base: 1, auto: true }), version(3, { ...pass, base: 2, auto: true })])
    expect(autoStreak(passed)).toBe(0)
    expect(reviseStep(passed, version(2, { ...fail, base: 1, auto: true }))).toEqual({ kind: 'auto', k: 1 })
    // 使用者自己要求的修改（auto: false）也是分界
    const asked = meta([version(1, fail), version(2, { ...fail, base: 1, auto: true }), version(3, { ...fail, base: 2, auto: false })])
    expect(autoStreak(asked)).toBe(0)
    // 人在面板退回過：人已經接手
    const reviewed = meta([version(1, fail), version(2, { ...fail, base: 1, auto: true, review: 'rejected' })])
    expect(autoStreak(reviewed)).toBe(0)
    expect(reviseStep(reviewed, reviewed.versions[1] as EaselVersion)).toEqual({ kind: 'manual' })
  })

  test('底圖只有三種：合格或人審過＝使用者要求的修改；不合格且沒人審＝自動修改；還沒自檢也沒人審＝先自檢', async () => {
    const run = meta([version(1, fail), version(2, { ...pass, base: 1, auto: true })])
    expect(reviseStep(run, version(2, pass))).toEqual({ kind: 'manual' })
    expect(reviseStep(meta([version(1)]), version(1))).toEqual({ kind: 'unchecked' })
    // 人在面板退回、核准，或對它提了修改：沒自檢也可以改，而且不算自動修改
    expect(reviseStep(meta([version(1, { review: 'rejected' })]), version(1, { review: 'rejected' }))).toEqual({ kind: 'manual' })
    expect(reviseStep(meta([version(1, { askedAt: 5 })]), version(1, { askedAt: 5 }))).toEqual({ kind: 'manual' })
    expect(reviseStep(meta([version(1, { ...fail, askedAt: 5 })]), version(1, { ...fail, askedAt: 5 }))).toEqual({ kind: 'manual' })
    const text = uncheckedText('fox', 3)
    expect(text).toContain('v3 還沒自檢')
    expect(text).toContain('Read')
    expect(text).toContain('self_check')
  })

  test('舊的 meta.json 沒記 auto：看底圖現在是不是不合格、沒人審', async () => {
    const old = meta([version(1, fail), version(2, { ...fail, base: 1 }), version(3, { ...fail, base: 2 })])
    expect(wasAuto(old, version(1, fail))).toBe(false)
    expect(wasAuto(old, version(2, { ...fail, base: 1 }))).toBe(true)
    expect(autoStreak(old)).toBe(2)
    // 底圖合格、或底圖已經不在了，都不算
    expect(wasAuto(meta([version(1, pass), version(2, { base: 1 })]), version(2, { base: 1 }))).toBe(false)
    expect(wasAuto(meta([version(2, { base: 1 })]), version(2, { base: 1 }))).toBe(false)
    // 讀得進來：parseMeta 不因為少了欄位就丟掉素材
    expect(parseMeta(JSON.stringify(old))?.versions.length).toBe(3)
  })

  test('到上限的話要講清楚：連續幾次、上限幾次、哪一層定的、怎麼繼續', async () => {
    const text = limitReachedText('fox', 2, { limit: 2, source: 'default' })
    expect(text).toContain('連續自動修改 2 次')
    expect(text).toContain('上限是 2 次（預設）')
    expect(text).toContain('limit')
    expect(text).toContain('/easel 面板')
    expect(limitReachedText('fox', 0, { limit: 0, source: 'panel' })).toContain('上限是 0（你在面板調的，不自動修改）')
    expect(autoStepText(1, { limit: 4, source: 'call' })).toBe('這是連續第 1 次自動修改，上限 4 次（這次指定）。')
  })
})

describe('提示詞', () => {
  test('透明要明講參數：實測模型沒設 transparent_background 就生出不透明的圖', async () => {
    expect(newPrompt('貓', true)).toContain('transparent_background')
    expect(newPrompt('貓', false)).not.toContain('transparent_background')
    expect(revisePrompt('改尾巴', 2, true)).toContain('transparent_background')
  })

  test('修改要寫明附圖就是底圖：不寫的話模型可能拿舊版當底', async () => {
    const text = revisePrompt('圍巾改紅', 3, false)
    expect(text).toContain('v3')
    expect(text).toContain('底圖')
    expect(text).toContain('圍巾改紅')
  })

  test('一定走內建生圖，不准模型自己複製檔案', async () => {
    expect(newPrompt('貓', false)).toContain('$imagegen')
    expect(newPrompt('貓', false)).toContain('不要複製')
  })
})

describe('Codex 指令', () => {
  test('一律清掉 API key，避免悄悄改走 API 計費', async () => {
    for (const argv of [newArgv('/w', []), reviseArgv('/w', 't', '/b.png')]) {
      expect(argv.join(' ')).toContain('env -u OPENAI_API_KEY -u CODEX_API_KEY')
    }
    expect(usageArgv().join(' ')).toContain('-u OPENAI_API_KEY -u CODEX_API_KEY')
  })

  test('--sandbox 與 -C 要在 resume 前面：放後面 Codex 會報錯', async () => {
    const argv = reviseArgv('/w', 't', '/b.png')
    const resume = argv.indexOf('resume')
    expect(resume).toBeGreaterThan(-1)
    expect(argv.indexOf('--sandbox')).toBeLessThan(resume)
    expect(argv.indexOf('-C')).toBeLessThan(resume)
  })

  test('修改一定附底圖、一定指定對話編號，不用 --last', async () => {
    const argv = reviseArgv('/w', 'thread-1', '/b.png')
    expect(argv.slice(argv.indexOf('resume'))).toEqual(['resume', 'thread-1', '-', '-i', '/b.png'])
    expect(argv).not.toContain('--last')
  })

  test('提示詞走 stdin：exec 的 -i 會把後面的引數當檔名吃掉', async () => {
    const argv = newArgv('/w', ['/ref.png'])
    expect(argv.at(-2)).toBe('-i')
    expect(argv.at(-1)).toBe('/ref.png')
  })
})

describe('解析', () => {
  test('輸出是一塊塊送來的，要接成完整的行', async () => {
    const first = splitLines('', '{"a":1}\n{"b"')
    expect(first.lines).toEqual(['{"a":1}'])
    expect(splitLines(first.rest, ':2}\n').lines).toEqual(['{"b":2}'])
  })

  test('事件只取對話編號與錯誤', async () => {
    expect(parseEvent('{"type":"thread.started","thread_id":"t9"}')).toEqual({ kind: 'thread', threadId: 't9' })
    expect(parseEvent('{"type":"turn.failed","error":{"message":"bad"}}')).toEqual({ kind: 'failed', message: 'bad' })
    expect(parseEvent('{"type":"turn.completed"}')).toEqual({ kind: 'other' })
    expect(parseEvent('not json')).toEqual({ kind: 'other' })
  })

  test('等待上限到了要講人話', async () => {
    expect(failureText(124, null)).toContain('180')
    expect(failureText(1, '壞了')).toBe('壞了')
  })

  test('只認這次多出來的圖，而且取最新的：透明圖模型可能先生幾張不透明的', async () => {
    const files = [
      { path: '/g/old.png', mtimeMs: 40_500 },
      { path: '/g/b.png', mtimeMs: 30_500 },
      { path: '/g/a.png', mtimeMs: 20_500 },
      { path: '/g/b.txt', mtimeMs: 50_000 },
    ]
    expect(newestNewImage(files, new Set(['/g/old.png']))).toBe('/g/b.png')
    expect(newestNewImage(files, new Set(['/g/old.png', '/g/a.png', '/g/b.png']))).toBeNull()
    expect(newestNewImage([], new Set())).toBeNull()
  })

  test('從檔頭讀尺寸與透明通道', async () => {
    // 1254×1254 RGB 與 1536×1024 RGBA 的 PNG 檔頭
    const rgb = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 0xe6, 0, 0, 4, 0xe6, 8, 2))
    const rgba = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 6, 0, 0, 0, 4, 0, 8, 6))
    expect(parsePng(rgb)).toEqual({ width: 1254, height: 1254, alpha: false })
    expect(parsePng(rgba)).toEqual({ width: 1536, height: 1024, alpha: true })
    expect(parsePng(btoa('not a png at all, sorry about that'))).toBeNull()
  })

  test('登入畫面帶色碼也找得到網址與代碼', async () => {
    const text = '1. Open\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n2. code\n   \u001b[94m2EWR-OWF2H\u001b[0m\n'
    expect(parseDeviceAuth(text)).toEqual({ url: 'https://auth.openai.com/codex/device', code: '2EWR-OWF2H' })
    expect(parseDeviceAuth('Welcome')).toBeNull()
  })

  test('只擋 Claude 自己叫 codex 生圖，其他用法不管', async () => {
    expect(isDirectImageCall("codex exec '$imagegen 畫一隻貓'")).toBe(true)
    expect(isDirectImageCall('codex exec "review this"')).toBe(false)
    expect(isDirectImageCall('codex --version')).toBe(false)
  })
})

describe('用量', () => {
  const NOW = Date.parse('2026-11-06T06:00:00Z')
  const usage = (usedPercent: number): EaselUsage => ({ usedPercent, windowMins: 43200, resetsAt: Math.round((NOW + 29 * 86_400_000) / 1000), plan: 'go', freeResets: 2, at: NOW })
  const times = (count: number) => Array.from({ length: count }, (_, i) => NOW - i * 1000)
  const startOfDay = NOW - 3_600_000

  test('讀官方回應', async () => {
    const line = JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: 3, windowDurationMins: 43200, resetsAt: 100 }, planType: 'go' }, rateLimitResetCredits: { availableCount: 2 } } })
    expect(parseUsage(`{"id":1,"result":{}}\n${line}\n`, 5)).toEqual({ usedPercent: 3, windowMins: 43200, resetsAt: 100, plan: 'go', freeResets: 2, at: 5 })
    expect(parseUsage('', 5)).toBeNull()
  })

  test('實測 15 張用掉 3%，粗估還能生 480 張，捨去到十位不裝準', async () => {
    const view = usageView(usage(3), times(15), NOW, startOfDay)
    expect(view.remaining).toBe(480)
    expect(view.today).toBe(15)
    expect(view.tone).toBe('none')
  })

  test('張數太少不估：百分比只到整數，估了也不準', async () => {
    expect(usageView(usage(3), times(4), NOW, startOfDay).remaining).toBeNull()
    expect(usageView(usage(0), times(20), NOW, startOfDay).remaining).toBeNull()
  })

  test('週期之前的圖不算進估算', async () => {
    const old = [NOW - 40 * 86_400_000]
    expect(usageView(usage(3), [...times(5), ...old], NOW, startOfDay).remaining).toBe(160)
  })

  test('75% 起提醒，100% 停', async () => {
    expect(usageView(usage(75), times(15), NOW, startOfDay).tone).toBe('warn')
    expect(usageView(usage(100), times(15), NOW, startOfDay).tone).toBe('crit')
    expect(usageView(usage(100), times(15), NOW, startOfDay).remaining).toBe(0)
  })

  test('時間進度：30 天過了 1 天', async () => {
    expect(Math.round(usageView(usage(3), [], NOW, startOfDay).pace)).toBe(3)
  })

  test('時間說法', async () => {
    expect(ago(NOW - 10_000, NOW)).toBe('剛剛')
    expect(ago(NOW - 180_000, NOW)).toBe('3 分鐘前')
    expect(ago(NOW - 7_200_000, NOW)).toBe('2 小時前')
  })
})

describe('平台', () => {
  test('uname 是 Darwin 就是 macOS；Linux 裡有 wslpath 才是 WSL', async () => {
    expect(platformOf('Darwin\n')).toBe('macos')
    expect(platformOf('Linux\n')).toBe('linux')
    expect(platformOf('Linux\nwsl\n')).toBe('wsl')
    expect(platformOf('')).toBe('linux')
  })

  test('開檔指令每個平台各一列：macOS 用 open，不能掉到 xdg-open', async () => {
    expect(openArgv('macos', '/p/a b.png')).toEqual(['open', '/p/a b.png'])
    expect(openArgv('linux', '/p/a.png')).toEqual(['xdg-open', '/p/a.png'])
    expect(openArgv('wsl', '/p/a.png').join(' ')).toContain('explorer.exe "$(wslpath -w "$1")"')
    expect(openArgv('wsl', '/p/a.png').at(-1)).toBe('/p/a.png')
  })

  test('縮圖：Linux 與 WSL 用 ffmpeg 轉 WebP，macOS 用內建的 sips 轉 JPEG；副檔名、類型、指令三者一致', async () => {
    const mac = thumbnailer('macos')
    expect([mac.ext, mac.mime]).toEqual(['jpg', 'image/jpeg'])
    expect(mac.argv('/a/v1.png', '/a/.thumbs/v1-280.jpg', 280, 70)).toEqual(['sips', '--resampleWidth', '280', '-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '/a/v1.png', '--out', '/a/.thumbs/v1-280.jpg'])
    expect(mac.failed).not.toContain('ffmpeg')
    for (const platform of ['linux', 'wsl'] as const) {
      const maker = thumbnailer(platform)
      expect([maker.ext, maker.mime]).toEqual(['webp', 'image/webp'])
      const argv = maker.argv('/a/v1.png', '/a/.thumbs/v1-280.webp', 280, 70)
      expect(argv[0]).toBe('ffmpeg')
      expect(argv.join(' ')).toContain('scale=280:-2')
      expect(argv.join(' ')).toContain('-c:v libwebp -q:v 70 /a/.thumbs/v1-280.webp')
      expect(maker.failed).toContain('ffmpeg')
    }
  })

  test('找不到 Codex 時教的裝法：Linux 與 WSL 給官方安裝指令，macOS 不教 curl | sh', async () => {
    expect(codexInstall('linux').command).toContain('curl -fsSL https://chatgpt.com/codex/install.sh | sh')
    expect(codexInstall('wsl').command).toBe(codexInstall('linux').command)
    expect(codexInstall('macos').command).toBeNull()
    expect(codexMissingText('macos')).not.toContain('curl')
    expect(codexMissingText('macos')).toContain('管理工具的方式')
    expect(codexMissingText('linux')).toBe('這台電腦找不到官方 Codex。請在終端機跑官方安裝指令：curl -fsSL https://chatgpt.com/codex/install.sh | sh')
  })
})

describe('等你審的份量與收起來', () => {
  const asset = (name: string, createdAt: number, review: EaselVersion['review'] = 'pending') => ({ ...meta([version(1, { createdAt, review })]), asset: name })

  test('首頁只畫最新 5 張卡、清單一頁 8 列；常數寫在這裡，不散在面板裡', async () => {
    expect(PENDING_CARDS).toBe(5)
    expect(LIST_PAGE).toBe(8)
  })

  test('待審照最新一版的時間由新到舊；正在畫的、收起、核准、退回都不算', async () => {
    const list = [asset('a', 1), asset('b', 3), asset('c', 2), asset('d', 9, 'shelved'), asset('e', 8, 'approved'), asset('f', 7, 'rejected'), asset('g', 6)]
    expect(pendingByRecency(list, new Set(['g'])).map(m => m.asset)).toEqual(['b', 'c', 'a'])
    expect(reviewCounts(list, new Set(['g']))).toEqual({ pending: 3, approved: 1, rejected: 1, shelved: 1 })
  })

  test('最新幾張畫成卡，其餘是較早的', async () => {
    const list = Array.from({ length: 44 }, (_, i) => i)
    const { cards, earlier } = splitPending(list)
    expect(cards).toEqual([0, 1, 2, 3, 4])
    expect(earlier.length).toBe(39)
    expect(splitPending([1, 2]).earlier).toEqual([])
  })

  test('分頁：頁數超出就夾到最後一頁，清單變短也不會停在空白頁', async () => {
    const list = Array.from({ length: 39 }, (_, i) => i)
    expect(pageOf(list, 0)).toEqual({ items: [0, 1, 2, 3, 4, 5, 6, 7], page: 0, pages: 5 })
    expect(pageOf(list, 4).items).toEqual([32, 33, 34, 35, 36, 37, 38])
    expect(pageOf(list, 9).page).toBe(4)
    expect(pageOf(list, -3).page).toBe(0)
    expect(pageOf([], 2)).toEqual({ items: [], page: 0, pages: 1 })
  })

  test('「收起」是中性的：不算人審過，自檢不合格又收起來的版本，接著改照樣算自動修改', async () => {
    expect(REVIEW_TEXT.shelved).toBe('收起')
    expect(humanReviewed(version(1, { review: 'shelved' }))).toBe(false)
    expect(isAutoBase(version(1, { selfCheck: 'fail', review: 'shelved' }))).toBe(true)
    expect(reviseStep(meta([version(1, { review: 'shelved' })]), version(1, { review: 'shelved' }))).toEqual({ kind: 'unchecked' })
  })
})
