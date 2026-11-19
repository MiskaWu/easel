import { expect, test } from 'claude-code/testing'

import { assetCard, bigPicture, compare, jobCard, limitCard, versionThumb } from '../hooks/visual'

// 面板每次捲動都會重畫。圖的字串一變，圖片就重新載入、高度塌掉，捲動位置被打回頂端。
test('同樣的資料畫兩次要一模一樣，連有裁切的圖都是', async () => {
  const card = { name: 'fox', sub: 'v1', badge: { tone: 'warn', text: '待審' }, thumb: 'data:image/webp;base64,QUJD', alpha: true }
  expect(assetCard(card).source).toBe(assetCard(card).source)

  const big = { data: 'data:image/webp;base64,QUJD', width: 10, height: 10, alpha: true, alt: 'x' }
  expect(bigPicture(big).source).toBe(bigPicture(big).source)

  const thumb = { n: 1, data: 'data:image/webp;base64,QUJD', selected: true, approved: true, alpha: true }
  expect(versionThumb(thumb).source).toBe(versionThumb(thumb).source)

  const pair = { left: { label: 'v1', badge: 'a', data: 'data:image/webp;base64,QUJD' }, right: { label: 'v2', badge: 'b', data: 'data:image/webp;base64,QUJD' }, ratio: 1, alpha: true }
  expect(compare(pair).source).toBe(compare(pair).source)
})

test('並排的兩張圖不能共用同一個裁切編號', async () => {
  const pair = { left: { label: 'v1', badge: 'a', data: 'data:image/webp;base64,QUJD' }, right: { label: 'v2', badge: 'b', data: 'data:image/webp;base64,QUJD' }, ratio: 1, alpha: false }
  const ids = [...compare(pair).source.matchAll(/<clipPath id="([^"]+)"/g)].map(m => m[1])
  expect(ids.length).toBe(2)
  expect(new Set(ids).size).toBe(2)
})

test('生成中的卡片要有動畫旗標，其他靜態圖沒有', async () => {
  expect(jobCard({ title: 't', sub: 's', step: 1 }).animated).toBe(true)
  expect(bigPicture({ data: 'data:image/webp;base64,QUJD', width: 1, height: 1, alpha: false, alt: 'x' }).animated).toBeUndefined()
})

test('縮圖的 data URI 原樣放進圖裡：格式因平台而異，畫圖函式不自己假設是哪一種', async () => {
  const jpeg = bigPicture({ data: 'data:image/jpeg;base64,QUJD', width: 10, height: 10, alpha: false, alt: 'x' }).source
  expect(jpeg).toContain('href="data:image/jpeg;base64,QUJD"')
  expect(jpeg).not.toContain('image/webp')
  const webp = bigPicture({ data: 'data:image/webp;base64,QUJD', width: 10, height: 10, alpha: false, alt: 'x' }).source
  expect(webp).toContain('href="data:image/webp;base64,QUJD"')
})

test('自動修改上限：亮幾格就是上限幾次，格數是可調的最大值；說明寫在 alt 裡，讀不到圖的介面也知道', async () => {
  const card = (value: number) => limitCard({ value, max: 10, title: value === 0 ? '不自動修改' : `最多 ${value} 次`, sub: '說明', badge: { tone: 'none', text: '預設' } })
  const lit = (source: string) => [...source.matchAll(/<rect [^>]*height="5"[^>]*class="(a|panel)"/g)].map(m => m[1])
  expect(lit(card(3).source)).toEqual(['a', 'a', 'a', 'panel', 'panel', 'panel', 'panel', 'panel', 'panel', 'panel'])
  expect(lit(card(0).source).every(cls => cls === 'panel')).toBe(true)
  expect(lit(card(10).source).every(cls => cls === 'a')).toBe(true)
  expect(card(3).source).toBe(card(3).source)
  expect(card(3).alt).toBe('自動修改上限：最多 3 次（預設）。說明。可調 0 到 10 次。')
  expect(card(3).animated).toBeUndefined()
})

test('沒有縮圖時圖位上的話由呼叫的人給，畫圖函式不自己提 ffmpeg', async () => {
  const blank = { data: null, width: 10, height: 10, alpha: false, alt: 'x' }
  expect(bigPicture(blank).source).not.toContain('ffmpeg')
  expect(bigPicture({ ...blank, missing: '縮圖做不出來（系統內建的 sips 沒有成功）' }).source).toContain('sips')
})
