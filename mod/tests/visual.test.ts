import { expect, test } from 'claude-code/testing'

import { assetCard, bigPicture, compare, jobCard, versionThumb } from '../hooks/visual'

// 面板每次捲動都會重畫。圖的字串一變，圖片就重新載入、高度塌掉，捲動位置被打回頂端。
test('同樣的資料畫兩次要一模一樣，連有裁切的圖都是', async () => {
  const card = { name: 'fox', sub: 'v1', badge: { tone: 'warn', text: '待審' }, thumb: 'QUJD', alpha: true }
  expect(assetCard(card).source).toBe(assetCard(card).source)

  const big = { data: 'QUJD', width: 10, height: 10, alpha: true, alt: 'x' }
  expect(bigPicture(big).source).toBe(bigPicture(big).source)

  const thumb = { n: 1, data: 'QUJD', selected: true, approved: true, alpha: true }
  expect(versionThumb(thumb).source).toBe(versionThumb(thumb).source)

  const pair = { left: { label: 'v1', badge: 'a', data: 'QUJD' }, right: { label: 'v2', badge: 'b', data: 'QUJD' }, ratio: 1, alpha: true }
  expect(compare(pair).source).toBe(compare(pair).source)
})

test('並排的兩張圖不能共用同一個裁切編號', async () => {
  const pair = { left: { label: 'v1', badge: 'a', data: 'QUJD' }, right: { label: 'v2', badge: 'b', data: 'QUJD' }, ratio: 1, alpha: false }
  const ids = [...compare(pair).source.matchAll(/<clipPath id="([^"]+)"/g)].map(m => m[1])
  expect(ids.length).toBe(2)
  expect(new Set(ids).size).toBe(2)
})

test('生成中的卡片要有動畫旗標，其他靜態圖沒有', async () => {
  expect(jobCard({ title: 't', sub: 's', step: 1 }).animated).toBe(true)
  expect(bigPicture({ data: 'QUJD', width: 1, height: 1, alpha: false, alt: 'x' }).animated).toBeUndefined()
})
