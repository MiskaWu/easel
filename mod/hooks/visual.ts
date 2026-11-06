// easel 的畫圖函式：給資料、回 SVG 字串，不碰 $。底層積木來自 mod-polish 的 visual-kit。
// 桌面 app 與手機用 Svg 畫，終端機用文字。圖片只能嵌進 Svg（Image 元件只有終端機有）。
//
// 配色：只有一個強調色 a（靛藍）＝「easel 正在做的事與主要動作」；
// 待審用 warn、已核准用 ok、失敗用 crit，狀態一律「點或圖示＋字」，不只靠顏色。

export type Drawing = { source: string; alt: string; height: number; animated?: boolean }
export type Accent = { light: string; dark: string; lightText: string; darkText: string }

export const ACCENTS: Record<string, Accent> = {
  a: { light: '#4338ca', dark: '#a5a1ff', lightText: '#3730a3', darkText: '#c4c1ff' }, // 靛藍
}
const STATUS: Record<string, Accent> = {
  ok: { light: '#0b8a3a', dark: '#3fbf6a', lightText: '#0a6b2e', darkText: '#6fd892' },
  warn: { light: '#d99a06', dark: '#f5b52e', lightText: '#7a5300', darkText: '#f5c451' },
  crit: { light: '#c8322f', dark: '#f06a63', lightText: '#9e2320', darkText: '#ff8f88' },
}

export const FONT = `'Segoe UI Variable Text','Segoe UI',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei UI','Microsoft JhengHei','Noto Sans TC','Noto Sans CJK TC',sans-serif`
export const MONO = `'Cascadia Mono','JetBrains Mono',Consolas,ui-monospace,monospace`

function classes(name: string, c: Accent, dark: boolean): string {
  const v = dark ? c.dark : c.light
  const t = dark ? c.darkText : c.lightText
  const k = dark ? 0.16 : 0.1
  return `.${name}{fill:${v}}.${name}S{stroke:${v}}.${name}K{fill:${v};fill-opacity:${k}}.${name}T{fill:${t}}`
}

export function style(): string {
  const all = { ...ACCENTS, ...STATUS }
  const light = Object.entries(all).map(([n, c]) => classes(n, c, false)).join('')
  const dark = Object.entries(all).map(([n, c]) => classes(n, c, true)).join('')
  return (
    `<style>` +
    `text{font-family:${FONT};}.m{font-family:${MONO};}` +
    `.t1{fill:#0b0b0b}.t2{fill:#52514e}.t3{fill:#77766f}.on{fill:#ffffff}` +
    `.hair{stroke:#e4e3de}.panel{fill:#f4f3ef}.ink{stroke:#3b3a36}.tick{fill:#6b6a64}.onS{stroke:#ffffff}` +
    light +
    `@media (prefers-color-scheme: dark){` +
    `.t1{fill:#f0efec}.t2{fill:#c3c2b7}.t3{fill:#97968e}` +
    `.hair{stroke:#34342f}.panel{fill:#24241f}.ink{stroke:#d6d5cd}.tick{fill:#a3a29a}.onS{stroke:#17172b}` +
    dark +
    `}</style>`
  )
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const wide = (ch: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)

/** 估計的字寬（px）：中日韓一個字級寬；mono 每個半形 0.6 個字級。SVG 不會量字，靠它截斷與斷行。 */
export function textWidth(s: string, size: number, mono = false): number {
  let w = 0
  for (const ch of s) w += wide(ch) ? size : mono ? size * 0.6 : /[A-Z0-9@%]/.test(ch) ? size * 0.62 : size * 0.54
  return w
}

/** 超過寬度截斷加「…」；路徑用 keepEnd（從前面截，保留結尾——最後一層最有用）。 */
export function fit(s: string, size: number, max: number, mono = false, keepEnd = false): string {
  if (textWidth(s, size, mono) <= max) return s
  let out = ''
  if (keepEnd) {
    for (const ch of [...s].reverse()) {
      if (textWidth(`…${ch}${out}`, size, mono) > max) break
      out = ch + out
    }
    return `…${out}`
  }
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size, mono) > max) break
    out += ch
  }
  return `${out}…`
}

/** 斷行：中文逐字、英文不切開單字、標點不放行首；超過 maxLines 的最後一行截斷。 */
export function wrap(s: string, size: number, max: number, maxLines = 3): string[] {
  const tokens = s.match(/[A-Za-z0-9._\-/\\:@]+|\s+|./gu) ?? []
  const closing = /^[，。、；：！？」』）】〉》,.;:!?)]/
  const lines: string[] = []
  let cur = ''
  for (const tok of tokens) {
    if (textWidth(cur + tok, size) > max && cur.trim() && !closing.test(tok)) {
      lines.push(cur.trimEnd())
      cur = tok.trimStart()
    } else {
      cur += tok
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd())
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = fit(`${kept[maxLines - 1]}${lines.slice(maxLines).join('')}`, size, max)
    return kept
  }
  return lines
}

export function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${style()}${body}</svg>`
}

export function txt(x: number, y: number, cls: string, size: number, s: string, extra = ''): string {
  return `<text x="${x}" y="${y}" class="${cls}" font-size="${size}" ${extra}>${esc(s)}</text>`
}

/** 膠囊標籤：tone 是強調色或狀態的名字（'none'＝中性）；anchor 決定 x 是左緣、中線或右緣。回寬度。 */
export function pill(x: number, cy: number, tone: string, s: string, anchor: 'start' | 'middle' | 'end' = 'start'): { svg: string; w: number } {
  const w = Math.ceil(textWidth(s, 11)) + 16
  const left = anchor === 'end' ? x - w : anchor === 'middle' ? x - w / 2 : x
  const bg = tone === 'none' ? 'panel' : `${tone}K`
  const fg = tone === 'none' ? 't2' : `${tone}T`
  return { svg: `<rect x="${left}" y="${cy - 9.5}" width="${w}" height="19" rx="9.5" class="${bg}"/>` + txt(left + 8, cy + 4, fg, 11, s, 'font-weight="600"'), w }
}

/** 40×40 圓角淡底＋圖示＋右下角狀態點；animated 時狀態點呼吸（要配 Svg 的 isInteractive）。 */
export function tile(x: number, y: number, bg: string, icon: string, dot: string | null, animated = false): string {
  const pulse = animated ? `<animate attributeName="opacity" values="1;.25;1" dur="1.4s" repeatCount="indefinite"/>` : ''
  const d = dot ? `<circle cx="${x + 36}" cy="${y + 36}" r="5.5" class="${dot}">${pulse}</circle>` : ''
  return `<rect x="${x}" y="${y}" width="40" height="40" rx="10" class="${bg}"/>${icon}${d}`
}

// ---------------------------------------------------------------------------
// easel 的卡片
// ---------------------------------------------------------------------------

const easelIcon = (x: number, y: number, cls: string) =>
  `<path d="M${x + 10} ${y}v3M${x + 2} ${y + 20}l5-17h6l5 17M${x + 4.5} ${y + 13}h11" fill="none" class="${cls}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><rect x="${x + 3}" y="${y + 3}" width="14" height="10" rx="1" fill="none" class="${cls}" stroke-width="1.7"/>`

/** 圓角圖片。data 是 WebP 的 base64；透明圖底下鋪棋盤格，才看得出透明。 */
function picture(x: number, y: number, w: number, h: number, data: string | null, r: number, alpha: boolean): string {
  // 由位置決定，不用遞增的流水號：面板每次捲動都會重畫，字串一變圖就重新載入、高度塌掉，捲動位置會被打回去
  const id = `c${Math.round(x)}-${Math.round(y)}`
  if (!data) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" class="panel"/>` + (w > 120 ? txt(x + w / 2, y + h / 2, 't3', 12, '縮圖做不出來，請確認有裝 ffmpeg', 'text-anchor="middle"') : '')
  }
  const back = alpha
    ? `<pattern id="${id}p" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#ffffff"/><rect width="8" height="8" fill="#cfcfca"/><rect x="8" y="8" width="8" height="8" fill="#cfcfca"/></pattern><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#${id}p)" clip-path="url(#${id})"/>`
    : ''
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}"/></clipPath>${back}<image href="data:image/webp;base64,${data}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid ${alpha ? 'meet' : 'slice'}" clip-path="url(#${id})"/>`
}

export type HeroData = { percent: number; pace: number; remaining: number | null; today: number; tone: 'none' | 'warn' | 'crit'; reset: string; plan: string } | null

/** 頁首：標誌、方案，以及額度量表。細線刻度是時間過了多少，量表超過它就是用得比時間快。 */
export function hero(d: HeroData, w = 420): Drawing {
  const top = tile(0, 2, 'aK', easelIcon(10, 12, 'aS'), null) + txt(52, 19, 't1', 16, 'easel', 'font-weight="800"') + txt(52, 37, 't3', 12, '用 Codex 畫圖，在這裡審稿')
  if (!d) {
    return { source: svg(w, 50, top), alt: 'easel，額度查詢中', height: 50 }
  }
  const color = d.tone === 'crit' ? 'crit' : d.tone === 'warn' ? 'warn' : 'a'
  const badge = pill(w, 22, 'none', d.plan, 'end')
  const fill = Math.max(d.percent > 0 ? 4 : 0, Math.round((Math.min(100, d.percent) / 100) * w))
  const est = d.remaining === null ? '生幾張後會估算還能生多少' : `粗估還能生 ${d.remaining} 張`
  const body =
    top +
    badge.svg +
    txt(0, 66, 't2', 12, `額度已用 ${d.percent}%`) +
    txt(w, 66, 't2', 12, `${d.reset} 重置`, 'text-anchor="end"') +
    `<rect x="0" y="73" width="${w}" height="8" rx="4" class="panel"/>` +
    (fill > 0 ? `<rect x="0" y="73" width="${fill}" height="8" rx="4" class="${color}"/>` : '') +
    `<rect x="${Math.round((d.pace / 100) * (w - 2))}" y="70" width="2" height="14" class="tick"/>` +
    txt(0, 101, 't2', 12, est) +
    txt(w, 101, d.tone === 'warn' && d.percent > d.pace ? 'warnT' : 't2', 12, d.tone === 'warn' && d.percent > d.pace ? '用得比時間快' : `今天 ${d.today} 張`, 'text-anchor="end"')
  return {
    source: svg(w, 108, body),
    alt: `easel，${d.plan}。額度已用 ${d.percent}%，${d.reset} 重置。${est}，今天 ${d.today} 張。`,
    height: 108,
  }
}

export type CardData = { name: string; sub: string; note?: string; noteTone?: string; badge: { tone: string; text: string }; thumb: string | null; alpha: boolean }

/** 等你審的素材：72 的縮圖＋名稱＋說明＋自檢一句。 */
export function assetCard(d: CardData, w = 396): Drawing {
  const h = 72
  const badge = pill(w, 14, d.badge.tone, d.badge.text, 'end')
  const room = w - 84
  let body = picture(0, 0, 72, 72, d.thumb, 8, d.alpha)
  body += txt(84, 22, 't1', 14, fit(d.name, 14, room - badge.w - 8), 'font-weight="600"')
  body += txt(84, 42, 't3', 12, fit(d.sub, 12, room))
  if (d.note) body += txt(84, 61, `${d.noteTone ?? 'ok'}T`, 12, fit(d.note, 12, room))
  body += badge.svg
  return { source: svg(w, h, body), alt: `${d.name}（${d.badge.text}）。${d.sub}。${d.note ?? ''}`, height: h }
}

/** 素材清單的一列：44 的縮圖＋名稱＋說明＋狀態。右邊留給 Button，所以寬度比卡片窄。 */
export function assetRow(d: CardData, w = 320): Drawing {
  const h = 46
  const badge = pill(w, 23, d.badge.tone, d.badge.text, 'end')
  const room = w - 56 - badge.w - 8
  const body = picture(0, 1, 44, 44, d.thumb, 6, d.alpha) + txt(56, 19, 't1', 14, fit(d.name, 14, room), 'font-weight="600"') + txt(56, 37, 't3', 12, fit(d.sub, 12, room)) + badge.svg
  return { source: svg(w, h, body), alt: `${d.name}（${d.badge.text}）。${d.sub}`, height: h }
}

export const STEPS = ['送出', '生成中', '存檔', '自檢'] as const

/** 正在畫：呼吸點＋秒數＋四步進度。秒數靠重畫，不是動畫。 */
export function jobCard(d: { title: string; sub: string; step: number }, w = 396): Drawing {
  const h = 82
  const dot = `<circle cx="6" cy="14" r="5.5" class="a"><animate attributeName="opacity" values="1;.25;1" dur="1.4s" repeatCount="indefinite"/></circle>`
  let body = dot + txt(20, 12, 't1', 14, fit(d.title, 14, w - 20), 'font-weight="600"') + txt(20, 30, 't3', 12, fit(d.sub, 12, w - 20))
  const gap = 4
  const cell = (w - gap * 3) / 4
  STEPS.forEach((label, i) => {
    const x = i * (cell + gap)
    const cls = i < d.step ? 'ok' : i === d.step ? 'a' : 'panel'
    const text = i < d.step ? 'okT' : i === d.step ? 'aT' : 't3'
    body += `<rect x="${x}" y="48" width="${cell}" height="5" rx="2.5" class="${cls}"/>` + txt(x, 72, text, 12, label, i === d.step ? 'font-weight="700"' : '')
  })
  return { source: svg(w, h, body), alt: `${d.title}，${d.sub}。目前在「${STEPS[d.step]}」。`, height: h, animated: true }
}

/** 審稿的大圖。圖的比例照實際尺寸。 */
export function bigPicture(d: { data: string | null; width: number; height: number; alpha: boolean; alt: string }, w = 420): Drawing {
  const h = Math.round(w * (d.height / Math.max(1, d.width)))
  return { source: svg(w, h, picture(0, 0, w, h, d.data, 10, d.alpha)), alt: d.alt, height: h }
}

/** 版本小圖：選中的外框強調，已核准的右下角打勾。圖本身不能按，切換靠下面的 Button。 */
export function versionThumb(d: { n: number; data: string | null; selected: boolean; approved: boolean; alpha: boolean }): Drawing {
  const size = 64
  let body = picture(2, 2, size, size, d.data, 7, d.alpha)
  if (d.selected) body += `<rect x="1" y="1" width="${size + 2}" height="${size + 2}" rx="8" fill="none" class="aS" stroke-width="2"/>`
  if (d.approved) body += `<circle cx="${size - 6}" cy="${size - 6}" r="7" class="ok"/><path d="M${size - 9.5} ${size - 6}l2.5 2.5 4.5-5" fill="none" class="onS" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  return { source: svg(size + 4, size + 4, body), alt: `v${d.n}${d.selected ? '（目前這版）' : ''}${d.approved ? '，已核准' : ''}`, height: size + 4 }
}


/** 「這一版」：要求、底圖、規格＋自檢結論。要求可能很長，高度跟著行數走。 */
export function versionInfo(d: { prompt: string; base: string; spec: string; check: { tone: string; text: string } | null }, w = 396): Drawing {
  const lines = wrap(d.prompt, 12.5, w - 44, 4)
  const lh = 19
  let y = 13
  let body = txt(0, y, 't3', 12.5, '要求')
  lines.forEach((line, i) => {
    body += txt(44, y + i * lh, 't1', 12.5, line)
  })
  y += lines.length * lh
  body += txt(0, y, 't3', 12.5, '底圖') + txt(44, y, 't1', 12.5, d.base)
  y += lh
  body += txt(0, y, 't3', 12.5, '規格') + txt(44, y, 't1', 12.5, d.spec)
  if (d.check) {
    y += lh + 3
    const checkLines = wrap(d.check.text, 12.5, w, 2)
    checkLines.forEach((line, i) => {
      body += txt(0, y + i * lh, `${d.check?.tone}T`, 12.5, line)
    })
    y += (checkLines.length - 1) * lh
  }
  const h = y + 7
  return { source: svg(w, h, body), alt: `要求：${d.prompt}。底圖 ${d.base}。${d.spec}。${d.check?.text ?? ''}`, height: h }
}

/** 兩版並排。 */
export function compare(d: { left: { label: string; badge: string; data: string | null }; right: { label: string; badge: string; data: string | null }; ratio: number; alpha: boolean }, w = 420): Drawing {
  const gap = 8
  const cell = (w - gap) / 2
  const h = Math.round(cell * d.ratio)
  const side = (x: number, s: { label: string; badge: string; data: string | null }) =>
    picture(x, 0, cell, h, s.data, 8, d.alpha) + txt(x, h + 18, 't1', 12.5, s.label, 'font-weight="700"') + pill(x + cell, h + 13, 'none', s.badge, 'end').svg
  return { source: svg(w, h + 26, side(0, d.left) + side(cell + gap, d.right)), alt: `${d.left.label} 與 ${d.right.label} 並排比較。`, height: h + 26 }
}

/** 登入代碼，放大到手機上也好輸入。 */
export function loginCode(code: string, w = 396): Drawing {
  const body = `<rect x="0" y="0" width="${w}" height="64" rx="8" class="panel"/>` + txt(w / 2, 43, 't1 m', 30, code, 'text-anchor="middle" font-weight="600" letter-spacing="2"')
  return { source: svg(w, 64, body), alt: `登入代碼 ${code}`, height: 64 }
}

/** 提醒與錯誤：符號＋粗體標題＋說明。 */
export function alertCard(d: { tone: 'warn' | 'crit'; title: string; detail?: string }, w = 396): Drawing {
  const mark = d.tone === 'warn' ? '▲' : '●'
  const lines = d.detail ? wrap(d.detail, 12.5, w, 3) : []
  let body = txt(0, 15, `${d.tone}T`, 13, fit(`${mark} ${d.title}`, 13, w), 'font-weight="700"')
  lines.forEach((line, i) => {
    body += txt(0, 36 + i * 19, 't1', 12.5, line)
  })
  const h = 22 + lines.length * 19 + 2
  return { source: svg(w, h, body), alt: `${d.title}。${d.detail ?? ''}`, height: h }
}

/** 首次設定的一列：項目＋狀態。 */
export function setupRow(d: { label: string; badge: { tone: string; text: string } }, w = 396): Drawing {
  const b = pill(w, 12, d.badge.tone, d.badge.text, 'end')
  return { source: svg(w, 24, txt(0, 16, 't1', 12.5, d.label) + b.svg), alt: `${d.label}：${d.badge.text}`, height: 24 }
}
