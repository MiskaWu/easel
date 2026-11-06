# easel

用官方 Codex 生圖，在 Claude Code 裡看圖、審稿與看額度。圖走你的 ChatGPT 訂閱額度，不需要 API key。

你在對話裡說「幫我畫一隻狐狸法師」，Claude 畫好後先自己看圖檢查，再交給你在面板上核准或要求修改。每個素材有自己的版本紀錄，改圖時接回同一段 Codex 對話，主體和構圖不會跑掉。

## 需要什麼

- [Claude Code](https://claude.com/claude-code)
- 官方 [Codex CLI](https://github.com/openai/codex)，用 ChatGPT 帳號登入
- `ffmpeg`，用來產生面板的縮圖

## 安裝

在 Claude Code 裡：

```text
/plugin marketplace add MiskaWu/easel
/plugin install easel@easel
/reload-plugins
```

打開 `/easel`。還沒登入 Codex 的話，面板會帶你用裝置碼登入，手機也能完成。

## 怎麼用

- **畫新圖：** 直接在對話裡說要畫什麼。遊戲角色、圖示這類要去背的，說要透明背景。
- **審稿：** `/easel` 面板列出等你審的素材，有版本條、兩版比較、核准與退回。
- **修改：** 在面板輸入想改什麼，或在對話裡說。一律以目前版本為底，要回到舊版也可以。
- **額度：** 面板頂端和右下角顯示 Codex 額度。張數是 easel 用本機的圖數估的，官方只給百分比，所以只能當粗估。

素材放在專案的 `art/<素材名>/`：`v1.png`、`v2.png` 與 `meta.json`。第一次畫圖時會放一份 `art/.gitignore`，把暫存與紀錄排除在版控之外。

## 它怎麼運作

easel 只執行官方 `codex`，不讀 `~/.codex/auth.json`，也不自己呼叫 API。執行時會清掉 `OPENAI_API_KEY`、`CODEX_API_KEY`，避免悄悄改走 API 計費。

有幾條規則來自實測，寫進了程式：

- **改圖一律附上底圖。** 模型拿對話裡最後看得到的圖當底，不一定是最新版。不附的話，背景曾從黃昏退回白天。
- **看生圖資料夾判定成功。** Codex 的事件紀錄沒有生圖項目，所以看 `~/.codex/generated_images/<對話編號>/` 有沒有多一張新圖；沒有就不算數。
- **透明要明講參數。** 提示詞沒寫 `transparent_background` 時，模型曾連續生出不透明的圖，白花額度。
- **尺寸和畫質只能寫在提示詞。** 內建工具沒有這兩個參數。

## 限制

- 只能在 Claude Code 裡用，排程或純終端機叫不動。
- 手機面板沒有輸入框，想修改請在對話裡說。
- 官方的 `openai/codex-plugin-cc` 是程式碼審查與代辦用，跟 easel 可以並存。

## 開發

```bash
cd mod
claude plugin test .
claude plugin validate .
```

開發慣例見 [CLAUDE.md](CLAUDE.md)。

## 授權

MIT
