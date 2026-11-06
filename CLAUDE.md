# easel

用官方 Codex 生圖的 Claude Code mod。程式都在 `mod/`，repo 根目錄只放市集設定與文件。

## 結構

- `mod/hooks/model.ts`：純函式。提示詞、Codex 指令、事件解析、用量換算都在這，改動要跟著改 `tests/model.test.ts`。
- `mod/hooks/codex.ts`：碰外面世界的部分（跑 codex、收圖、縮圖、讀寫紀錄）。
- `mod/hooks/visual.ts`：畫圖函式，純函式，給資料回 SVG。
- `mod/hooks/register.tsx`：工具、面板、對話框上方的提醒。
- `mod/skills/easel/SKILL.md`：教 Claude 怎麼用這些工具。

## 不能動的規則

每條都是實測踩出來的，改之前先重測：

- **只執行官方 `codex`。** 不讀 `~/.codex/auth.json`，不自己打 API。`$.process` 的 `env` 只能蓋不能移除，所以用 `env -u` 清掉 API key。
- **改圖一律 `-i` 附底圖。** 模型拿對話裡最後看得到的圖當底，不是最新版。
- **`--sandbox`、`-C` 放在 `resume` 前面。** 放後面 Codex 直接報錯。
- **提示詞走 stdin。** `exec` 的 `-i` 會吃掉後面所有引數。
- **成功看 `~/.codex/generated_images/<thread>/` 有沒有多新圖。** `exec --json` 的事件沒有生圖項目。
- **用量查詢要撐住標準輸入。** app-server 一讀到 EOF 就結束，等不到回覆。

## 引擎的限制

- `$` 只能傳給**檔案頂層**的函式或自己模組匯入的函式，所以輔助函式都放模組層，不放在 `register` 裡。
- 桌面和手機沒有 `Image`，圖只能嵌進 `Svg`，上限 131072 字元，所以先轉 WebP 縮圖。
- 手機沒有 `Input`、`Client`。
- `claude plugin test` 裡 `process.spawn` 的替身要用 `async function*`，而且回傳 `{ value: { code, signal } }`。

## 測試

動過程式碼，commit 前跑：

```bash
cd mod
claude plugin test .
claude plugin validate .
```

型別檢查要一份放在 repo 外的 tsconfig（內容見引擎型別檔開頭），或在 mod 載入過一次後跑 `npx -y -p typescript@5.6.3 tsc -p mod`。

介面改動照 `mod-polish` 技能的流程：先出設計稿，再寫畫圖函式，截圖自檢深淺兩套。

## 文件

規格與實測數據在 Claude Docs 的〈Claude × Codex 生圖流程：驗證與實作規格〉。設計稿在 https://claude.ai/artifact/HhQFi6DWAHbhLR9Vvj5Hpw 。

commit 訊息用 Conventional Commits，內容用繁體中文。
