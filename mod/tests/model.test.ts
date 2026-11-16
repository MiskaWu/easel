import { describe, expect, test } from 'claude-code/testing'

import { ago, codexInstall, codexMissingText, failureText, isDirectImageCall, isValidName, latest, newArgv, newPrompt, newestNewImage, nextVersion, openArgv, parseDeviceAuth, parseEvent, parseMeta, parsePng, parseUsage, patchVersion, platformOf, reviseArgv, thumbnailer, revisePrompt, splitLines, usageArgv, usageView } from '../hooks/model'
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
