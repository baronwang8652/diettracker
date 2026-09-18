# 飲食紀錄

一個記錄每餐熱量與三大營養素的個人網頁 app。純靜態網頁，不需要安裝任何東西，
放上 GitHub Pages 就能用；資料存在你自己的 Supabase 免費資料庫，手機和電腦共用同一份。

---

## 設定步驟

總共四個階段，大約 20–30 分鐘，全程不用寫程式。

### 第一階段：建立免費資料庫（Supabase）

1. 到 [supabase.com](https://supabase.com) 用 GitHub 或 Email 註冊（免費）。
2. 點 **New project**，隨便取個名字（例如 `diet-tracker`），
   設一個資料庫密碼（這個密碼之後用不到，但還是存起來比較保險），
   區域選離你近的（例如 `East US`）。按下建立後等 1–2 分鐘。
3. 專案建好後，左側選單點 **SQL Editor** → **New query**，把下面整段貼進去，按 **Run**：

```sql
-- 存放 app 資料的資料表
create table if not exists public.app_data (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- 每次更新自動記錄時間
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists app_data_touch on public.app_data;
create trigger app_data_touch
  before update on public.app_data
  for each row execute function public.touch_updated_at();

-- 開啟權限控制，並允許持有金鑰的人讀寫
alter table public.app_data enable row level security;

drop policy if exists "app access" on public.app_data;
create policy "app access" on public.app_data
  for all to anon
  using (true) with check (true);
```

看到 `Success. No rows returned` 就對了。

4. 左側選單點 **Project Settings**（齒輪）→ **API**，這頁有兩個東西待會要用：
   - **Project URL**：長得像 `https://abcdefgh.supabase.co`
   - **anon public** 金鑰：一長串以 `eyJ` 開頭的字

先把這兩個複製到記事本備用。

### 第二階段：上架到 GitHub Pages

1. 到 github.com 建立一個新的 repository，取名例如 `diet-tracker`，設為 **Public**。
2. 進到 repo，點 **Add file → Upload files**，把這個資料夾裡的**所有東西**拖進去
   （包含 `vendor` 資料夾），然後 **Commit changes**。
3. 點 **Settings → Pages**，Source 選 **Deploy from a branch**，
   Branch 選 `main`、資料夾選 `/ (root)`，按 **Save**。
4. 等 1–2 分鐘，網址會是 `https://<你的帳號>.github.io/diet-tracker/`。

### 第三階段：連上資料庫

1. 用瀏覽器打開上面那個網址。
2. 第一次開會出現「連接你的資料庫」畫面，把第一階段複製的 **Project URL** 和
   **anon public 金鑰** 貼進去，按 **連線**。
3. 進到 app 就代表成功了。
4. **手機也要做一次同樣的動作**（金鑰是存在各自的瀏覽器裡，不會跟著網址走）。

### 第四階段：把舊資料搬過來（如果有的話）

1. 打開舊版（Claude artifact）的 app，右上角點 **匯出**，按「複製全部」。
2. 打開新版網頁，右上角點 **設定** → 找到「匯入資料」，把剛剛複製的內容貼進去，按 **匯入**。
3. 匯入是**合併**，不會蓋掉你已經輸入的東西。

---

## 加到手機桌面

用手機瀏覽器開啟網址 → 選單選「加到主畫面」，桌面就會出現圖示，
點開是全螢幕，用起來跟一般 app 一樣。

---

## 幾件要知道的事

**金鑰不在這個 repo 裡。** 金鑰是你在 app 裡輸入、存在該裝置瀏覽器的，
所以就算 repo 是公開的，別人也拿不到你的資料庫。
但反過來說，**拿到你金鑰的人就能讀寫你的飲食資料**——不要把金鑰貼到公開的地方。
萬一外流了，到 Supabase 的 Project Settings → API 重新產生金鑰即可。

**資料庫閒置太久會暫停。** Supabase 免費方案在連續 7 天幾乎沒有存取時會暫停專案，
暫停前會寄信通知。只要你有在用就不會發生；真的被暫停了，到 Supabase 後台按還原就好，
一年內資料都還在，不會遺失。

**沒網路時也能用。** 每筆資料除了寫進雲端，也會在這台裝置留一份，
所以斷網時 app 照樣打得開、看得到自己的紀錄；只是這段期間的變更不會同步到其他裝置。
連不上雲端時，畫面上方會出現橘色提醒。

**記得偶爾備份。** 設定頁有「匯出備份檔」，會下載一份 JSON。
換裝置或想保險時，用「匯入資料」還原即可。

---

## 檔案結構

```
index.html      網頁本體
app.js          app 程式（由 app.jsx 編譯而來）
vendor/         React 與 Supabase 函式庫（已內含，不需連外部 CDN）
manifest.json   加到主畫面用的設定
icon-*.png      桌面圖示
```
