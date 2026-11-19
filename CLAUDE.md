# easel

用官方 Codex 生圖的 Claude Code mod。程式都在 `mod/`，repo 根目錄只放市集設定與文件。

## 結構

- `mod/hooks/model.ts`：純函式。提示詞、Codex 指令、事件解析、用量換算都在這，改動要跟著改 `tests/model.test.ts`。
- `mod/hooks/codex.ts`：碰外面世界的部分（跑 codex、收圖、縮圖、讀寫紀錄）。
- `mod/hooks/visual.ts`：畫圖函式，純函式，給資料回 SVG。
- `mod/hooks/register.tsx`：工具、面板、對話框上方的提醒。
- `mod/skills/draw/SKILL.md`：教 Claude 怎麼用這些工具（技能 `easel:draw`）。

## 不能動的規則

每條都是實測踩出來的，改之前先重測：

- **只執行官方 `codex`。** 不讀 `~/.codex/auth.json`，不自己打 API。`$.process` 的 `env` 只能蓋不能移除，所以用 `env -u` 清掉 API key。
- **改圖一律 `-i` 附底圖。** 模型拿對話裡最後看得到的圖當底，不是最新版。
- **`--sandbox`、`-C` 放在 `resume` 前面。** 放後面 Codex 直接報錯。
- **提示詞走 stdin。** `exec` 的 `-i` 會吃掉後面所有引數。
- **成功看 `~/.codex/generated_images/<thread>/` 有沒有多新圖。** `exec --json` 的事件沒有生圖項目。
- **用量查詢要撐住標準輸入。** app-server 一讀到 EOF 就結束，等不到回覆。

## 平台

Linux、WSL、macOS 都要能跑。macOS 的指令是 BSD 版，GNU 才有的寫法在那裡會直接報錯，而且測試用的替身不會報。

- **列檔與讀修改時間只走 `$.fs.list`**（`codex.ts` 的 `listPngs`），不叫 `find`、`stat`、`ls`。原本用 `find -printf`，macOS 不認得，真的畫出來的圖會被報成「沒有新圖」。
- **因平台而異的事放 `model.ts` 的 `PLATFORMS` 表**，一個平台一列，不在別處寫 `if`。目前有三件：用預設程式開檔、找不到 Codex 時教哪種裝法（macOS 不教 `curl | sh`）、怎麼做縮圖。
- **macOS 的縮圖用內建的 `sips` 轉 JPEG，不依賴 ffmpeg。** `sips` 寫不出 WebP（27.2 實測只能讀）。副檔名、data URI 的類型、轉檔指令都在同一筆 `Thumbnailer`，要改就一起改；`visual.ts` 拿到的是完整的 data URI，不自己假設格式。JPEG 沒有透明，透明處是白底。
- **其餘 shell 指令只用 GNU 與 BSD 都有的寫法**：`base64 | tr -d '\n'`（不用 `-w0`）、`head -c`、`env -u`、`find -maxdepth -mmin`。加新指令前先在 macOS 的 `/usr/bin` 版本試過。
- **`timeout` 是例外**：macOS 27.2 實測有內建，沒有這個指令的舊版 macOS 不支援，README 有寫。

## 啟動

啟動時要做的事（註冊工具、註冊指令、找位置、讀狀態、輪詢）都列在 `register.tsx` 的 `STARTUP` 清單，一項一筆。

- **各項互不牽連，失敗要看得到。** 一項失敗只回報那一項：寫一行到對話（`$.ui.log`），並記進 `startup` 狀態，顯示在對話框上方、面板首頁與 `status` 工具。不要回 `session.start` 手寫一串 `await`，也不要用 `.catch(() => undefined)` 吞掉。
- **工具排在最前面。** 指令、面板、輪詢出問題時，Claude 仍然能畫。
- **技能不能叫 `easel`（和 plugin 同名）。** 同名的技能會佔走 `/easel`，引擎就拒絕註冊面板指令（`"/easel" refused: it is the plugin's /easel:easel`）。0.1.1 因此整個啟動被跳過，工具全部不見。

## 引擎的限制

- `$` 只能傳給**檔案頂層**的函式或自己模組匯入的函式，所以輔助函式都放模組層，不放在 `register` 裡。匯入的要寫成 `function` 宣告，不能是箭頭函式；也不能交給存在清單或物件裡的函式（`step.run($)` 會讓模組載不起來），所以 `STARTUP` 只放資料，由 `runStep` 照 `kind` 呼叫。
- 桌面和手機沒有 `Image`，圖只能嵌進 `Svg`，上限 131072 字元，所以先做縮圖（Linux 與 WSL 轉 WebP，macOS 轉 JPEG），太大再縮一級。
- 手機沒有 `Input`、`Client`。
- `claude plugin test` 裡 `process.spawn` 的替身要用 `async function*`，而且回傳 `{ value: { code, signal } }`。
- 測試的替身站在引擎的位置，引擎自己會拒絕的事（指令撞名、政策擋工具）在測試裡不會發生，要讓替身回 `{ deny }` 才測得到。真引擎的行為用 `claude -p --plugin-dir mod --debug-file <檔>` 看 log。
- **四個工具都在 `tool.run` 服務，不在 `tool.call`。** `tool.call` 在權限檢查之前，`tool.run` 在權限檢查通過、真的要執行的那一刻。2.1.326 起內建的安全外掛 sec-default 會擋「權限檢查之前」由外掛啟動的外部程式：在 `tool.call` 裡 spawn codex，每次都得到「Codex 沒畫出來：easel: $.process.spawn: this repeats a Bash call that is not allowed; serve an allowed call at tool.run」，用 `--allowedTools` 事先允許工具也一樣，不是設定能解的。同一條指令在同一場對話被擋過之後，再送一次（即使改在 `tool.run`）也會被擋，所以實測要開新對話。
  - `tool.run` 回的 `{ deny }` 是這次呼叫的錯誤，和工具自己出錯一樣：模型照樣讀得到原因，但測試裡的 `$.tool.call` 拿到的是 `{ isError: true, text }`，不是 `{ deny }`（測試用 `refused()` 讀）。
  - 權限檢查不允許時 `tool.run` 不會觸發，codex 不會被啟動。測試的替身照 sec-default 只在權限檢查之後放行 spawn，並記下每次呼叫有沒有走過檢查；有工具改回 `tool.call`，測試會紅。
  - 擋直接呼叫 codex 的 Bash 閘門仍在 `tool.call`：它要在權限檢查之前擋，而且不啟動程式。
  - `tool.run` 是 2.1.326 才有的事件（2.1.325 的型別檔還沒有）。更舊的版本不認得它，整個模組載不起來，四個工具全部不見（2.1.322 實測：`"tool.run" is not an event`）。
- **最低引擎版本寫在 `mod/.claude-plugin/plugin.json` 的 `engines["claude-code"]`**（0.1.3 起是 `>=2.1.326`）。不在程式裡看版本號分岔。引擎從 2.1.323 起認得這個欄位：安裝與更新時挑「範圍相符的最新一版」，往回找最多五個 `easel--v<版本>` 標籤。所以**每次升版本號都要打標籤** `easel--v<版本>` 並推上去，舊引擎才找得到能用的那一版（2.1.323 到 2.1.325 會裝到 `easel--v0.1.2`）。2.1.322 以前不認得這個欄位，裝到新版會整個載不起來，只能升級 Claude Code。

## 測試

動過程式碼，commit 前跑：

```bash
cd mod
claude plugin test .
claude plugin validate .
```

`claude` 要是 2.1.326 以上（`claude --version`）。更舊的版本不認得 `tool.run`，`easel.test.tsx` 會整個紅，那不是程式壞了。PATH 上的太舊時，用桌面版內附的那份（環境變數 `$CLAUDE_CODE_EXECPATH`）。

型別檢查要一份放在 repo 外的 tsconfig（內容見引擎型別檔開頭），或在 mod 載入過一次後跑 `npx -y -p typescript@5.6.3 tsc -p mod`。

介面改動照 `mod-polish` 技能的流程：先出設計稿，再寫畫圖函式，截圖自檢深淺兩套。

## 文件

規格與實測數據在 Claude Docs 的〈Claude × Codex 生圖流程：驗證與實作規格〉。設計稿在 https://claude.ai/artifact/HhQFi6DWAHbhLR9Vvj5Hpw 。

commit 訊息用 Conventional Commits，內容用繁體中文。
