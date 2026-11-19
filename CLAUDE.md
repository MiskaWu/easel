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

## 自動修改的上限

「自檢不合格就自動修改，最多幾次」是程式真的會數、會擋的規則，不只是寫在技能裡的一句話。純函式在 `model.ts`（`REVISE_LIMIT`、`resolveLimit`、`autoStreak`），測試在 `model.test.ts` 與 `easel.test.tsx`。

- **上限三層，後者蓋過前者**：程式的預設值 `REVISE_LIMIT.default`（2）→ 人在 `/easel` 面板上調的值 → 使用者在對話裡當次說的（`revise` 的 `limit`）。範圍 0 到 10，超出就夾住，0 是不自動修改。
- **持久的只有面板這一層**，存在 `$.store` 的 `reviseLimit`，跨對話保存；調回預設值就刪掉這個鍵。不要再加外掛設定（userConfig）之類第二個持久的地方：兩邊會打架，看不出現在是誰說了算。`revise` 的判斷、`status`、面板都經過 `readLimit` 讀 `$.store`，按鈕經過 `storeLimit` 寫；面板讀的 `reviseLimit` 狀態只是重畫用的鏡像。
- **工具說明不寫面板上的數字**，只寫預設值與「可以在面板調」。說明一個對話只送一次，中途改了也不會更新；現在的上限看 `status`、`self_check` 與 `revise` 的回覆。
- **底圖只有三種，看 `reviseStep`**：自檢合格或人審過 → 使用者要求的修改，不受上限；自檢不合格且人沒審 → 自動修改，新版記 `auto: true`；還沒自檢、人也沒審 → `revise` 拒絕，請 Claude 先 Read 看圖、用 `self_check` 記錄。第三種原本放行，跳過 `self_check` 就能一直改、繞過上限，所以關掉。
- **「人審過」只有面板寫得到**：核准、退回，或在面板上對那一版提修改（審稿頁的「想改什麼？」、比較頁的「改用這版當底再畫」，由 `askFromPanel` 先記 `askedAt` 再把要求送進對話）。面板和對話走同一個 `revise` 工具，所以不能用工具參數分辨誰發起的（Claude 自己就能帶）；靠的是工具寫不到的這筆紀錄。面板加新的「要求修改」入口，一律經過 `askFromPanel`。
- **次數怎麼數**：連續次數照版本號從最新往回數 `auto` 的版本，數到自檢合格或人審過的版本、或不是自動修改的版本（第一版、使用者要求的修改）為止。照版本號數而不是照底圖的鏈：指定 `base` 回到更早的不合格版本，次數不會歸零。
- **舊的 meta.json 沒有 `auto`**：照它的底圖現在是不是「不合格、沒人審」推回來（`wasAuto`），不改寫舊版本。
- **還沒自檢與到上限都在問 Codex 之前拒絕**：不跑 `codex --version`、不上鎖、不啟動 codex，回的話要有連續幾次、上限幾次、哪一層定的、怎麼繼續（使用者說可以改到幾次再帶 `limit`，或到面板調）。

## 首頁的份量與「收起來」

- **首頁畫多少要有上限，數字在 `model.ts`**：「等你審」只畫最新 `PENDING_CARDS`（5）張帶 160 縮圖的卡，其餘收成一列「另有 N 個較早的待審」，展開後照 `LIST_PAGE`（8）分頁畫成清單列；「素材」清單也分頁。縮圖只替這一次真的畫出來的卡與列做，終端機沒有 Svg，一張都不做。新增會隨素材數長大的區塊，一律分頁或設上限。
- **起因（2026-11-19 實測）**：負責人的專案有 44 個從沒審過的素材，原本首頁替每一個畫一張卡：46 張 Svg、約 45 萬字元（單張最大約 1 萬，沒碰到 131072 的上限），重新載入後第一次打開要跑 88 次外部程式做縮圖（縮圖快取在模組記憶體裡，重新載入就清空）。測試套件畫得出來，引擎也沒有寫整棵樹的大小上限；文件寫明的失敗方式是 `ui.render` 的 `$` 呼叫累計卡住 30 秒就跳過、面板被關掉。
- **「上限」那一列固定排在額度後面**，在啟動訊息、設定、失敗通知與所有清單之前。
- **「收起」（review 的 `shelved`）是第三種處置**：不核准也不退回，只是不列在「等你審」，移到「素材」清單標「收起」，打開後照樣能核准或退回。只對那一版有效：之後有新的一版，新版照常是待審。它**不算人審過**（`humanReviewed` 只認核准、退回與 `askedAt`）：收起是為了清版面，「全部收起來」一次收幾十個，不是對圖的判斷。
- **「全部收起來」先確認**：按下去那一刻算出要收哪幾版（卡片以外的較早待審）記在 `home.confirm`，確認畫面寫出會收幾個；確認時只收那幾版裡「還是最新一版、而且還是待審」的。重新打開 `/easel` 會清掉沒按完的確認。
- **核准、退回、收起來都只在面板的按鈕寫**（`register.tsx` 的 `review`、`shelveMany`），不要加讓模型能代按的工具。
- **`status` 只列待審（新到舊，最多 `STATUS_PENDING_LINES` 個）與正在畫的**，其餘給各狀態的總數。

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
