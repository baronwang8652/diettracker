const { useState, useEffect, useCallback, useMemo } = React;

// ---------- cloud config ----------
// The Supabase URL + anon key are entered by you in the app and kept in THIS
// browser's localStorage. They are deliberately not baked into the published
// files, so the public GitHub repo never contains your keys.
const CFG_KEY = "diet-tracker-supabase-config";

function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function saveConfig(cfg) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch (e) {}
}
function clearConfig() {
  try {
    localStorage.removeItem(CFG_KEY);
  } catch (e) {}
}

let _client = null;
function getClient() {
  if (_client) return _client;
  const cfg = loadConfig();
  if (!cfg || !cfg.url || !cfg.key || !window.supabase) return null;
  try {
    _client = window.supabase.createClient(cfg.url, cfg.key);
  } catch (e) {
    return null;
  }
  return _client;
}
function resetClient() {
  _client = null;
}


// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => {
  const nd = new Date(d);
  nd.setDate(nd.getDate() + n);
  return nd;
};
const isToday = (d) => toKey(d) === toKey(new Date());
const weekdayZh = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const fmtLabel = (d) => {
  if (isToday(d)) return "今天";
  const y = addDays(new Date(), -1);
  if (toKey(d) === toKey(y)) return "昨天";
  return `${d.getMonth() + 1}/${d.getDate()} ${weekdayZh[d.getDay()]}`;
};
const uid = () => Math.random().toString(36).slice(2, 10);

const MEALS = [
  { key: "breakfast", label: "早餐" },
  { key: "lunch", label: "午餐" },
  { key: "dinner", label: "晚餐" },
  { key: "snack", label: "零食" },
];

const DEFAULT_GOALS = { calories: 2000, protein: 100, carbs: 250, fat: 65 };

// ---------- storage wrapper ----------
// Every value is written to Supabase (so other devices see it) AND mirrored into
// localStorage. The mirror is what makes the app usable when the network is down or
// the keys are missing: reads fall back to it, so you still see your own data on
// this device instead of an empty app.
const TABLE = "app_data";

// Cloud calls get a hard deadline plus a short cooldown after a failure. Without
// this, an unreachable cloud (offline, wrong keys) makes every single read sit
// through a network timeout, so the app crawls instead of just reading the local
// mirror and moving on.
const NET_TIMEOUT_MS = 6000;
const COOLDOWN_MS = 15000;
let cloudDownUntil = 0;

const cloudAvailable = () => Date.now() >= cloudDownUntil;
const markCloudDown = () => {
  cloudDownUntil = Date.now() + COOLDOWN_MS;
};
const markCloudUp = () => {
  cloudDownUntil = 0;
};
function withTimeout(p) {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NET_TIMEOUT_MS)),
  ]);
}

function lsGet(key) {
  try {
    const raw = localStorage.getItem("dt:" + key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem("dt:" + key, JSON.stringify(value));
  } catch (e) {}
}

async function storeGet(key) {
  const client = getClient();
  if (client && cloudAvailable()) {
    try {
      const { data, error } = await withTimeout(
        client.from(TABLE).select("value").eq("key", key).maybeSingle()
      );
      if (!error) {
        markCloudUp();
        const v = data ? data.value : null;
        if (v !== null && v !== undefined) lsSet(key, v);
        return v === undefined ? null : v;
      }
      markCloudDown();
    } catch (e) {
      markCloudDown();
    }
  }
  return lsGet(key);
}

async function storeSet(key, value) {
  lsSet(key, value);
  const client = getClient();
  if (!client || !cloudAvailable()) return false;
  try {
    const { error } = await withTimeout(
      client.from(TABLE).upsert({ key, value }, { onConflict: "key" })
    );
    if (error) {
      markCloudDown();
      return false;
    }
    markCloudUp();
    return true;
  } catch (e) {
    markCloudDown();
    return false;
  }
}

// ---------- backup / migration ----------
async function exportAll() {
  const [goals, foods, combos, index] = await Promise.all([
    storeGet("goals"),
    storeGet("saved-foods"),
    storeGet("combos"),
    storeGet("log-index"),
  ]);
  const logs = {};
  for (const k of index || []) {
    const d = await storeGet("log:" + k);
    if (d) logs[k] = d;
  }
  return {
    format: "diet-tracker-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    goals: goals || null,
    savedFoods: foods || [],
    combos: combos || [],
    logs,
  };
}

// Merges an export into whatever is already here rather than replacing it, so
// importing can never wipe data you have already entered on this side. Imported
// values win on a genuine conflict; log entries are deduped by their id.
async function importAll(payload) {
  if (!payload || typeof payload !== "object" || !payload.logs) {
    throw new Error("這不是有效的備份資料");
  }
  const cur = await exportAll();

  const foodMap = new Map();
  (cur.savedFoods || []).forEach((f) => foodMap.set(f.name, f));
  (payload.savedFoods || []).forEach((f) => foodMap.set(f.name, f));

  const comboMap = new Map();
  (cur.combos || []).forEach((c) => comboMap.set(c.id, c));
  (payload.combos || []).forEach((c) => comboMap.set(c.id, c));

  const logs = { ...(cur.logs || {}) };
  Object.entries(payload.logs || {}).forEach(([day, dayLog]) => {
    const merged = { ...(logs[day] || {}) };
    Object.entries(dayLog || {}).forEach(([meal, entries]) => {
      const seen = new Map();
      (merged[meal] || []).forEach((e) => seen.set(e.id, e));
      (entries || []).forEach((e) => seen.set(e.id, e));
      merged[meal] = Array.from(seen.values());
    });
    logs[day] = merged;
  });

  await storeSet("goals", payload.goals || cur.goals || DEFAULT_GOALS);
  await storeSet("saved-foods", Array.from(foodMap.values()));
  await storeSet("combos", Array.from(comboMap.values()));
  const days = Object.keys(logs);
  for (const k of days) await storeSet("log:" + k, logs[k]);
  await storeSet("log-index", days);

  return { foods: foodMap.size, combos: comboMap.size, days: days.length };
}

function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- small SVG ring ----------
function ProgressRing({ pct, size = 168, stroke = 14, color = "#4A7C59", track = "#EFE9DD" }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  const offset = c * (1 - clamped);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: "stroke-dashoffset 0.5s ease" }}
      />
    </svg>
  );
}

function MacroBar({ label, value, goal, color }) {
  const pct = goal > 0 ? Math.min(1, value / goal) : 0;
  return (
    <div className="macroRow">
      <div className="macroTop">
        <span className="macroLabel">{label}</span>
        <span className="macroNums">
          {Math.round(value)} <span className="macroGoal">/ {Math.round(goal)}g</span>
        </span>
      </div>
      <div className="macroTrack">
        <div className="macroFill" style={{ width: `${pct * 100}%`, background: color }} />
      </div>
    </div>
  );
}

// ---------- Add food sheet ----------
const UNIT_DEFAULT_BASE = { g: 100, serving: 1 };
const UNIT_LABEL = { g: "克", serving: "份" };

function scaleFood(f, qty) {
  const base = Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100;
  const factor = base > 0 ? qty / base : 0;
  return {
    calories: Math.round(f.calories * factor),
    protein: Math.round(f.protein * factor * 10) / 10,
    carbs: Math.round(f.carbs * factor * 10) / 10,
    fat: Math.round(f.fat * factor * 10) / 10,
  };
}

// Proportionally rescale an already-logged entry (which stores final nutrition for its
// own quantity) to a new quantity — used for quick in-place quantity edits/imports.
function scaleEntryQty(entry, newQty) {
  const oldQty = Number(entry.quantity) || 1;
  const factor = oldQty > 0 ? newQty / oldQty : 0;
  return {
    calories: Math.round(entry.calories * factor),
    protein: Math.round(entry.protein * factor * 10) / 10,
    carbs: Math.round(entry.carbs * factor * 10) / 10,
    fat: Math.round(entry.fat * factor * 10) / 10,
  };
}

function AddFoodSheet({ mealLabel, savedFoods, combos, onClose, onAdd, onAddMany, onSaveFood }) {
  const [tab, setTab] = useState("saved");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("g");
  const [baseAmount, setBaseAmount] = useState("100");
  const [cal, setCal] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [newQty, setNewQty] = useState("100");
  const [remember, setRemember] = useState(true);
  const [selected, setSelected] = useState(null);
  const [savedQty, setSavedQty] = useState("100");
  const [picked, setPicked] = useState([]); // multi-select: array of food objects
  const [batchStep, setBatchStep] = useState(false);
  const [batchQty, setBatchQty] = useState({}); // name -> qty string

  const filtered = savedFoods.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()));

  const handleUnitChange = (u) => {
    setUnit(u);
    setBaseAmount(String(UNIT_DEFAULT_BASE[u]));
    setNewQty(String(UNIT_DEFAULT_BASE[u]));
  };

  const handleAddNew = () => {
    if (!name.trim() || !cal || !baseAmount) return;
    const base = {
      name: name.trim(),
      unit,
      baseAmount: Number(baseAmount) || UNIT_DEFAULT_BASE[unit],
      calories: Number(cal) || 0,
      protein: Number(protein) || 0,
      carbs: Number(carbs) || 0,
      fat: Number(fat) || 0,
    };
    const qty = Number(newQty) || base.baseAmount;
    const scaled = scaleFood(base, qty);
    onAdd({ name: base.name, ...scaled, quantity: qty, unit });
    if (remember) onSaveFood(base);
    onClose();
  };

  const openSavedQty = (f) => {
    setSelected(f);
    setSavedQty(String(Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100));
  };

  const confirmAddSaved = () => {
    const qty = Number(savedQty) || Number(selected.baseAmount) || UNIT_DEFAULT_BASE[selected.unit] || 100;
    const scaled = scaleFood(selected, qty);
    onAdd({ name: selected.name, ...scaled, quantity: qty, unit: selected.unit });
    onClose();
  };

  const preview = selected ? scaleFood(selected, Number(savedQty) || 0) : null;

  const togglePick = (f) => {
    setPicked((prev) => (prev.some((x) => x.name === f.name) ? prev.filter((x) => x.name !== f.name) : [...prev, f]));
  };

  const goToBatchStep = () => {
    const initQty = {};
    picked.forEach((f) => {
      initQty[f.name] = String(Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100);
    });
    setBatchQty(initQty);
    setBatchStep(true);
  };

  const confirmBatch = () => {
    const items = picked.map((f) => {
      const qty = Number(batchQty[f.name]) || Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100;
      const scaled = scaleFood(f, qty);
      return { name: f.name, ...scaled, quantity: qty, unit: f.unit };
    });
    onAddMany(items);
    onClose();
  };

  const addCombo = (combo) => {
    onAddMany(combo.items.map((it) => ({ ...it })));
    onClose();
  };

  const headerTitle = selected ? selected.name : batchStep ? `設定份量 (${picked.length})` : `加入${mealLabel}`;
  const handleBack = selected ? () => setSelected(null) : batchStep ? () => setBatchStep(false) : onClose;

  return (
    <div className="sheetOverlay">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <h3>{headerTitle}</h3>
          <button className="iconBtn" onClick={handleBack} aria-label={selected || batchStep ? "返回" : "關閉"}>
            {selected || batchStep ? "‹" : "✕"}
          </button>
        </div>

        {selected ? (
          <div className="newPane">
            <label className="fieldLabel">這次吃了多少{UNIT_LABEL[selected.unit] || "克"}?</label>
            <input
              className="input"
              inputMode="decimal"
              autoFocus
              value={savedQty}
              onChange={(e) => setSavedQty(e.target.value)}
              placeholder={String(Number(selected.baseAmount) || UNIT_DEFAULT_BASE[selected.unit] || 100)}
            />
            <div className="qtyPreview">
              {preview ? (
                <>
                  {preview.calories} kcal · P{preview.protein} C{preview.carbs} F{preview.fat}
                </>
              ) : (
                "輸入份量以預覽營養"
              )}
            </div>
            <button className="primaryBtn" onClick={confirmAddSaved} disabled={!savedQty}>
              加入{mealLabel}
            </button>
          </div>
        ) : batchStep ? (
          <div className="newPane">
            <div className="batchList">
              {picked.map((f) => {
                const qty = Number(batchQty[f.name]) || 0;
                const p = scaleFood(f, qty);
                return (
                  <div className="batchRow" key={f.name}>
                    <div className="batchRowTop">
                      <span className="batchRowName">{f.name}</span>
                      <div className="batchQtyInput">
                        <input
                          className="input batchInput"
                          inputMode="decimal"
                          value={batchQty[f.name] ?? ""}
                          onChange={(e) => setBatchQty((prev) => ({ ...prev, [f.name]: e.target.value }))}
                          placeholder={String(Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100)}
                        />
                        <span className="batchUnit">{UNIT_LABEL[f.unit] || "克"}</span>
                      </div>
                    </div>
                    <div className="qtyPreview" style={{ margin: "2px 0 0" }}>
                      {qty > 0 ? `${p.calories} kcal · P${p.protein} C${p.carbs} F${p.fat}` : "輸入份量以預覽營養"}
                    </div>
                  </div>
                );
              })}
            </div>
            <button className="primaryBtn" onClick={confirmBatch} style={{ marginTop: 14 }}>
              全部加入{mealLabel} ({picked.length})
            </button>
          </div>
        ) : (
          <>
            <div className="segTabs">
              <button className={tab === "saved" ? "segBtn active" : "segBtn"} onClick={() => setTab("saved")}>
                常吃食物
              </button>
              <button className={tab === "combos" ? "segBtn active" : "segBtn"} onClick={() => setTab("combos")}>
                食物搭配
              </button>
              <button className={tab === "new" ? "segBtn active" : "segBtn"} onClick={() => setTab("new")}>
                新增食物
              </button>
            </div>

            {tab === "saved" ? (
              <div className="savedPane">
                <input
                  className="input"
                  placeholder="搜尋食物…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div className="savedList" style={{ paddingBottom: picked.length ? 64 : 0 }}>
                  {filtered.length === 0 && (
                    <div className="emptyHint">
                      {savedFoods.length === 0 ? "還沒有常吃食物，先到「新增食物」建立一個吧" : "找不到符合的食物"}
                    </div>
                  )}
                  {filtered.map((f) => {
                    const isPicked = picked.some((x) => x.name === f.name);
                    return (
                      <div className={isPicked ? "savedItem picked" : "savedItem"} key={f.name}>
                        <label className="pickCheck" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={isPicked} onChange={() => togglePick(f)} />
                        </label>
                        <button className="savedItemBody" onClick={() => openSavedQty(f)}>
                          <div className="savedItemName">{f.name}</div>
                          <div className="savedItemMeta">
                            每{Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100}
                            {UNIT_LABEL[f.unit] || "克"} · {f.calories} kcal · P{f.protein} C{f.carbs} F{f.fat}
                          </div>
                        </button>
                      </div>
                    );
                  })}
                </div>
                {picked.length > 0 && (
                  <div className="pickBar">
                    <span>已選 {picked.length} 項</span>
                    <button className="primaryBtn pickBarBtn" onClick={goToBatchStep}>
                      設定份量並加入
                    </button>
                  </div>
                )}
              </div>
            ) : tab === "combos" ? (
              <div className="savedList">
                {combos.length === 0 && <div className="emptyHint">還沒有食物搭配，到「常吃食物」頁籤建立一組吧</div>}
                {combos.map((c) => {
                  const total = c.items.reduce((s, it) => s + it.calories, 0);
                  return (
                    <button key={c.id} className="savedItem" style={{ width: "100%", textAlign: "left" }} onClick={() => addCombo(c)}>
                      <div>
                        <div className="savedItemName">{c.name}</div>
                        <div className="savedItemMeta">
                          {c.items.map((it) => it.name).join("、")} · 共 {total} kcal
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="newPane">
                <label className="fieldLabel">食物名稱</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：雞胸肉" />

                <label className="fieldLabel">計量單位</label>
                <div className="segTabs" style={{ marginBottom: 12 }}>
                  <button className={unit === "g" ? "segBtn active" : "segBtn"} onClick={() => handleUnitChange("g")}>
                    克
                  </button>
                  <button
                    className={unit === "serving" ? "segBtn active" : "segBtn"}
                    onClick={() => handleUnitChange("serving")}
                  >
                    份
                  </button>
                </div>

                <label className="fieldLabel">營養標示是以多少{UNIT_LABEL[unit]}為基準?(看包裝上寫的量)</label>
                <input
                  className="input"
                  inputMode="decimal"
                  value={baseAmount}
                  onChange={(e) => setBaseAmount(e.target.value)}
                  placeholder={unit === "g" ? "例如 100 或 85" : "例如 1"}
                />

                <label className="fieldLabel">
                  熱量 (每{baseAmount || "?"}
                  {UNIT_LABEL[unit]}, kcal)
                </label>
                <input className="input" inputMode="numeric" value={cal} onChange={(e) => setCal(e.target.value)} placeholder="0" />
                <div className="threeCol">
                  <div>
                    <label className="fieldLabel">蛋白質(g)</label>
                    <input className="input" inputMode="numeric" value={protein} onChange={(e) => setProtein(e.target.value)} placeholder="0" />
                  </div>
                  <div>
                    <label className="fieldLabel">碳水(g)</label>
                    <input className="input" inputMode="numeric" value={carbs} onChange={(e) => setCarbs(e.target.value)} placeholder="0" />
                  </div>
                  <div>
                    <label className="fieldLabel">脂肪(g)</label>
                    <input className="input" inputMode="numeric" value={fat} onChange={(e) => setFat(e.target.value)} placeholder="0" />
                  </div>
                </div>

                <label className="fieldLabel">這次實際吃了多少{UNIT_LABEL[unit]}?</label>
                <input className="input" inputMode="decimal" value={newQty} onChange={(e) => setNewQty(e.target.value)} placeholder={baseAmount || String(UNIT_DEFAULT_BASE[unit])} />

                <label className="checkRow">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  <span>記住這個食物(存每{baseAmount || "?"}{UNIT_LABEL[unit]}的營養),加入常吃清單</span>
                </label>
                <button className="primaryBtn" onClick={handleAddNew} disabled={!name.trim() || !cal}>
                  加入{mealLabel}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Goals editor ----------
function GoalsSheet({ goals, onClose, onSave }) {
  const [cal, setCal] = useState(String(goals.calories ?? ""));
  const [protein, setProtein] = useState(String(goals.protein ?? ""));
  const [carbs, setCarbs] = useState(String(goals.carbs ?? ""));
  const [fat, setFat] = useState(String(goals.fat ?? ""));

  const calNum = Number(cal) || 0;
  const pNum = protein.trim() === "" ? null : Number(protein);
  const cNum = carbs.trim() === "" ? null : Number(carbs);
  const fNum = fat.trim() === "" ? null : Number(fat);
  const emptyFields = [pNum === null && "protein", cNum === null && "carbs", fNum === null && "fat"].filter(Boolean);

  let autoField = null;
  let autoValue = null;
  if (emptyFields.length === 1 && calNum > 0) {
    if (emptyFields[0] === "protein" && cNum != null && fNum != null) {
      autoField = "protein";
      autoValue = Math.max(0, Math.round((calNum - cNum * 4 - fNum * 9) / 4));
    } else if (emptyFields[0] === "carbs" && pNum != null && fNum != null) {
      autoField = "carbs";
      autoValue = Math.max(0, Math.round((calNum - pNum * 4 - fNum * 9) / 4));
    } else if (emptyFields[0] === "fat" && pNum != null && cNum != null) {
      autoField = "fat";
      autoValue = Math.max(0, Math.round((calNum - pNum * 4 - cNum * 4) / 9));
    }
  }

  const displayValue = (field, raw) => (field === autoField ? String(autoValue) : raw);
  const finalValue = (field, raw) => (field === autoField ? autoValue : Number(raw) || 0);

  const allocatedCal = (finalValue("protein", protein) + finalValue("carbs", carbs)) * 4 + finalValue("fat", fat) * 9;
  const overBudget = calNum > 0 && allocatedCal > calNum + 1;

  const save = () => {
    onSave({
      calories: calNum,
      protein: finalValue("protein", protein),
      carbs: finalValue("carbs", carbs),
      fat: finalValue("fat", fat),
    });
    onClose();
  };

  return (
    <div className="sheetOverlay">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <h3>每日目標</h3>
          <button className="iconBtn" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>
        <div className="newPane">
          <label className="fieldLabel">熱量目標 (kcal)</label>
          <input className="input" inputMode="numeric" value={cal} onChange={(e) => setCal(e.target.value)} />
          <div className="fieldLabel" style={{ marginTop: -6 }}>
            填其中兩項營養素，留空第三項會自動用熱量換算(蛋白質/碳水 4 大卡/g，脂肪 9 大卡/g)
          </div>
          <div className="threeCol">
            <div>
              <label className="fieldLabel">
                蛋白質(g) {autoField === "protein" && <span className="autoTag">自動</span>}
              </label>
              <input
                className="input"
                inputMode="numeric"
                value={displayValue("protein", protein)}
                onChange={(e) => setProtein(e.target.value)}
                style={autoField === "protein" ? { color: "var(--green)" } : undefined}
              />
            </div>
            <div>
              <label className="fieldLabel">
                碳水(g) {autoField === "carbs" && <span className="autoTag">自動</span>}
              </label>
              <input
                className="input"
                inputMode="numeric"
                value={displayValue("carbs", carbs)}
                onChange={(e) => setCarbs(e.target.value)}
                style={autoField === "carbs" ? { color: "var(--green)" } : undefined}
              />
            </div>
            <div>
              <label className="fieldLabel">
                脂肪(g) {autoField === "fat" && <span className="autoTag">自動</span>}
              </label>
              <input
                className="input"
                inputMode="numeric"
                value={displayValue("fat", fat)}
                onChange={(e) => setFat(e.target.value)}
                style={autoField === "fat" ? { color: "var(--green)" } : undefined}
              />
            </div>
          </div>
          {overBudget && (
            <div className="qtyPreview" style={{ color: "var(--rose)", margin: "-8px 0 16px" }}>
              三項營養素換算的熱量({Math.round(allocatedCal)} kcal)已超過熱量目標
            </div>
          )}
          <button className="primaryBtn" onClick={save}>
            儲存目標
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Today view ----------
function TodayView({ date, setDate, log, goals, onOpenAdd, onOpenImport, onRemoveEntry, onOpenMove, onOpenEditQty }) {
  const totals = useMemo(() => {
    const all = MEALS.flatMap((m) => log[m.key] || []);
    return all.reduce(
      (acc, e) => ({
        calories: acc.calories + e.calories,
        protein: acc.protein + e.protein,
        carbs: acc.carbs + e.carbs,
        fat: acc.fat + e.fat,
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );
  }, [log]);

  const remaining = goals.calories - totals.calories;
  const pct = goals.calories > 0 ? totals.calories / goals.calories : 0;

  return (
    <div className="screen">
      <div className="dateNav">
        <button className="iconBtn" onClick={() => setDate(addDays(date, -1))} aria-label="前一天">
          ‹
        </button>
        <div className="dateLabel">{fmtLabel(date)}</div>
        <button
          className="iconBtn"
          onClick={() => setDate(addDays(date, 1))}
          disabled={isToday(date)}
          style={{ opacity: isToday(date) ? 0.3 : 1 }}
          aria-label="後一天"
        >
          ›
        </button>
      </div>

      <div className="ringCard">
        <div className="ringWrap">
          <ProgressRing pct={pct} color={remaining < 0 ? "#C1666B" : "#4A7C59"} />
          <div className="ringCenter">
            <div className="ringNum" style={{ color: remaining < 0 ? "#C1666B" : "#2B2B26" }}>
              {Math.abs(Math.round(remaining))}
            </div>
            <div className="ringSub">{remaining < 0 ? "超出 kcal" : "剩餘 kcal"}</div>
          </div>
        </div>
        <div className="macros">
          <MacroBar label="蛋白質" value={totals.protein} goal={goals.protein} color="#4A7C59" />
          <MacroBar label="碳水" value={totals.carbs} goal={goals.carbs} color="#E8A33D" />
          <MacroBar label="脂肪" value={totals.fat} goal={goals.fat} color="#C1666B" />
        </div>
      </div>

      {MEALS.map((meal) => {
        const entries = log[meal.key] || [];
        const mealCal = entries.reduce((s, e) => s + e.calories, 0);
        return (
          <div className="mealCard" key={meal.key}>
            <div className="mealHeader">
              <div className="mealTitle">{meal.label}</div>
              <div className="mealCal">{mealCal > 0 ? `${mealCal} kcal` : ""}</div>
            </div>
            {entries.map((e) => (
              <div className="entryRow" key={e.id}>
                <button className="entryInfoBtn" onClick={() => onOpenEditQty(meal.key, e)}>
                  <div className="entryName">{e.name}</div>
                  {e.quantity != null && (
                    <div className="entryQty">
                      {e.quantity}
                      {UNIT_LABEL[e.unit] || "克"} ✎
                    </div>
                  )}
                </button>
                <div className="entryRight">
                  <span className="entryCal">{e.calories} kcal</span>
                  <button className="moveBtn" onClick={() => onOpenMove(meal.key, e)} aria-label="移動到其他餐">
                    ⇄
                  </button>
                  <button className="removeBtn" onClick={() => onRemoveEntry(meal.key, e.id)} aria-label="刪除">
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <button className="addRowBtn" onClick={() => onOpenAdd(meal.key)}>
              + 新增食物
            </button>
            <button className="importRowBtn" onClick={() => onOpenImport(meal.key)}>
              ↺ 從其他天匯入
            </button>
          </div>
        );
      })}
      <div style={{ height: 24 }} />
    </div>
  );
}

// ---------- History view ----------
function HistoryView({ allLogs, goals }) {
  const days = useMemo(() => {
    const arr = [];
    for (let i = 13; i >= 0; i--) {
      const d = addDays(new Date(), -i);
      const key = toKey(d);
      const entry = allLogs[key];
      const total = entry
        ? MEALS.flatMap((m) => entry[m.key] || []).reduce((s, e) => s + e.calories, 0)
        : 0;
      arr.push({ d, key, total });
    }
    return arr;
  }, [allLogs]);

  const maxVal = Math.max(goals.calories, ...days.map((d) => d.total), 1);

  return (
    <div className="screen">
      <h2 className="sectionTitle">近 14 天熱量趨勢</h2>
      <div className="chartCard">
        <div className="chartBars">
          {days.map((d) => {
            const h = Math.max(2, (d.total / maxVal) * 100);
            const over = d.total > goals.calories;
            return (
              <div className="barCol" key={d.key}>
                <div className="barTrack">
                  <div
                    className="barFill"
                    style={{ height: `${h}%`, background: over ? "#C1666B" : "#4A7C59" }}
                    title={`${d.total} kcal`}
                  />
                </div>
                <div className="barLabel">{d.d.getDate()}</div>
              </div>
            );
          })}
        </div>
        <div className="goalLine">
          <span className="goalDot" /> 目標 {goals.calories} kcal
        </div>
      </div>

      <h2 className="sectionTitle">每日紀錄</h2>
      <div className="historyList">
        {days
          .slice()
          .reverse()
          .filter((d) => d.total > 0)
          .map((d) => (
            <div className="historyRow" key={d.key}>
              <div className="historyDate">{fmtLabel(d.d)}</div>
              <div className={d.total > goals.calories ? "historyCal over" : "historyCal"}>{d.total} kcal</div>
            </div>
          ))}
        {days.every((d) => d.total === 0) && <div className="emptyHint">還沒有紀錄，開始記錄第一餐吧</div>}
      </div>
      <div style={{ height: 24 }} />
    </div>
  );
}

// ---------- Foods view ----------
function FoodsView({ savedFoods, onDeleteFood, onSaveFood, combos, onSaveCombo, onDeleteCombo }) {
  const [subTab, setSubTab] = useState("foods");
  const [query, setQuery] = useState("");
  const [foodSheet, setFoodSheet] = useState(null); // null | "new" | <food object being edited>
  const [comboSheet, setComboSheet] = useState(null); // null | "new" | <combo object being edited>
  const filtered = savedFoods.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="screen">
      <div className="foodsHeaderRow">
        <h2 className="sectionTitle" style={{ margin: 0 }}>
          {subTab === "foods" ? "常吃食物" : "食物搭配"}
        </h2>
        <button className="addChip" onClick={() => (subTab === "foods" ? setFoodSheet("new") : setComboSheet("new"))}>
          + {subTab === "foods" ? "新增食物" : "新增搭配"}
        </button>
      </div>

      <div className="segTabs" style={{ marginBottom: 12 }}>
        <button className={subTab === "foods" ? "segBtn active" : "segBtn"} onClick={() => setSubTab("foods")}>
          常吃食物
        </button>
        <button className={subTab === "combos" ? "segBtn active" : "segBtn"} onClick={() => setSubTab("combos")}>
          食物搭配
        </button>
      </div>

      {subTab === "foods" ? (
        <>
          <input className="input" placeholder="搜尋…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 12 }} />
          <div className="savedList">
            {filtered.length === 0 && <div className="emptyHint">還沒有儲存的食物</div>}
            {filtered.map((f) => (
              <div className="savedItem" key={f.name}>
                <button className="savedItemBody" onClick={() => setFoodSheet(f)}>
                  <div className="savedItemName">{f.name}</div>
                  <div className="savedItemMeta">
                    每{Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100}
                    {UNIT_LABEL[f.unit] || "克"} · {f.calories} kcal · P{f.protein} C{f.carbs} F{f.fat}
                  </div>
                </button>
                <button className="removeBtn" onClick={() => onDeleteFood(f.name)} aria-label="刪除">
                  ✕
                </button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <div className="savedList">
          {combos.length === 0 && <div className="emptyHint">還沒有食物搭配，把常一起吃的食物組成一組吧</div>}
          {combos.map((c) => {
            const total = c.items.reduce((s, it) => s + it.calories, 0);
            return (
              <div className="savedItem" key={c.id} style={{ alignItems: "flex-start" }}>
                <button className="savedItemBody" onClick={() => setComboSheet(c)}>
                  <div className="savedItemName">{c.name}</div>
                  <div className="savedItemMeta">
                    {c.items.map((it) => it.name).join("、")} · 共 {total} kcal
                  </div>
                </button>
                <button className="removeBtn" onClick={() => onDeleteCombo(c.id)} aria-label="刪除">
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ height: 24 }} />

      {foodSheet && (
        <NewFoodSheet
          initial={foodSheet === "new" ? null : foodSheet}
          onClose={() => setFoodSheet(null)}
          onSave={(food) => {
            onSaveFood(food, foodSheet === "new" ? undefined : foodSheet.name);
            setFoodSheet(null);
          }}
        />
      )}
      {comboSheet && (
        <ComboBuilderSheet
          savedFoods={savedFoods}
          initial={comboSheet === "new" ? null : comboSheet}
          onClose={() => setComboSheet(null)}
          onSave={(combo) => {
            onSaveCombo(combo);
            setComboSheet(null);
          }}
        />
      )}
    </div>
  );
}

// ---------- New food sheet (standalone, saves to 常吃食物 list only) ----------
function NewFoodSheet({ initial, onClose, onSave }) {
  const isEdit = !!initial;
  const [name, setName] = useState(initial?.name || "");
  const [unit, setUnit] = useState(initial?.unit || "g");
  const [baseAmount, setBaseAmount] = useState(
    initial ? String(Number(initial.baseAmount) || UNIT_DEFAULT_BASE[initial.unit] || 100) : "100"
  );
  const [cal, setCal] = useState(initial ? String(initial.calories) : "");
  const [protein, setProtein] = useState(initial ? String(initial.protein) : "");
  const [carbs, setCarbs] = useState(initial ? String(initial.carbs) : "");
  const [fat, setFat] = useState(initial ? String(initial.fat) : "");

  const handleUnitChange = (u) => {
    setUnit(u);
    setBaseAmount(String(UNIT_DEFAULT_BASE[u]));
  };

  const save = () => {
    if (!name.trim() || !cal || !baseAmount) return;
    onSave({
      name: name.trim(),
      unit,
      baseAmount: Number(baseAmount) || UNIT_DEFAULT_BASE[unit],
      calories: Number(cal) || 0,
      protein: Number(protein) || 0,
      carbs: Number(carbs) || 0,
      fat: Number(fat) || 0,
    });
  };

  return (
    <div className="sheetOverlay">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <h3>{isEdit ? "編輯食物" : "新增食物"}</h3>
          <button className="iconBtn" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>
        <div className="newPane">
          <label className="fieldLabel">食物名稱</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：雞胸肉" />

          <label className="fieldLabel">計量單位</label>
          <div className="segTabs" style={{ marginBottom: 12 }}>
            <button className={unit === "g" ? "segBtn active" : "segBtn"} onClick={() => handleUnitChange("g")}>
              克
            </button>
            <button className={unit === "serving" ? "segBtn active" : "segBtn"} onClick={() => handleUnitChange("serving")}>
              份
            </button>
          </div>

          <label className="fieldLabel">營養標示是以多少{UNIT_LABEL[unit]}為基準?(看包裝上寫的量)</label>
          <input
            className="input"
            inputMode="decimal"
            value={baseAmount}
            onChange={(e) => setBaseAmount(e.target.value)}
            placeholder={unit === "g" ? "例如 100 或 85" : "例如 1"}
          />

          <label className="fieldLabel">
            熱量 (每{baseAmount || "?"}
            {UNIT_LABEL[unit]}, kcal)
          </label>
          <input className="input" inputMode="numeric" value={cal} onChange={(e) => setCal(e.target.value)} placeholder="0" />
          <div className="threeCol">
            <div>
              <label className="fieldLabel">蛋白質(g)</label>
              <input className="input" inputMode="numeric" value={protein} onChange={(e) => setProtein(e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className="fieldLabel">碳水(g)</label>
              <input className="input" inputMode="numeric" value={carbs} onChange={(e) => setCarbs(e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className="fieldLabel">脂肪(g)</label>
              <input className="input" inputMode="numeric" value={fat} onChange={(e) => setFat(e.target.value)} placeholder="0" />
            </div>
          </div>
          <button className="primaryBtn" onClick={save} disabled={!name.trim() || !cal}>
            {isEdit ? "儲存變更" : "儲存食物"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Combo builder sheet ----------
function ComboBuilderSheet({ savedFoods, initial, onClose, onSave }) {
  const isEdit = !!initial;
  const initialPicked = isEdit
    ? initial.items.map((it) => ({
        name: it.name,
        unit: it.unit,
        baseAmount: it.quantity,
        calories: it.calories,
        protein: it.protein,
        carbs: it.carbs,
        fat: it.fat,
      }))
    : [];
  const initialQtyMap = {};
  if (isEdit) {
    initial.items.forEach((it) => {
      initialQtyMap[it.name] = String(it.quantity);
    });
  }

  const [step, setStep] = useState(isEdit ? "detail" : "pick"); // pick | detail
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(initialPicked);
  const [qtyMap, setQtyMap] = useState(initialQtyMap);
  const [comboName, setComboName] = useState(initial?.name || "");

  const filtered = savedFoods.filter((f) => f.name.toLowerCase().includes(query.toLowerCase()));

  const togglePick = (f) => {
    setPicked((prev) => {
      const exists = prev.some((x) => x.name === f.name);
      if (exists) return prev.filter((x) => x.name !== f.name);
      setQtyMap((qm) => ({ ...qm, [f.name]: String(Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100) }));
      return [...prev, f];
    });
  };

  const removeItem = (name) => {
    setPicked((prev) => prev.filter((x) => x.name !== name));
  };

  const goToDetail = () => {
    setQtyMap((prev) => {
      const next = { ...prev };
      picked.forEach((f) => {
        if (next[f.name] == null) next[f.name] = String(Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100);
      });
      return next;
    });
    setStep("detail");
  };

  const save = () => {
    if (!comboName.trim() || picked.length === 0) return;
    const items = picked.map((f) => {
      const qty = Number(qtyMap[f.name]) || Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100;
      const scaled = scaleFood(f, qty);
      return { name: f.name, unit: f.unit, quantity: qty, ...scaled };
    });
    onSave({ id: isEdit ? initial.id : uid(), name: comboName.trim(), items });
  };

  return (
    <div className="sheetOverlay">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <h3>{step === "pick" ? (isEdit ? "新增食物到搭配" : "選擇食物搭配") : isEdit ? "編輯搭配" : "設定份量與名稱"}</h3>
          <button
            className="iconBtn"
            onClick={(isEdit && step === "pick") || (!isEdit && step === "detail") ? () => setStep(isEdit ? "detail" : "pick") : onClose}
            aria-label={(isEdit && step === "pick") || (!isEdit && step === "detail") ? "返回" : "關閉"}
          >
            {(isEdit && step === "pick") || (!isEdit && step === "detail") ? "‹" : "✕"}
          </button>
        </div>

        {step === "pick" ? (
          <div className="savedPane">
            <input className="input" placeholder="搜尋食物…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <div className="savedList" style={{ paddingBottom: picked.length ? 64 : 0 }}>
              {filtered.length === 0 && <div className="emptyHint">還沒有常吃食物，先去新增幾個吧</div>}
              {filtered.map((f) => {
                const isPicked = picked.some((x) => x.name === f.name);
                return (
                  <div className={isPicked ? "savedItem picked" : "savedItem"} key={f.name}>
                    <label className="pickCheck" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={isPicked} onChange={() => togglePick(f)} />
                    </label>
                    <button className="savedItemBody" onClick={() => togglePick(f)}>
                      <div className="savedItemName">{f.name}</div>
                      <div className="savedItemMeta">
                        每{Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100}
                        {UNIT_LABEL[f.unit] || "克"} · {f.calories} kcal
                      </div>
                    </button>
                  </div>
                );
              })}
            </div>
            {picked.length > 0 && (
              <div className="pickBar">
                <span>已選 {picked.length} 項</span>
                <button className="primaryBtn pickBarBtn" onClick={goToDetail}>
                  下一步
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="newPane">
            <label className="fieldLabel">搭配名稱</label>
            <input
              className="input"
              value={comboName}
              onChange={(e) => setComboName(e.target.value)}
              placeholder="例如：健身餐、早餐組合"
            />
            <div className="batchList">
              {picked.map((f) => {
                const qty = Number(qtyMap[f.name]) || 0;
                const p = scaleFood(f, qty);
                return (
                  <div className="batchRow" key={f.name}>
                    <div className="batchRowTop">
                      <span className="batchRowName">{f.name}</span>
                      <div className="batchQtyInput">
                        <input
                          className="input batchInput"
                          inputMode="decimal"
                          value={qtyMap[f.name] ?? ""}
                          onChange={(e) => setQtyMap((prev) => ({ ...prev, [f.name]: e.target.value }))}
                          placeholder={String(Number(f.baseAmount) || UNIT_DEFAULT_BASE[f.unit] || 100)}
                        />
                        <span className="batchUnit">{UNIT_LABEL[f.unit] || "克"}</span>
                        <button className="removeBtn" onClick={() => removeItem(f.name)} aria-label="移除">
                          ✕
                        </button>
                      </div>
                    </div>
                    <div className="qtyPreview" style={{ margin: "2px 0 0" }}>
                      {qty > 0 ? `${p.calories} kcal · P${p.protein} C${p.carbs} F${p.fat}` : "輸入份量以預覽營養"}
                    </div>
                  </div>
                );
              })}
              {picked.length === 0 && <div className="emptyHint">還沒有食物，點下方新增</div>}
            </div>
            <button className="addRowBtn" onClick={() => setStep("pick")} style={{ marginTop: 10 }}>
              + 新增食物到這個搭配
            </button>
            <button className="primaryBtn" onClick={save} disabled={!comboName.trim() || picked.length === 0} style={{ marginTop: 14 }}>
              {isEdit ? "儲存變更" : "儲存搭配"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Import from past day sheet ----------
function ImportSheet({ mealKey, mealLabel, allLogs, todayKey, onClose, onImport }) {
  const [selectedDay, setSelectedDay] = useState(null); // candidate object
  const [checked, setChecked] = useState({}); // entryId -> bool
  const [qtyMap, setQtyMap] = useState({}); // entryId -> qty string

  const candidates = useMemo(() => {
    const keys = Object.keys(allLogs)
      .filter((k) => k !== todayKey)
      .sort((a, b) => (a < b ? 1 : -1))
      .slice(0, 14);
    return keys
      .map((k) => {
        const entries = (allLogs[k] && allLogs[k][mealKey]) || [];
        if (entries.length === 0) return null;
        const total = entries.reduce((s, e) => s + e.calories, 0);
        const [y, m, d] = k.split("-").map(Number);
        return { key: k, date: new Date(y, m - 1, d), entries, total };
      })
      .filter(Boolean);
  }, [allLogs, todayKey, mealKey]);

  const openDay = (c) => {
    const initChecked = {};
    const initQty = {};
    c.entries.forEach((e) => {
      initChecked[e.id] = true;
      initQty[e.id] = String(e.quantity ?? "");
    });
    setChecked(initChecked);
    setQtyMap(initQty);
    setSelectedDay(c);
  };

  const toggleEntry = (id) => {
    setChecked((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const checkedCount = selectedDay ? selectedDay.entries.filter((e) => checked[e.id]).length : 0;
  const allChecked = selectedDay ? checkedCount === selectedDay.entries.length : false;

  const toggleAll = () => {
    if (!selectedDay) return;
    const next = {};
    selectedDay.entries.forEach((e) => {
      next[e.id] = !allChecked;
    });
    setChecked(next);
  };

  const confirmImport = () => {
    const toImport = selectedDay.entries
      .filter((e) => checked[e.id])
      .map((e) => {
        const qty = Number(qtyMap[e.id]);
        if (!qty || qty <= 0 || e.quantity == null) return e;
        return { ...e, quantity: qty, ...scaleEntryQty(e, qty) };
      });
    if (toImport.length === 0) return;
    onImport(toImport);
    onClose();
  };

  return (
    <div className="sheetOverlay">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <h3>{selectedDay ? `匯入${fmtLabel(selectedDay.date)}的${mealLabel}` : `從其他天匯入${mealLabel}`}</h3>
          <button
            className="iconBtn"
            onClick={selectedDay ? () => setSelectedDay(null) : onClose}
            aria-label={selectedDay ? "返回" : "關閉"}
          >
            {selectedDay ? "‹" : "✕"}
          </button>
        </div>

        {!selectedDay ? (
          <div className="savedList">
            {candidates.length === 0 && <div className="emptyHint">還沒有其他天的{mealLabel}紀錄可以匯入</div>}
            {candidates.map((c) => (
              <button
                key={c.key}
                className="savedItem"
                style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
                onClick={() => openDay(c)}
              >
                <div>
                  <div className="savedItemName">{fmtLabel(c.date)}</div>
                  <div className="savedItemMeta">
                    {c.entries.map((e) => e.name).join("、")} · 共 {c.total} kcal
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="newPane">
            <div className="foodsHeaderRow" style={{ margin: "0 0 10px" }}>
              <span style={{ fontSize: 12, color: "var(--ink-soft)" }}>已選 {checkedCount} / {selectedDay.entries.length} 項</span>
              <button className="addChip" onClick={toggleAll}>
                {allChecked ? "取消全選" : "全選"}
              </button>
            </div>
            <div className="batchList" style={{ marginBottom: 14 }}>
              {selectedDay.entries.map((e) => {
                const isChecked = !!checked[e.id];
                const hasQty = e.quantity != null;
                const qtyVal = qtyMap[e.id] ?? "";
                const preview = hasQty && Number(qtyVal) > 0 ? scaleEntryQty(e, Number(qtyVal)) : null;
                return (
                  <div className={isChecked ? "batchRow picked" : "batchRow"} key={e.id} style={{ opacity: isChecked ? 1 : 0.5 }}>
                    <div className="batchRowTop">
                      <label className="pickCheck" style={{ padding: "0 4px 0 0" }}>
                        <input type="checkbox" checked={isChecked} onChange={() => toggleEntry(e.id)} />
                      </label>
                      <span className="batchRowName">{e.name}</span>
                      {hasQty && (
                        <div className="batchQtyInput">
                          <input
                            className="input batchInput"
                            inputMode="decimal"
                            disabled={!isChecked}
                            value={qtyVal}
                            onChange={(ev) => setQtyMap((prev) => ({ ...prev, [e.id]: ev.target.value }))}
                          />
                          <span className="batchUnit">{UNIT_LABEL[e.unit] || "克"}</span>
                        </div>
                      )}
                    </div>
                    <div className="qtyPreview" style={{ margin: "2px 0 0" }}>
                      {preview ? `${preview.calories} kcal · P${preview.protein} C${preview.carbs} F${preview.fat}` : `${e.calories} kcal`}
                    </div>
                  </div>
                );
              })}
            </div>
            <button className="primaryBtn" onClick={confirmImport} disabled={checkedCount === 0}>
              匯入已選 ({checkedCount})
            </button>
          </div>
        )}
        <div style={{ height: 8 }} />
      </div>
    </div>
  );
}

// ---------- Move entry to another meal sheet ----------
function MoveEntrySheet({ fromMealKey, entry, onClose, onMove }) {
  const targets = MEALS.filter((m) => m.key !== fromMealKey);
  return (
    <div className="sheetOverlay">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <h3>移動「{entry.name}」</h3>
          <button className="iconBtn" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>
        <div className="savedList">
          {targets.map((m) => (
            <button
              key={m.key}
              className="savedItem"
              style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
              onClick={() => {
                onMove(m.key);
                onClose();
              }}
            >
              <div className="savedItemName">移到{m.label}</div>
            </button>
          ))}
        </div>
        <div style={{ height: 8 }} />
      </div>
    </div>
  );
}

// ---------- Edit quantity sheet ----------
function EditQtySheet({ entry, onClose, onSave }) {
  const [qty, setQty] = useState(String(entry.quantity));
  const preview = scaleEntryQty(entry, Number(qty) || 0);

  const save = () => {
    const n = Number(qty);
    if (!n || n <= 0) return;
    onSave(n);
    onClose();
  };

  return (
    <div className="sheetOverlay">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <h3>調整「{entry.name}」份量</h3>
          <button className="iconBtn" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>
        <div className="newPane">
          <label className="fieldLabel">吃了多少{UNIT_LABEL[entry.unit] || "克"}?</label>
          <input className="input" inputMode="decimal" autoFocus value={qty} onChange={(e) => setQty(e.target.value)} />
          <div className="qtyPreview">
            {Number(qty) > 0 ? (
              <>
                {preview.calories} kcal · P{preview.protein} C{preview.carbs} F{preview.fat}
              </>
            ) : (
              "輸入份量以預覽營養"
            )}
          </div>
          <button className="primaryBtn" onClick={save} disabled={!qty || Number(qty) <= 0}>
            儲存
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- Main App ----------
function DietTrackerApp() {
  const [ready, setReady] = useState(false);
  const [storageOk, setStorageOk] = useState(null); // null = checking, true/false = result
  const [tab, setTab] = useState("today");
  const [date, setDate] = useState(new Date());
  const [allLogs, setAllLogs] = useState({});
  const [savedFoods, setSavedFoods] = useState([]);
  const [combos, setCombos] = useState([]);
  const [goals, setGoals] = useState(DEFAULT_GOALS);
  const [addingMeal, setAddingMeal] = useState(null);
  const [importingMeal, setImportingMeal] = useState(null);
  const [movingEntry, setMovingEntry] = useState(null); // { mealKey, entry }
  const [editingQtyEntry, setEditingQtyEntry] = useState(null); // { mealKey, entry }
  const [editingGoals, setEditingGoals] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [hasConfig, setHasConfig] = useState(() => !!loadConfig());

  // Round-trips a throwaway key through Supabase so we can tell the difference between
  // "no data yet" and "this device can't reach the cloud right now" — the two look
  // identical (an empty app) unless we check, and storeGet/storeSet stay silent on
  // failure by design so the app keeps working off the local mirror.
  const checkStorage = useCallback(async () => {
    const client = getClient();
    if (!client) {
      setStorageOk(false);
      return;
    }
    markCloudUp(); // an explicit check should always really try, cooldown or not
    try {
      const probe = String(Date.now());
      const { error: wErr } = await withTimeout(
        client.from(TABLE).upsert({ key: "__healthcheck__", value: probe }, { onConflict: "key" })
      );
      if (wErr) {
        markCloudDown();
        setStorageOk(false);
        return;
      }
      const { data, error: rErr } = await withTimeout(
        client.from(TABLE).select("value").eq("key", "__healthcheck__").maybeSingle()
      );
      const ok = !rErr && !!data && data.value === probe;
      if (!ok) markCloudDown();
      setStorageOk(ok);
    } catch (e) {
      markCloudDown();
      setStorageOk(false);
    }
  }, []);

  // Loads everything from storage. Called on mount, and again whenever the tab/app
  // regains focus — this matters because storage is last-write-wins: if you edit on
  // your phone, then come back to a desktop tab that's been sitting open since before
  // that edit, the desktop tab still has the old (stale) copy in memory. Without a
  // refresh, the very next edit on desktop would save based on that stale copy and
  // silently overwrite the phone's changes. Refreshing on refocus closes that window.
  const loadAll = useCallback(async () => {
    const [g, sf, cb, logIndex] = await Promise.all([
      storeGet("goals"),
      storeGet("saved-foods"),
      storeGet("combos"),
      storeGet("log-index"),
    ]);
    if (g) setGoals(g);
    setSavedFoods(sf || []);
    setCombos(cb || []);
    const index = logIndex || [];
    if (index.length) {
      const entries = await Promise.all(index.map((k) => storeGet(`log:${k}`)));
      const obj = {};
      index.forEach((k, i) => {
        if (entries[i]) obj[k] = entries[i];
      });
      setAllLogs(obj);
    } else {
      setAllLogs({});
    }
  }, []);

  // initial load
  useEffect(() => {
    if (!hasConfig) {
      setReady(true);
      return;
    }
    checkStorage();
    loadAll().then(() => setReady(true));
  }, [loadAll, checkStorage, hasConfig]);

  // refresh whenever the app becomes visible again (switching back from another app/tab,
  // or turning the screen back on) so a stale in-memory copy doesn't get saved over
  // newer data written from another device
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadAll();
        checkStorage();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadAll, checkStorage]);

  const persistLog = useCallback(async (key, dayLog, index) => {
    await storeSet(`log:${key}`, dayLog);
    await storeSet("log-index", index);
  }, []);

  const dayKey = toKey(date);
  const dayLog = allLogs[dayKey] || {};

  // Adds one or more entries to a given meal on the currently-selected day in a single
  // functional state update, so multiple rapid calls (combo/batch/import) never clobber
  // each other.
  const handleAddEntries = useCallback(
    (mealKey, foods) => {
      setAllLogs((prev) => {
        const prevDayLog = prev[dayKey] || {};
        const newEntries = foods.map((f) => ({ id: uid(), ...f }));
        const newDayLog = { ...prevDayLog, [mealKey]: [...(prevDayLog[mealKey] || []), ...newEntries] };
        const newAllLogs = { ...prev, [dayKey]: newDayLog };
        const index = Object.keys(newAllLogs);
        persistLog(dayKey, newDayLog, index);
        return newAllLogs;
      });
    },
    [dayKey, persistLog]
  );

  const handleAddEntry = (mealKey, food) => handleAddEntries(mealKey, [food]);

  const handleRemoveEntry = (mealKey, id) => {
    const newDayLog = { ...dayLog, [mealKey]: (dayLog[mealKey] || []).filter((e) => e.id !== id) };
    const newAllLogs = { ...allLogs, [dayKey]: newDayLog };
    setAllLogs(newAllLogs);
    const index = Array.from(new Set([...Object.keys(newAllLogs)]));
    persistLog(dayKey, newDayLog, index);
  };

  const handleMoveEntry = useCallback(
    (fromMealKey, entryId, toMealKey) => {
      setAllLogs((prev) => {
        const prevDayLog = prev[dayKey] || {};
        const fromList = prevDayLog[fromMealKey] || [];
        const moving = fromList.find((e) => e.id === entryId);
        if (!moving) return prev;
        const newFromList = fromList.filter((e) => e.id !== entryId);
        const newToList = [...(prevDayLog[toMealKey] || []), moving];
        const newDayLog = { ...prevDayLog, [fromMealKey]: newFromList, [toMealKey]: newToList };
        const newAllLogs = { ...prev, [dayKey]: newDayLog };
        persistLog(dayKey, newDayLog, Object.keys(newAllLogs));
        return newAllLogs;
      });
    },
    [dayKey, persistLog]
  );

  const handleUpdateQty = useCallback(
    (mealKey, entryId, newQty) => {
      setAllLogs((prev) => {
        const prevDayLog = prev[dayKey] || {};
        const list = prevDayLog[mealKey] || [];
        const idx = list.findIndex((e) => e.id === entryId);
        if (idx === -1) return prev;
        const entry = list[idx];
        const updated = { ...entry, quantity: newQty, ...scaleEntryQty(entry, newQty) };
        const newList = [...list];
        newList[idx] = updated;
        const newDayLog = { ...prevDayLog, [mealKey]: newList };
        const newAllLogs = { ...prev, [dayKey]: newDayLog };
        persistLog(dayKey, newDayLog, Object.keys(newAllLogs));
        return newAllLogs;
      });
    },
    [dayKey, persistLog]
  );

  const handleSaveFood = (food, oldName) => {
    setSavedFoods((prev) => {
      const withoutDup = prev.filter((f) => f.name !== food.name && f.name !== oldName);
      const next = [food, ...withoutDup];
      storeSet("saved-foods", next);
      return next;
    });
  };

  const handleDeleteFood = (name) => {
    setSavedFoods((prev) => {
      const next = prev.filter((f) => f.name !== name);
      storeSet("saved-foods", next);
      return next;
    });
  };

  const handleSaveCombo = (combo) => {
    setCombos((prev) => {
      const withoutDup = prev.filter((c) => c.id !== combo.id);
      const next = [combo, ...withoutDup];
      storeSet("combos", next);
      return next;
    });
  };

  const handleDeleteCombo = (id) => {
    setCombos((prev) => {
      const next = prev.filter((c) => c.id !== id);
      storeSet("combos", next);
      return next;
    });
  };

  const handleSaveGoals = (g) => {
    setGoals(g);
    storeSet("goals", g);
  };

  const mealLabel = addingMeal ? MEALS.find((m) => m.key === addingMeal)?.label : "";
  const importMealLabel = importingMeal ? MEALS.find((m) => m.key === importingMeal)?.label : "";

  if (!ready) {
    return (
      <div className="appRoot">
        <Style />
        <div className="loadingScreen">載入中…</div>
      </div>
    );
  }

  if (!hasConfig) {
    return (
      <div className="appRoot">
        <Style />
        <SetupScreen
          onSaved={() => {
            resetClient();
            setHasConfig(true);
          }}
        />
      </div>
    );
  }

  return (
    <div className="appRoot">
      <Style />
      <div className="topBar">
        <div className="topBarTitle">飲食紀錄</div>
        <div className="topBarBtns">
          {tab === "today" && (
            <button className="topBarAction" onClick={() => setEditingGoals(true)}>
              目標
            </button>
          )}
          <button className="topBarAction" onClick={() => setShowSettings(true)}>
            設定
          </button>
        </div>
      </div>

      {storageOk === false && (
        <div className="storageWarning">
          ⚠️ 目前連不上雲端資料庫，變更只會存在這台裝置上，不會同步到其他裝置。請到右上角「設定」檢查金鑰是否正確，或確認網路連線。
        </div>
      )}

      <div className="content">
        {tab === "today" && (
          <TodayView
            date={date}
            setDate={setDate}
            log={dayLog}
            goals={goals}
            onOpenAdd={(mealKey) => setAddingMeal(mealKey)}
            onOpenImport={(mealKey) => setImportingMeal(mealKey)}
            onRemoveEntry={handleRemoveEntry}
            onOpenMove={(mealKey, entry) => setMovingEntry({ mealKey, entry })}
            onOpenEditQty={(mealKey, entry) => setEditingQtyEntry({ mealKey, entry })}
          />
        )}
        {tab === "history" && <HistoryView allLogs={allLogs} goals={goals} />}
        {tab === "foods" && (
          <FoodsView
            savedFoods={savedFoods}
            onDeleteFood={handleDeleteFood}
            onSaveFood={handleSaveFood}
            combos={combos}
            onSaveCombo={handleSaveCombo}
            onDeleteCombo={handleDeleteCombo}
          />
        )}
      </div>

      <div className="tabBar">
        <button className={tab === "today" ? "tabBtn active" : "tabBtn"} onClick={() => setTab("today")}>
          <span className="tabIcon">◐</span>
          <span>今天</span>
        </button>
        <button className={tab === "history" ? "tabBtn active" : "tabBtn"} onClick={() => setTab("history")}>
          <span className="tabIcon">▤</span>
          <span>紀錄</span>
        </button>
        <button className={tab === "foods" ? "tabBtn active" : "tabBtn"} onClick={() => setTab("foods")}>
          <span className="tabIcon">☰</span>
          <span>常吃食物</span>
        </button>
      </div>

      {addingMeal && (
        <AddFoodSheet
          mealLabel={mealLabel}
          savedFoods={savedFoods}
          combos={combos}
          onClose={() => setAddingMeal(null)}
          onAdd={(food) => handleAddEntry(addingMeal, food)}
          onAddMany={(foods) => handleAddEntries(addingMeal, foods)}
          onSaveFood={handleSaveFood}
        />
      )}
      {importingMeal && (
        <ImportSheet
          mealKey={importingMeal}
          mealLabel={importMealLabel}
          allLogs={allLogs}
          todayKey={dayKey}
          onClose={() => setImportingMeal(null)}
          onImport={(entries) => handleAddEntries(importingMeal, entries.map(({ id, ...rest }) => rest))}
        />
      )}
      {movingEntry && (
        <MoveEntrySheet
          fromMealKey={movingEntry.mealKey}
          entry={movingEntry.entry}
          onClose={() => setMovingEntry(null)}
          onMove={(toMealKey) => handleMoveEntry(movingEntry.mealKey, movingEntry.entry.id, toMealKey)}
        />
      )}
      {editingQtyEntry && (
        <EditQtySheet
          entry={editingQtyEntry.entry}
          onClose={() => setEditingQtyEntry(null)}
          onSave={(newQty) => handleUpdateQty(editingQtyEntry.mealKey, editingQtyEntry.entry.id, newQty)}
        />
      )}
      {editingGoals && <GoalsSheet goals={goals} onClose={() => setEditingGoals(false)} onSave={handleSaveGoals} />}
      {showSettings && (
        <SettingsSheet
          storageOk={storageOk}
          onClose={() => setShowSettings(false)}
          onReloaded={() => {
            checkStorage();
            loadAll();
          }}
          onReset={() => {
            clearConfig();
            resetClient();
            setHasConfig(false);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}

function Style() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap');

      /* Several cards use width:100% together with padding, which without this
         overflows the container and pushes their right edge off-screen. */
      .appRoot, .appRoot *, .appRoot *::before, .appRoot *::after {
        box-sizing: border-box;
      }

      .appRoot {
        --bg: #FAF7F0;
        --surface: #FFFFFF;
        --line: #EAE3D5;
        --ink: #2B2B26;
        --ink-soft: #8A8578;
        --green: #4A7C59;
        --gold: #E8A33D;
        --rose: #C1666B;
        font-family: 'Inter', ui-sans-serif, system-ui, sans-serif;
        color: var(--ink);
        background: var(--bg);
        max-width: 480px;
        margin: 0 auto;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        position: relative;
      }
      .loadingScreen {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        color: var(--ink-soft);
        font-size: 14px;
      }
      .topBar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 18px 20px 12px;
      }
      .topBarTitle {
        font-family: 'Fraunces', serif;
        font-size: 22px;
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .topBarAction {
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--ink);
        border-radius: 999px;
        padding: 6px 14px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
      }
      .storageWarning {
        margin: 0 20px 12px;
        padding: 10px 12px;
        background: #FBF1E6;
        border: 1px solid #E8A33D;
        border-radius: 12px;
        font-size: 12px;
        line-height: 1.5;
        color: var(--ink);
      }
      .content {
        flex: 1;
        overflow-y: auto;
        padding-bottom: 90px;
      }
      .screen {
        padding: 4px 20px 0;
      }
      .dateNav {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 18px;
        margin: 4px 0 18px;
      }
      .dateLabel {
        font-size: 15px;
        font-weight: 600;
        min-width: 110px;
        text-align: center;
      }
      .iconBtn {
        border: none;
        background: transparent;
        font-size: 20px;
        color: var(--ink);
        cursor: pointer;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
      }
      .iconBtn:hover { background: var(--line); }

      .ringCard {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 20px;
        padding: 24px 20px;
        display: flex;
        flex-direction: column;
        align-items: center;
        margin-bottom: 18px;
      }
      .ringWrap {
        position: relative;
        width: 168px;
        height: 168px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin-bottom: 20px;
      }
      .ringCenter {
        position: absolute;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .ringNum {
        font-family: 'Fraunces', serif;
        font-size: 40px;
        font-weight: 600;
        line-height: 1;
      }
      .ringSub {
        font-size: 12px;
        color: var(--ink-soft);
        margin-top: 6px;
      }
      .macros {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .macroRow { width: 100%; }
      .macroTop {
        display: flex;
        justify-content: space-between;
        font-size: 13px;
        margin-bottom: 4px;
      }
      .macroLabel { color: var(--ink); font-weight: 500; }
      .macroNums { color: var(--ink); font-weight: 600; }
      .macroGoal { color: var(--ink-soft); font-weight: 400; }
      .macroTrack {
        height: 6px;
        background: var(--line);
        border-radius: 999px;
        overflow: hidden;
      }
      .macroFill {
        height: 100%;
        border-radius: 999px;
        transition: width 0.4s ease;
      }

      .mealCard {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 14px 16px;
        margin-bottom: 12px;
      }
      .mealHeader {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        margin-bottom: 6px;
      }
      .mealTitle {
        font-family: 'Fraunces', serif;
        font-size: 16px;
        font-weight: 600;
      }
      .mealCal {
        font-size: 12px;
        color: var(--ink-soft);
      }
      .entryRow {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 4px 0;
        border-top: 1px solid var(--line);
      }
      .entryInfoBtn {
        border: none;
        background: transparent;
        padding: 10px 4px 10px 0;
        margin: -4px 0;
        cursor: pointer;
        text-align: left;
        flex: 1;
        min-width: 0;
        display: block;
        border-radius: 8px;
      }
      .entryName { font-size: 14px; }
      .entryQty { font-size: 11px; color: var(--ink-soft); margin-top: 1px; }
      .qtyPreview {
        font-size: 13px;
        color: var(--ink-soft);
        margin: -6px 0 16px;
      }
      .entryRight {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .entryCal {
        font-size: 13px;
        color: var(--ink-soft);
      }
      .removeBtn {
        border: none;
        background: transparent;
        color: var(--ink-soft);
        cursor: pointer;
        font-size: 13px;
        width: 22px;
        height: 22px;
        border-radius: 50%;
      }
      .removeBtn:hover { background: var(--line); color: var(--rose); }
      .moveBtn {
        border: none;
        background: transparent;
        color: var(--ink-soft);
        cursor: pointer;
        font-size: 13px;
        width: 22px;
        height: 22px;
        border-radius: 50%;
      }
      .moveBtn:hover { background: var(--line); color: var(--green); }
      .addRowBtn {
        margin-top: 8px;
        width: 100%;
        border: 1px dashed var(--line);
        background: transparent;
        border-radius: 10px;
        padding: 9px;
        font-size: 13px;
        color: var(--green);
        font-weight: 500;
        cursor: pointer;
      }
      .addRowBtn:hover { background: #F2F6F3; }
      .importRowBtn {
        margin-top: 6px;
        width: 100%;
        border: none;
        background: transparent;
        border-radius: 10px;
        padding: 7px;
        font-size: 12px;
        color: var(--ink-soft);
        font-weight: 500;
        cursor: pointer;
      }
      .importRowBtn:hover { background: var(--line); color: var(--ink); }

      .foodsHeaderRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 12px 0 10px;
      }
      .addChip {
        border: 1px solid var(--green);
        background: transparent;
        color: var(--green);
        border-radius: 999px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
      }
      .addChip:hover { background: #F2F6F3; }

      .sectionTitle {
        font-family: 'Fraunces', serif;
        font-size: 18px;
        font-weight: 600;
        margin: 12px 0 10px;
      }
      .chartCard {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 16px;
        padding: 16px;
        margin-bottom: 20px;
      }
      .chartBars {
        display: flex;
        align-items: flex-end;
        gap: 4px;
        height: 120px;
      }
      .barCol {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        height: 100%;
      }
      .barTrack {
        flex: 1;
        width: 100%;
        display: flex;
        align-items: flex-end;
      }
      .barFill {
        width: 100%;
        border-radius: 4px 4px 0 0;
        min-height: 2px;
      }
      .barLabel {
        font-size: 9px;
        color: var(--ink-soft);
        margin-top: 4px;
      }
      .goalLine {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--ink-soft);
        margin-top: 12px;
      }
      .goalDot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--green);
        display: inline-block;
      }
      .historyList {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .historyRow {
        display: flex;
        justify-content: space-between;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 12px 14px;
      }
      .historyDate { font-size: 14px; font-weight: 500; }
      .historyCal { font-size: 14px; color: var(--green); font-weight: 600; }
      .historyCal.over { color: var(--rose); }

      .emptyHint {
        color: var(--ink-soft);
        font-size: 13px;
        text-align: center;
        padding: 24px 0;
      }

      .tabBar {
        position: fixed;
        bottom: 0;
        left: 50%;
        transform: translateX(-50%);
        width: 100%;
        max-width: 480px;
        display: flex;
        background: var(--surface);
        border-top: 1px solid var(--line);
        padding: 8px 0 max(8px, env(safe-area-inset-bottom));
      }
      .tabBtn {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 3px;
        border: none;
        background: transparent;
        color: var(--ink-soft);
        font-size: 11px;
        padding: 4px 0;
        cursor: pointer;
      }
      .tabBtn.active { color: var(--green); font-weight: 600; }
      .tabIcon { font-size: 18px; }

      .sheetOverlay {
        position: fixed;
        inset: 0;
        background: rgba(43, 43, 38, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        box-sizing: border-box;
        z-index: 50;
      }
      .sheet {
        background: var(--bg);
        width: 100%;
        max-width: 440px;
        border-radius: 20px;
        padding: 20px 20px 24px;
        max-height: 85vh;
        overflow-y: auto;
      }
      .sheetHandle {
        display: none;
      }
      .sheetHeader {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 14px;
      }
      .sheetHeader h3 {
        font-family: 'Fraunces', serif;
        font-size: 18px;
        font-weight: 600;
        margin: 0;
      }
      .segTabs {
        display: flex;
        background: var(--line);
        border-radius: 10px;
        padding: 3px;
        margin-bottom: 14px;
      }
      .segBtn {
        flex: 1;
        border: none;
        background: transparent;
        padding: 8px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
        color: var(--ink-soft);
        cursor: pointer;
      }
      .segBtn.active { background: var(--surface); color: var(--ink); }

      .input {
        width: 100%;
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 14px;
        color: var(--ink);
        box-sizing: border-box;
        margin-bottom: 12px;
        font-family: inherit;
      }
      .input:focus {
        outline: none;
        border-color: var(--green);
      }
      .fieldLabel {
        font-size: 12px;
        color: var(--ink-soft);
        margin-bottom: 4px;
        display: block;
      }
      .autoTag {
        display: inline-block;
        background: #F2F6F3;
        color: var(--green);
        font-size: 10px;
        font-weight: 600;
        padding: 1px 6px;
        border-radius: 999px;
        margin-left: 4px;
      }
      .threeCol {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 10px;
      }
      .checkRow {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        color: var(--ink-soft);
        margin: 4px 0 16px;
      }
      .primaryBtn {
        width: 100%;
        border: none;
        background: var(--green);
        color: white;
        padding: 13px;
        border-radius: 12px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
      }
      .primaryBtn:disabled { opacity: 0.4; cursor: not-allowed; }

      .savedList {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 340px;
        overflow-y: auto;
      }
      .savedItem {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 12px;
        padding: 4px 14px 4px 10px;
      }
      .savedItem.picked {
        border-color: var(--green);
        background: #F2F6F3;
      }
      .pickCheck {
        display: flex;
        align-items: center;
        padding: 8px 2px;
        cursor: pointer;
      }
      .pickCheck input {
        width: 18px;
        height: 18px;
        accent-color: var(--green);
        cursor: pointer;
      }
      .savedItemBody {
        flex: 1;
        display: block;
        text-align: left;
        border: none;
        background: transparent;
        padding: 10px 0;
        cursor: pointer;
        min-width: 0;
      }
      .savedItemName { font-size: 14px; font-weight: 500; }
      .savedItemMeta { font-size: 12px; color: var(--ink-soft); margin-top: 2px; }

      .pickBar {
        position: sticky;
        bottom: 0;
        left: 0;
        right: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: var(--bg);
        border-top: 1px solid var(--line);
        padding: 10px 2px 2px;
        margin-top: 8px;
        font-size: 13px;
        color: var(--ink-soft);
      }
      .pickBarBtn {
        width: auto;
        padding: 9px 16px;
        font-size: 13px;
        border-radius: 10px;
      }

      .batchList {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: 380px;
        overflow-y: auto;
      }
      .batchRow {
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 12px;
        padding: 10px 12px;
      }
      .batchRow.picked {
        border-color: var(--green);
      }
      .batchRowTop {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .batchRowName {
        font-size: 14px;
        font-weight: 500;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .batchQtyInput {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .batchInput {
        width: 64px;
        margin-bottom: 0;
        padding: 7px 8px;
        text-align: right;
      }
      .batchUnit {
        font-size: 12px;
        color: var(--ink-soft);
      }
      .topBarBtns {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .setupScreen {
        padding: 28px 20px 40px;
        max-width: 440px;
        margin: 0 auto;
      }
      .setupTitle {
        font-family: 'Fraunces', serif;
        font-size: 24px;
        font-weight: 600;
        margin: 0 0 8px;
      }
      .setupIntro {
        font-size: 13px;
        line-height: 1.6;
        color: var(--ink-soft);
        margin-bottom: 20px;
      }
      .setupSteps {
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px 16px 14px 32px;
        margin-bottom: 20px;
        font-size: 13px;
        line-height: 1.7;
        color: var(--ink);
      }
      .setupSteps li { margin-bottom: 4px; }
      .setupSteps code {
        background: var(--bg);
        border: 1px solid var(--line);
        border-radius: 4px;
        padding: 1px 5px;
        font-size: 12px;
      }
      .errText {
        color: var(--rose);
        font-size: 13px;
        margin: -6px 0 14px;
      }
      .okText {
        color: var(--green);
        font-size: 13px;
        margin: -6px 0 14px;
      }
      .settingsRow {
        display: flex;
        gap: 10px;
        margin-bottom: 12px;
      }
      .settingsRow .primaryBtn { flex: 1; }
      .ghostBtn {
        flex: 1;
        border: 1px solid var(--line);
        background: var(--surface);
        color: var(--ink);
        padding: 13px;
        border-radius: 12px;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
      }
      .dangerBtn {
        width: 100%;
        border: 1px solid var(--rose);
        background: transparent;
        color: var(--rose);
        padding: 11px;
        border-radius: 12px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        font-family: inherit;
      }
      .statusPill {
        display: inline-block;
        font-size: 12px;
        font-weight: 600;
        padding: 3px 10px;
        border-radius: 999px;
        margin-bottom: 14px;
      }
      .statusPill.ok { background: #F2F6F3; color: var(--green); }
      .statusPill.bad { background: #FBF1E6; color: #B5761F; }
      .textArea {
        width: 100%;
        min-height: 120px;
        border: 1px solid var(--line);
        background: var(--surface);
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--ink);
        box-sizing: border-box;
        margin-bottom: 12px;
        resize: vertical;
      }
      .divider {
        height: 1px;
        background: var(--line);
        margin: 20px 0 16px;
      }
      .sectionLabel {
        font-family: 'Fraunces', serif;
        font-size: 15px;
        font-weight: 600;
        margin-bottom: 8px;
      }
    `}</style>
  );
}


// ---------- first-run setup ----------
function SetupScreen({ onSaved }) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setErr("");
    const u = url.trim().replace(/\/+$/, "");
    const k = key.trim();
    if (!u || !k) {
      setErr("請兩個欄位都填。");
      return;
    }
    if (!/^https:\/\/.+\.supabase\.co$/.test(u)) {
      setErr("Project URL 看起來不對，應該長得像 https://xxxxx.supabase.co");
      return;
    }
    setBusy(true);
    try {
      const client = window.supabase.createClient(u, k);
      const { error } = await client.from(TABLE).select("key").limit(1);
      if (error) {
        setErr("連線失敗：" + error.message + "（請確認金鑰正確，且已建好 app_data 資料表）");
        setBusy(false);
        return;
      }
      saveConfig({ url: u, key: k });
      resetClient();
      onSaved();
    } catch (e) {
      setErr("連線失敗：" + (e && e.message ? e.message : "未知錯誤"));
    }
    setBusy(false);
  };

  return (
    <div className="setupScreen">
      <h1 className="setupTitle">連接你的資料庫</h1>
      <p className="setupIntro">
        第一次使用需要連上你自己的 Supabase 免費資料庫，資料才能在手機和電腦之間同步。
        金鑰只會存在這台裝置的瀏覽器裡，不會上傳到 GitHub。每台裝置各設定一次。
      </p>

      <ol className="setupSteps">
        <li>到 supabase.com 註冊並建立一個專案</li>
        <li>左側選 SQL Editor，貼上教學裡的建表語法並執行</li>
        <li>左側選 Project Settings → API</li>
        <li>複製 Project URL 和 anon public 金鑰，貼到下方</li>
      </ol>

      <label className="fieldLabel">Project URL</label>
      <input
        className="input"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://xxxxx.supabase.co"
        autoComplete="off"
      />

      <label className="fieldLabel">anon public 金鑰</label>
      <input
        className="input"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="eyJhbGciOi..."
        autoComplete="off"
      />

      {err && <div className="errText">{err}</div>}

      <button className="primaryBtn" onClick={connect} disabled={busy}>
        {busy ? "連線中…" : "連線"}
      </button>
    </div>
  );
}

// ---------- settings / backup ----------
function SettingsSheet({ storageOk, onClose, onReloaded, onReset }) {
  const [text, setText] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const data = await exportAll();
      downloadJson(data, `diet-tracker-${toKey(new Date())}.json`);
      setMsg("已下載備份檔。");
    } catch (e) {
      setErr("匯出失敗：" + (e && e.message ? e.message : "未知錯誤"));
    }
    setBusy(false);
  };

  const doImport = async () => {
    setErr("");
    setMsg("");
    if (!text.trim()) {
      setErr("請先貼上備份內容。");
      return;
    }
    setBusy(true);
    try {
      const parsed = JSON.parse(text);
      const r = await importAll(parsed);
      setText("");
      setMsg(`匯入完成：${r.foods} 項食物、${r.combos} 組搭配、${r.days} 天紀錄。`);
      onReloaded();
    } catch (e) {
      setErr("匯入失敗：" + (e && e.message ? e.message : "格式不正確"));
    }
    setBusy(false);
  };

  const onFile = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ""));
    reader.readAsText(f);
  };

  return (
    <div className="sheetOverlay">
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheetHandle" />
        <div className="sheetHeader">
          <h3>設定與備份</h3>
          <button className="iconBtn" onClick={onClose} aria-label="關閉">
            ✕
          </button>
        </div>
        <div className="newPane">
          <span className={storageOk ? "statusPill ok" : "statusPill bad"}>
            {storageOk ? "● 雲端已連線" : "● 雲端未連線"}
          </span>

          <div className="sectionLabel">備份</div>
          <button className="primaryBtn" onClick={doExport} disabled={busy} style={{ marginBottom: 12 }}>
            匯出備份檔
          </button>

          <div className="divider" />

          <div className="sectionLabel">匯入資料</div>
          <p className="setupIntro" style={{ marginBottom: 10 }}>
            從舊版匯出的備份檔可以貼在這裡還原。匯入是「合併」，不會蓋掉你已經輸入的資料。
          </p>
          <input type="file" accept="application/json,.json" onChange={onFile} style={{ marginBottom: 10, fontSize: 13 }} />
          <textarea
            className="textArea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="或直接把備份內容貼進來…"
          />
          <button className="primaryBtn" onClick={doImport} disabled={busy}>
            {busy ? "處理中…" : "匯入"}
          </button>

          {msg && <div className="okText" style={{ marginTop: 12 }}>{msg}</div>}
          {err && <div className="errText" style={{ marginTop: 12 }}>{err}</div>}

          <div className="divider" />

          <div className="sectionLabel">連線</div>
          <p className="setupIntro" style={{ marginBottom: 10 }}>
            重設後要重新輸入 Supabase 金鑰。雲端上的資料不會被刪除。
          </p>
          <button className="dangerBtn" onClick={onReset}>
            重設連線設定
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- mount ----------
ReactDOM.createRoot(document.getElementById("root")).render(<DietTrackerApp />);
