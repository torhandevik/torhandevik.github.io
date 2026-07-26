/* Mölkky — single source of truth in `state`; render() rebuilds the current screen. */

// Standard Mölkky pin layout, back row first, 1–2 nearest the thrower.
const PIN_ROWS = [[7, 9, 8], [5, 11, 12, 6], [3, 10, 4], [1, 2]];
const STORE_KEY = "molkky.v1";

const DEFAULT_ROSTER = [];

// Stable player id — players are referenced by id so renames and duplicate names never mix up.
const uid = () => "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);

const state = {
  screen: "hem",     // hem | nytt | spel | stallning | rondslut | slut | spelare | historik | installningar
  roster: [],        // [{ id, name, games, wins }]
  picked: [],        // [id] chosen on Nytt spel
  order:  [],        // [id] turn order
  maxScore: 50,      // 20–100, step 5
  resetScore: 25,    // 0–(maxScore-5), step 5
  settings: { knockout: true, halfOnMiss: false, sound: false, haptics: true },
  archive: [],       // finished games, newest first
  game: null,
  pins: [],          // numbers of the pins marked as fallen
  banner: null,      // { icon, text, tone }
  newName: "",
  renameId: null,
  renameName: "",
  focusKey: null     // element to re-focus after a render
};

const app = document.getElementById("app");
const clone = o => JSON.parse(JSON.stringify(o));

/* ---------- Player lookups (id-based) ---------- */

const playerById = id => state.roster.find(p => p.id === id);
const nameById = id => { const p = playerById(id); return p ? p.name : "?"; };
// Case-insensitive uniqueness check, optionally ignoring the player being renamed.
const nameTaken = (name, exceptId) => state.roster.some(
  r => r.id !== exceptId && r.name.toLowerCase() === name.trim().toLowerCase());

/* ---------- Persistence ---------- */

const PERSIST = ["roster", "picked", "order", "maxScore", "resetScore", "settings", "archive", "game"];

// Upgrade pre-id (name-based) saved data to the id-based model. Returns true when it changed anything.
function migrate() {
  if (!Array.isArray(state.roster)) return false;
  const needs = state.roster.some(p => p && p.id == null);
  if (!needs) return false;
  const byName = {};
  state.roster = state.roster.map(p => {
    const id = p.id || uid();
    byName[p.name] = id;
    return { id, name: p.name, games: p.games || 0, wins: p.wins || 0 };
  });
  const toId = n => byName[n] || null;
  state.picked = (state.picked || []).map(toId).filter(Boolean);
  state.order = (state.order || []).map(toId).filter(Boolean);
  if (state.game && Array.isArray(state.game.players)) {
    state.game.players.forEach(pl => { if (pl.id == null) pl.id = byName[pl.name] || uid(); });
    (state.game.log || []).forEach(t => { if (t.id == null) t.id = byName[t.name] || null; });
  }
  (state.archive || []).forEach(a => {
    if (Array.isArray(a.players)) a.players.forEach(p => { if (p.id == null) p.id = byName[p.name] || uid(); });
    if (a.winnerName == null) a.winnerName = a.winner || null;
    if (typeof a.winner === "string" && a.winner && !String(a.winner).startsWith("p_")) {
      const w = (a.players || []).find(p => p.name === a.winner);
      a.winner = w ? w.id : null;
    }
  });
  return true;
}

// Backfill fields added after older saves were written.
function normalize() {
  const g = state.game;
  if (g) {
    if (!Array.isArray(g.winners)) g.winners = g.winner ? [g.winner] : [];
    if (typeof g.roundEndPrompt !== "boolean") g.roundEndPrompt = false;
    if (typeof g.playThrough !== "boolean") g.playThrough = false;
  }
  (state.archive || []).forEach(a => {
    if (!Array.isArray(a.winners)) a.winners = a.winner ? [a.winner] : [];
  });
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved) for (const k of PERSIST) if (saved[k] != null) state[k] = saved[k];
  } catch (e) { /* ignore corrupt storage */ }
  const migrated = migrate();
  normalize();
  if (migrated) save();
}

function save() {
  const out = {};
  for (const k of PERSIST) out[k] = state[k];
  try { localStorage.setItem(STORE_KEY, JSON.stringify(out)); } catch (e) {}
}

// Wipe every persisted value and reset in-memory state to a clean slate.
function wipeAllData() {
  try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  Object.assign(state, {
    roster: [], picked: [], order: [], maxScore: 50, resetScore: 25,
    settings: { knockout: true, halfOnMiss: false, sound: false, haptics: true },
    archive: [], game: null, pins: [], banner: null,
    newName: "", renameId: null, renameName: "", screen: "hem"
  });
  save();
  render();
}

const set = patch => { Object.assign(state, patch); save(); render(); };
// Like `set` but without re-rendering — used for live text input so the DOM
// (and the `rise` animation / viewport height) doesn't churn on every keystroke.
const setQuiet = patch => { Object.assign(state, patch); save(); };

/* ---------- Rules ---------- */

// A throw's value: one pin down = that pin's number; several = how many fell.
function pointsFor(pins) {
  if (pins.length === 0) return 0;
  return pins.length === 1 ? pins[0] : pins.length;
}

function newGame() {
  return {
    id: Date.now(),
    players: state.order.map(id => ({ id, name: nameById(id), score: 0, misses: 0, out: false, done: false })),
    turn: 0, round: 1, max: state.maxScore, reset: state.resetScore,
    knockout: state.settings.knockout, halfOnMiss: state.settings.halfOnMiss,
    log: [], history: [], finished: false, winner: null, winners: [],
    roundEndPrompt: false,  // a round ended with ≥1 finisher — the team must decide whether to continue
    playThrough: false      // set once the team chose to play on, so the prompt is never shown again
  };
}

const active = g => g.players.filter(p => !p.out && !p.done);
const winners = g => g.players.filter(p => p.done);

// Move the turn to the next player who is still active. Returns true when the
// pointer wrapped past the last player (i.e. a full round was completed).
function advance(g) {
  const n = g.players.length;
  for (let i = 1; i <= n; i++) {
    const idx = (g.turn + i) % n;
    const p = g.players[idx];
    if (!p.out && !p.done) {
      const wrapped = idx <= g.turn;
      if (wrapped) g.round += 1;   // wrapped past the last player
      g.turn = idx;
      return wrapped;
    }
  }
  return true;   // no active players left — the round is over
}

function archiveGame(g) {
  const winIds = (g.winners && g.winners.length) ? g.winners : (g.winner ? [g.winner] : []);
  const winNames = winIds.map(id => (g.players.find(p => p.id === id) || {}).name).filter(Boolean);
  const entry = {
    id: g.id,
    date: new Date().toISOString(),
    winner: winIds[0] || null,
    winners: winIds,
    winnerName: winNames.join(" & ") || null,
    max: g.max,
    rounds: g.round,
    players: g.players.map(p => ({ id: p.id, name: p.name, score: p.score, out: p.out, done: p.done }))
  };
  const rest = state.archive.filter(a => a.id !== g.id);
  const already = state.archive.some(a => a.id === g.id);
  const roster = state.roster.map(r => {
    if (already || !g.players.some(p => p.id === r.id)) return r;
    return { ...r, games: r.games + 1, wins: r.wins + (winIds.includes(r.id) ? 1 : 0) };
  });
  state.archive = [entry].concat(rest);
  state.roster = roster;
}

// End the game. Winners are all players who reached the max (a shared win is possible).
function finish(g) {
  g.finished = true;
  g.roundEndPrompt = false;
  // If winners were already locked in at the round-end prompt (playThrough),
  // keep them. Otherwise derive from whoever reached max now.
  if (!g.winners || !g.winners.length) {
    g.winners = winners(g).map(p => p.id);
    g.winner = g.winners[0] || null;
  }
  archiveGame(g);
}

let _throwing = false;
function registerThrow(points) {
  if (_throwing) return;   // ignore rapid re-entrant taps
  _throwing = true;
  try {
  const g = clone(state.game);
  // Snapshot only the fields needed to undo — NOT the full history array —
  // to avoid O(n²) memory growth from nested clones.
  const snapshot = {
    players: clone(g.players),
    turn: g.turn, round: g.round,
    winners: g.winners ? g.winners.slice() : [],
    winner: g.winner,
    playThrough: g.playThrough,
    roundEndPrompt: g.roundEndPrompt,
    finished: g.finished
  };
  const p = g.players[g.turn];
  let banner;

  if (points === 0) {
    p.misses += 1;
    if (g.knockout && p.misses >= 3) {
      p.out = true;
      banner = { icon: "✕", text: p.name + " är utslagen", tone: "warn" };
    } else {
      if (g.halfOnMiss) p.score = Math.floor(p.score / 2);
      banner = { icon: "—", text: "Bom för " + p.name + " · " + p.misses + " i rad", tone: "calm" };
    }
  } else {
    p.misses = 0;
    const next = p.score + points;
    if (next > g.max) {
      p.score = g.reset;
      banner = { icon: "↩", text: p.name + " gick över " + g.max + " – tillbaka till " + g.reset, tone: "warn" };
    } else if (next === g.max) {
      p.score = next; p.done = true;
      banner = { icon: "🏆", text: p.name + " är i mål! Snyggt kast!", tone: "win" };
    } else {
      p.score = next;
      banner = { icon: "✓", text: (points >= 8 ? "Snyggt kast! " : "") + p.name + " +" + points, tone: "good" };
    }
  }

  // Tag milestone events so the throw history can highlight them.
  const logTag = p.out ? "out" : (p.done ? (g.playThrough ? "done" : "win") : null);
  g.log.unshift({ id: p.id, name: p.name, pins: state.pins.slice(), points, score: p.score, round: g.round, tag: logTag });
  // Cap undo history — keeps only the last 20 snapshots to bound memory use.
  g.history.push(snapshot);
  if (g.history.length > 20) g.history.shift();

  const wrapped = advance(g);
  const left = active(g);
  const anyDone = winners(g).length > 0;

  if (wrapped && left.length === 0) {
    // Everyone is out — end with no winner.
    finish(g);
  } else if (wrapped && left.length === 1 && !anyDone) {
    // Round completed with one survivor. Only a winner if they scored > 0.
    // A survivor still on 0 points means nobody ever scored — all lose.
    if (left[0].score > 0) {
      g.players.forEach(pl => { if (pl.id === left[0].id) pl.done = true; });
    }
    finish(g);
  } else if (wrapped && anyDone && left.length <= 1) {
    // A round finished with a finisher and at most one player is still in play.
    // Don't prompt (nothing to decide) and, in continued play, this is the
    // all-but-one-reached-max end condition — end the game now.
    finish(g);
  } else if (wrapped && anyDone && !g.playThrough) {
    // A round finished with a finisher and 2+ players still in play — ask once
    // whether to play on. Lock in the winners right now so that players who
    // reach max during continued play are not counted as additional winners.
    g.winners = winners(g).map(p => p.id);
    g.winner = g.winners[0] || null;
    g.roundEndPrompt = true;
  }

  set({
    game: g, pins: [], banner,
    screen: g.finished ? "slut" : (g.roundEndPrompt ? "rondslut" : state.screen)
  });
  } finally {
    _throwing = false;
  }
}

// The remaining players choose to keep playing after a round-end prompt.
function continueGame() {
  const g = clone(state.game);
  g.roundEndPrompt = false;
  g.playThrough = true;
  set({ game: g, banner: null, screen: "spel" });
}

// End the game now (from the round-end prompt or the Ställning "Avsluta" action).
function endGameNow() {
  const g = clone(state.game);
  finish(g);
  set({ game: g, pins: [], banner: null, screen: "slut" });
}

function undo() {
  const g = state.game;
  if (!g || !g.history.length) return;
  const snap = g.history[g.history.length - 1];
  // Restore game state from the slim snapshot, keeping unchanged fields intact.
  const restored = clone(g);
  restored.players        = clone(snap.players);
  restored.turn           = snap.turn;
  restored.round          = snap.round;
  restored.winners        = snap.winners ? snap.winners.slice() : [];
  restored.winner         = snap.winner;
  restored.playThrough    = snap.playThrough;
  restored.roundEndPrompt = snap.roundEndPrompt;
  restored.finished       = snap.finished;
  restored.history        = g.history.slice(0, -1);
  restored.log            = g.log.slice(1);   // remove the last log entry
  set({ game: restored, pins: [], banner: null, screen: "spel" });
}

// Manual correction from Ställning — scores are edited by hand, nothing else changes.
function editPlayer(i, patch) {
  const g = clone(state.game);
  Object.assign(g.players[i], patch);
  if (g.players[i].score < 0) g.players[i].score = 0;
  if (g.players[i].score > g.max) g.players[i].score = g.max;
  g.players[i].done = g.players[i].score === g.max;
  set({ game: g });
}

/* ---------- Render helpers ---------- */

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "value") node.value = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.append(c);
  return node;
};

const topbar = (title, back, trailing) => el("div", { class: "topbar" }, [
  el("button", { class: "back", text: "‹", "aria-label": "Tillbaka", onClick: back }),
  el("h2", { class: "screen-title", text: title, style: "margin:0;flex:1" }),
  trailing || null
]);

const label = t => el("div", { class: "label", text: t });
const empty = t => el("div", { class: "empty", text: t });
const initials = n => n.trim().charAt(0).toUpperCase();
const dateSv = iso => new Date(iso).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
// yyyy-MM-dd HH:mm — used in game history to show when a game started.
const dateTimeSv = iso => new Date(iso).toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

let lastScreen = null;
// Render the milestone badge for a throw-history row.
const logTagEl = tag => {
  if (!tag) return null;
  if (tag === "win")  return el("span", { class: "st-tag is-done", text: "🏆 I mål" });
  if (tag === "done") return el("span", { class: "st-tag is-done", text: "I mål" });
  if (tag === "out")  return el("span", { class: "st-tag is-out",  text: "Utslagen" });
  return null;
};
function render() {
  const screens = { hem: renderHem, nytt: renderNytt, spel: renderSpel, stallning: renderStallning,
    rondslut: renderRondslut, slut: renderSlut, spelare: renderSpelare, historik: renderHistorik, installningar: renderInstallningar };
  const node = (screens[state.screen] || renderHem)();
  // Only play the entrance animation when the screen actually changes — not on
  // in-screen re-renders (chip toggles, steppers, etc.) — so the page doesn't jump.
  if (state.screen !== lastScreen) node.classList.add("scr-enter");
  lastScreen = state.screen;
  app.replaceChildren(node);
  if (state.focusKey) {
    const node = app.querySelector('[data-focus="' + state.focusKey + '"]');
    if (node) { node.focus(); if (node.setSelectionRange) node.setSelectionRange(9999, 9999); }
  }
}

/* ---------- Hem ---------- */

function renderHem() {
  const g = state.game && !state.game.finished ? state.game : null;
  const resume = g ? el("div", { class: "resume-card" }, [
    el("div", { class: "eyebrow", text: "Pågående spel · omgång " + g.round }),
    el("div", { class: "roster-line", text: g.players.map(p => p.name).join(", ") }),
    el("button", { class: "btn btn-primary btn-block cta-md", style: "margin-top:6px", text: "Fortsätt spel",
      onClick: () => set({ screen: "spel" }) })
  ]) : null;

  return el("section", { class: "scr hem" }, [
    el("div", { class: "blob blob-a" }), el("div", { class: "blob blob-b" }),
    el("header", { style: "display:flex;flex-direction:column;gap:6px;margin-bottom:8px" }, [
      el("h1", { class: "wordmark", text: "Mölkky", style: "margin:0" }),
      el("p", { class: "tagline", text: "Nummerkubb för hela laget — vi räknar, ni kastar.", style: "margin:0" })
    ]),
    resume,
    el("button", { class: "btn btn-primary btn-block cta-lg", text: "Nytt spel", onClick: () => set({ screen: "nytt" }) }),
    el("button", { class: "btn btn-secondary btn-block cta-md", text: "Spelare", onClick: () => set({ screen: "spelare" }) }),
    el("button", { class: "btn btn-secondary btn-block cta-md", text: "Historik", onClick: () => set({ screen: "historik" }) }),
    el("button", { class: "btn btn-ghost btn-block cta-sm", text: "Inställningar", onClick: () => set({ screen: "installningar" }) })
  ]);
}

/* ---------- Nytt spel ---------- */

function stepper(title, value, dec, inc) {
  return el("div", { class: "stepper" }, [
    el("h4", { text: title }),
    el("div", { class: "row" }, [
      el("button", { text: "−", "aria-label": "Minska " + title, onClick: dec }),
      el("span", { class: "val", text: String(value) }),
      el("button", { text: "+", "aria-label": "Öka " + title, onClick: inc })
    ])
  ]);
}


// Build both score steppers sharing refs so clicking either updates both values
// in-place (no re-render, no rise animation).
function scoreSteppers() {
  const maxVal  = el("span", { class: "val", text: String(state.maxScore) });
  const rstVal  = el("span", { class: "val", text: String(state.resetScore) });
  const update  = () => {
    maxVal.textContent = String(state.maxScore);
    rstVal.textContent = String(state.resetScore);
  };
  const clamp   = () => {
    if (state.resetScore >= state.maxScore) {
      state.resetScore = state.maxScore - 5;
    }
  };
  const mkBtn   = (label, ariaLabel, fn) => el("button", { text: label, "aria-label": ariaLabel,
    onClick: () => { fn(); clamp(); save(); update(); } });
  const maxStepper = el("div", { class: "stepper" }, [
    el("h4", { text: "Maxpoäng" }),
    el("div", { class: "row" }, [
      mkBtn("−", "Minska Maxpoäng",    () => { state.maxScore  = Math.max(20,  state.maxScore  - 5); }),
      maxVal,
      mkBtn("+", "Öka Maxpoäng",       () => { state.maxScore  = Math.min(100, state.maxScore  + 5); })
    ])
  ]);
  const rstStepper = el("div", { class: "stepper" }, [
    el("h4", { text: "Återställning" }),
    el("div", { class: "row" }, [
      mkBtn("−", "Minska Återställning", () => { state.resetScore = Math.max(0, state.resetScore - 5); }),
      rstVal,
      mkBtn("+", "Öka Återställning",    () => { state.resetScore = Math.min(state.maxScore - 5, state.resetScore + 5); })
    ])
  ]);
  return el("div", { class: "steppers" }, [maxStepper, rstStepper]);
}
// Move an entry in state.order from index `from` to index `to`, then persist + re-render.
function reorderOrder(from, to) {
  if (from === to || from == null || to == null) return;
  const order = state.order.slice();
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  set({ order });
}

// Transient drag bookkeeping (not persisted, not part of render state).
const drag = { from: null };

function renderNytt() {
  const enough = state.picked.length >= 2;

  const chips = state.roster.map(({ id, name }) => {
    const on = state.picked.includes(id);
    return el("button", { class: "chip", "aria-pressed": String(on), text: (on ? "● " : "○ ") + name,
      onClick: () => {
        const picked = on ? state.picked.filter(x => x !== id) : state.picked.concat([id]);
        set({ picked, order: picked.slice() });
      } });
  });

  // Clear any drag-over markers left on sibling rows.
  const clearMarkers = () => app.querySelectorAll(".order-row.drag-over, .order-row.drag-over-after")
    .forEach(n => n.classList.remove("drag-over", "drag-over-after"));

  const rows = state.order.map((id, i) => {
    const name = nameById(id);
    const row = el("div", {
      class: "order-row", draggable: "true", "data-index": String(i),
      // ---- HTML5 drag-and-drop (desktop / trackpad) ----
      onDragstart: e => {
        drag.from = i;
        row.classList.add("dragging");
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); }
      },
      onDragover: e => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        const after = e.offsetY > row.offsetHeight / 2;
        clearMarkers();
        row.classList.add(after ? "drag-over-after" : "drag-over");
      },
      onDrop: e => {
        e.preventDefault();
        const from = drag.from;
        const after = e.offsetY > row.offsetHeight / 2;
        let to = i + (after ? 1 : 0);
        if (from < to) to -= 1;         // account for the removed source slot
        clearMarkers();
        reorderOrder(from, to);
      },
      onDragend: () => { drag.from = null; clearMarkers(); row.classList.remove("dragging"); }
    }, [
      el("span", { class: "pos", text: String(i + 1) }),
      el("span", { class: "order-name", text: name }),
      el("span", {
        class: "grip", text: "⠿", "aria-hidden": "true",
        // ---- Pointer Events (touch / iPhone) ----
        onPointerdown: e => {
          if (e.pointerType === "mouse") return;   // let native DnD handle mouse
          e.preventDefault();
          drag.from = i;
          row.classList.add("dragging");
          const grip = e.currentTarget;
          grip.setPointerCapture(e.pointerId);

          const onMove = ev => {
            const under = document.elementFromPoint(ev.clientX, ev.clientY);
            const overRow = under && under.closest(".order-row");
            clearMarkers();
            if (overRow && overRow !== row) {
              const r = overRow.getBoundingClientRect();
              overRow.classList.add(ev.clientY > r.top + r.height / 2 ? "drag-over-after" : "drag-over");
            }
          };
          const onUp = ev => {
            grip.removeEventListener("pointermove", onMove);
            grip.removeEventListener("pointerup", onUp);
            grip.removeEventListener("pointercancel", onCancel);
            const under = document.elementFromPoint(ev.clientX, ev.clientY);
            const overRow = under && under.closest(".order-row");
            const from = drag.from;
            drag.from = null;
            clearMarkers();
            if (overRow && overRow !== row) {
              const to = Number(overRow.getAttribute("data-index"));
              const r = overRow.getBoundingClientRect();
              const after = ev.clientY > r.top + r.height / 2;
              let target = to + (after ? 1 : 0);
              if (from < target) target -= 1;
              reorderOrder(from, target);
            } else {
              row.classList.remove("dragging");
            }
          };
          const onCancel = () => {
            grip.removeEventListener("pointermove", onMove);
            grip.removeEventListener("pointerup", onUp);
            grip.removeEventListener("pointercancel", onCancel);
            drag.from = null;
            clearMarkers();
            row.classList.remove("dragging");
          };
          grip.addEventListener("pointermove", onMove);
          grip.addEventListener("pointerup", onUp);
          grip.addEventListener("pointercancel", onCancel);
        }
      })
    ]);
    return row;
  });

  const whoContent = state.roster.length
    ? el("div", { class: "chips" }, chips)
    : el("div", { class: "panel" }, [
        empty("Inga spelare än — lägg till laget först."),
        el("button", { class: "btn btn-primary btn-block cta-md", text: "Lägg till spelare",
          onClick: () => set({ screen: "spelare" }) })
      ]);

  return el("section", { class: "scr" }, [
    topbar("Nytt spel", () => set({ screen: "hem" })),
    el("div", { class: "body-scroll" }, [
      el("div", { class: "group" }, [label("Vilka är med?"), whoContent]),
      el("div", { class: "group" }, [
        el("div", { class: "group-head" }, [
          label("Turordning"),
          el("button", { class: "btn btn-ghost", style: "min-height:38px;font-size:15px", text: "⟳ Slumpa",
            onClick: () => set({ order: state.order.slice().sort(() => Math.random() - 0.5) }) })
        ]),
        el("div", { class: "panel" }, rows)
      ]),
      scoreSteppers()
    ]),
    el("div", { class: "footer-actions" }, [
      el("button", { class: "btn btn-primary btn-block", style: "min-height:64px;font-size:22px;font-weight:800",
        disabled: !enough, text: "Starta spel",
        onClick: () => enough && set({ game: newGame(), pins: [], banner: null, screen: "spel" }) }),
      el("div", { class: "hint", text: "Välj minst två spelare", style: enough ? "visibility:hidden" : "" })
    ])
  ]);
}

/* ---------- Spel ---------- */

function statusTag(p) {
  if (p.out) return { text: "Utslagen", cls: " is-out" };
  if (p.done) return { text: "🏆 I mål", cls: " is-done" };
  if (p.misses > 0) return { text: p.misses + " bom", cls: "" };
  return null;
}

function renderSpel() {
  const g = state.game;
  if (!g) return renderHem();
  if (g.finished) return renderSlut();
  if (g.roundEndPrompt) return renderRondslut();
  const points = pointsFor(state.pins);
  const cur = g.players[g.turn];
  const b = state.banner;

  const standings = g.players.map((p, i) => {
    const isCur = i === g.turn;
    const tag = statusTag(p);
    return el("div", { class: "st-row" + (p.out ? " is-out" : "") + (isCur ? " is-current" : "") }, [
      el("span", { class: "st-mark", text: isCur ? "▶" : "" }),
      el("span", { class: "st-name", text: p.name }),
      tag ? el("span", { class: "st-tag" + tag.cls, text: tag.text }) : null,
      isCur && points > 0 ? el("span", { class: "st-delta", text: "+" + points }) : null,
      el("span", { class: "st-score", text: String(p.score) })
    ]);
  });

  const pins = PIN_ROWS.map(row => el("div", { class: "pin-row" }, row.map(n => {
    const on = state.pins.includes(n);
    return el("button", { class: "pin", "aria-pressed": String(on), text: String(n),
      onClick: () => set({ pins: on ? state.pins.filter(x => x !== n) : state.pins.concat([n]), banner: null }) });
  })));

  const helper = state.pins.length === 0
    ? "Markera käglorna som föll — ingen markering = bom"
    : state.pins.length === 1
      ? "En kägla · dess siffra ger " + points + " poäng"
      : state.pins.length + " käglor · antalet ger " + points + " poäng";

  return el("section", { class: "scr" }, [
    el("div", { class: "game-top" }, [
      el("div", {}, [
        el("div", { class: "round", text: "Omgång " + g.round }),
        el("div", { class: "game-rules", text: "Mål " + g.max + " p · Retur " + g.reset + " p" })
      ]),
      el("div", { style: "display:flex;align-items:center;gap:10px" }, [
        el("button", { class: "btn btn-ghost", style: "min-height:36px;font-size:15px", text: "Hem", onClick: () => set({ screen: "hem" }) }),
        el("button", { class: "btn btn-secondary", style: "min-height:36px;font-size:15px", text: "Ställning", onClick: () => set({ screen: "stallning" }) })
      ])
    ]),
    // Fixed top zone: who's throwing + pin grid + register button
    el("div", { class: "game-fixed" }, [
      el("div", { class: "turn" }, [
        el("span", { class: "kicker", text: "Tur" }),
        el("span", { class: "name", text: cur.name }),
        el("span", { class: "pts", text: cur.score + " p" })
      ]),
      el("div", { class: "banner" + (b ? " is-shown tone-" + b.tone : "") }, [
        el("span", { style: "font-size:20px", text: b ? b.icon : "" }),
        el("span", { text: b ? b.text : "" })
      ]),
      el("div", { class: "pins" }, pins),
      el("div", { class: "throw-actions" }, [
        el("div", { class: "helper", text: helper }),
        el("div", { class: "throw-row" }, [
          state.pins.length ? el("button", { class: "btn btn-secondary btn-clear", text: "Rensa", onClick: () => set({ pins: [] }) }) : null,
          el("button", { class: "btn btn-primary btn-register",
            text: state.pins.length === 0 ? "Bom" : "Registrera " + points + " poäng",
            onClick: () => registerThrow(points) })
        ]),
        el("button", { class: "btn btn-ghost btn-block btn-undo", text: "↩ Ångra senaste kastet", onClick: undo })
      ])
    ]),
    // Scrollable standings below
    el("div", { class: "game-scroll" }, [
      el("div", { class: "game-scroll-head" }, [
        label("Ställning"),
        el("button", { class: "btn btn-ghost", style: "min-height:34px;font-size:14px", text: "Detaljer →", onClick: () => set({ screen: "stallning" }) })
      ]),
      el("div", { class: "standings" }, standings)
    ])
  ]);
}

/* ---------- Ställning (correct the scoreboard) ---------- */

function renderStallning() {
  const g = state.game;
  if (!g) return renderHem();

  const rows = g.players.map((p, i) => {
    const tag = statusTag(p);
    return el("div", { class: "edit-row" + (p.out ? " is-out" : "") }, [
      el("div", { class: "edit-main" }, [
        el("span", { class: "edit-name", text: p.name }),
        tag ? el("span", { class: "st-tag" + tag.cls, text: tag.text }) : null
      ]),
      el("div", { class: "adj" }, [
        el("button", { text: "−", "aria-label": "Minska poäng för " + p.name,
          onClick: () => editPlayer(i, { score: p.score - 1 }) }),
        el("span", { class: "adj-val", text: String(p.score) }),
        el("button", { text: "+", "aria-label": "Öka poäng för " + p.name,
          onClick: () => editPlayer(i, { score: p.score + 1 }) })
      ]),
      el("button", { class: "row-action", text: p.out ? "Ta in igen" : "Slå ut",
        onClick: () => editPlayer(i, { out: !p.out, misses: p.out ? 0 : 3 }) })
    ]);
  });

  const log = g.log.length ? g.log.slice(0, 12).map(t => el("div", { class: "log-row" }, [
    el("span", { class: "log-round", text: "O" + t.round }),
    el("span", { class: "log-name", text: t.name }),
    el("span", { class: "log-pins", text: t.pins.length ? "kägla " + t.pins.join(", ") : "bom" }),
    logTagEl(t.tag),
    el("span", { class: "log-pts" + (t.points ? "" : " is-zero"), text: (t.points ? "+" + t.points : "0") + " → " + t.score + " p" })
  ])) : [empty("Inga kast registrerade än.")];

  return el("section", { class: "scr" }, [
    topbar("Ställning", () => set({ screen: "spel" })),
    el("div", { class: "body-scroll" }, [
      el("div", { class: "group" }, [
        el("div", { class: "group-head" }, [label("Rätta poängen"), el("span", { class: "note", text: "Max " + g.max + " p" })]),
        el("div", { class: "panel" }, rows)
      ]),
      el("div", { class: "group" }, [
        el("div", { class: "group-head" }, [
          label("Kasthistorik"),
          el("button", { class: "btn btn-ghost", style: "min-height:38px;font-size:15px",
            disabled: !g.history.length, text: "↩ Ångra senaste", onClick: undo })
        ]),
        el("div", { class: "panel" }, log)
      ])
    ]),
    el("div", { class: "footer-actions" }, [
      el("button", { class: "btn btn-primary btn-block", style: "min-height:60px;font-size:20px;font-weight:800",
        text: "Klar", onClick: () => set({ screen: "spel" }) }),
      el("button", { class: "btn btn-ghost btn-block", style: "min-height:46px;font-size:16px", text: "Avsluta spelet",
        onClick: endGameNow })
    ])
  ]);
}

/* ---------- Rondslut (round finished with a winner — play on?) ---------- */

function renderRondslut() {
  const g = state.game;
  if (!g) return renderHem();
  const done = winners(g);
  const remaining = active(g);
  const shared = done.length > 1;

  const doneRows = done.map(p => el("div", { class: "rank-row is-win" }, [
    el("span", { class: "st-mark", style: "width:20px;font-size:18px", text: "🏆" }),
    el("span", { class: "rank-name", text: p.name }),
    el("span", { class: "st-tag is-done", text: "🏆 I mål" }),
    el("span", { class: "rank-score", text: p.score + " p" })
  ]));

  const remRows = remaining.map(p => el("div", { class: "st-row" }, [
    el("span", { class: "st-mark", text: "" }),
    el("span", { class: "st-name", text: p.name }),
    el("span", { class: "st-score", text: String(p.score) })
  ]));

  const heading = shared
    ? done.map(p => p.name).join(" & ") + " är i mål!"
    : done[0].name + " är i mål!";

  return el("section", { class: "scr slut" }, [
    el("div", { class: "blob blob-a" }), el("div", { class: "blob blob-b" }),
    el("div", { class: "body-scroll" }, [
      el("div", { class: "win-card" }, [
        el("div", { class: "eyebrow", text: "Omgången slutspelad" }),
        el("div", { class: "win-name", style: "font-size:34px", text: heading }),
        el("div", { class: "win-sub", text: shared
          ? "Delad vinst så här långt. Vill de återstående spela vidare?"
          : "Vill de återstående spelarna spela vidare?" })
      ]),
      el("div", { class: "group" }, [
        label("I mål"),
        el("div", { class: "panel rank-panel" }, doneRows)
      ]),
      remRows.length ? el("div", { class: "group" }, [
        label("Kvar i spel"),
        el("div", { class: "standings" }, remRows)
      ]) : null
    ]),
    el("div", { class: "footer-actions", style: "background:transparent;position:relative" }, [
      el("button", { class: "btn btn-primary btn-block", style: "min-height:60px;font-size:20px;font-weight:800",
        text: "Spela vidare", onClick: continueGame }),
      el("button", { class: "btn btn-secondary btn-block cta-md", text: "Avsluta spel", onClick: endGameNow }),
      el("button", { class: "btn btn-ghost btn-block", style: "min-height:46px;font-size:16px",
        disabled: !g.history.length, text: "↩ Ångra senaste kastet", onClick: undo })
    ])
  ]);
}

/* ---------- Slut (game over) ---------- */

function renderSlut() {
  const g = state.game;
  if (!g) return renderHem();
  const winIds = (g.winners && g.winners.length) ? g.winners : (g.winner ? [g.winner] : []);
  const winPlayers = winIds.map(id => g.players.find(p => p.id === id)).filter(Boolean);
  const shared = winPlayers.length > 1;
  const winnerName = winPlayers.map(p => p.name).join(" & ") || null;
  const ranked = g.players.slice().sort((a, b) => (b.done - a.done) || (b.score - a.score));

  const rows = ranked.map((p, i) => el("div", { class: "rank-row" + (p.done ? " is-win" : "") }, [
    el("span", { class: "rank-pos", text: String(i + 1) }),
    el("span", { class: "rank-name", text: p.name }),
    p.done ? el("span", { class: "st-tag is-done", text: (g.winners && g.winners.includes(p.id) ? "🏆 " : "") + "I mål" })
      : p.out ? el("span", { class: "st-tag is-out", text: "Utslagen" }) : null,
    el("span", { class: "rank-score", text: p.score + " p" })
  ]));

  return el("section", { class: "scr slut" }, [
    el("div", { class: "blob blob-a" }), el("div", { class: "blob blob-b" }),
    el("div", { class: "body-scroll" }, [
      el("div", { class: "win-card" }, [
        el("div", { class: "eyebrow", text: !winIds.length ? "Spelet avslutat" : shared ? "Delad vinst" : "Vinnare" }),
        el("div", { class: "win-name", text: winnerName || "Ingen vinnare" }),
        el("div", { class: "win-sub", text: winIds.length
          ? (shared ? "Båda nådde " + g.max + " poäng. Grattis!" : "Först till " + g.max + " poäng på " + g.round + " omgångar. Grattis!")
          : "Ingen nådde " + g.max + " poäng den här gången." })
      ]),
      el("div", { class: "group" }, [
        label("Resultat"),
        el("div", { class: "panel rank-panel" }, rows)
      ]),
      g.log.length ? el("div", { class: "group" }, [
        label("Kasthistorik"),
        el("div", { class: "panel" }, g.log.map(t => el("div", { class: "log-row" }, [
          el("span", { class: "log-round", text: "O" + t.round }),
          el("span", { class: "log-name", text: t.name }),
          el("span", { class: "log-pins", text: t.pins.length ? "kägla " + t.pins.join(", ") : "bom" }),
          logTagEl(t.tag),
          el("span", { class: "log-pts" + (t.points ? "" : " is-zero"), text: (t.points ? "+" + t.points : "0") + " → " + t.score + " p" })
        ])))
      ]) : null
    ]),
    el("div", { class: "footer-actions", style: "background:transparent;position:relative" }, [
      el("button", { class: "btn btn-primary btn-block cta-md", text: "Spela igen — samma lag",
        onClick: () => set({ game: newGame(), pins: [], banner: null, screen: "spel" }) }),
      el("button", { class: "btn btn-secondary btn-block cta-md", text: "Nytt spel", onClick: () => set({ screen: "nytt" }) }),
      el("button", { class: "btn btn-ghost btn-block", style: "min-height:46px;font-size:16px", text: "Till start",
        onClick: () => set({ screen: "hem" }) })
    ])
  ]);
}

/* ---------- Spelare ---------- */

function renderSpelare() {
  const startRename = p => set({ renameId: p.id, renameName: p.name, focusKey: "rename" });

  const saveRename = () => {
    const name = state.renameName.trim();
    if (!name) return;
    if (nameTaken(name, state.renameId)) { set({ focusKey: "rename" }); return; }
    set({
      roster: state.roster.map(r => r.id === state.renameId ? { ...r, name } : r),
      renameId: null, renameName: ""
    });
  };

  const removePlayer = p => set({
    roster: state.roster.filter(r => r.id !== p.id),
    picked: state.picked.filter(id => id !== p.id),
    order: state.order.filter(id => id !== p.id),
    renameId: state.renameId === p.id ? null : state.renameId
  });

  const rows = state.roster.length ? state.roster.map(p => {
    if (state.renameId === p.id) {
      const isDup = v => !!(v.trim() && nameTaken(v, p.id));
      const dup = isDup(state.renameName);
      const avatar = el("span", { class: "avatar", text: initials(state.renameName || p.name) });
      const warn = el("span", { class: "p-meta", style: "color:var(--color-accent-700)", text: "Namnet är upptaget" });
      warn.hidden = !dup;
      const saveBtn = el("button", { class: "row-action", text: "Spara", disabled: !!dup || !state.renameName.trim(), onClick: saveRename });
      const input = el("input", { class: "input", type: "text", value: state.renameName, placeholder: "Namn",
        "data-focus": "rename", name: "renameName", autocomplete: "off", maxlength: "18", "aria-invalid": String(!!dup),
        onInput: e => {
          const v = e.target.value;
          setQuiet({ renameName: v });                 // persist without re-render
          const d = isDup(v);
          avatar.textContent = initials(v || p.name);
          e.target.setAttribute("aria-invalid", String(!!d));
          warn.hidden = !d;
          saveBtn.disabled = !!d || !v.trim();
        },
        onKeydown: e => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") set({ renameId: null, renameName: "" }); } });
      return el("div", { class: "p-row" }, [
        avatar,
        el("div", { class: "p-main" }, [input, warn]),
        saveBtn,
        el("button", { class: "row-action is-quiet", text: "Avbryt", onClick: () => set({ renameId: null, renameName: "" }) })
      ]);
    }
    return el("div", { class: "p-row" }, [
      el("span", { class: "avatar", text: initials(p.name) }),
      el("div", { class: "p-main" }, [
        el("span", { class: "p-name", text: p.name }),
        el("span", { class: "p-meta", text: p.games + " spel · " + p.wins + (p.wins === 1 ? " vinst" : " vinster") })
      ]),
      el("button", { class: "row-action", text: "Byt namn", "aria-label": "Byt namn på " + p.name,
        onClick: () => startRename(p) }),
      el("button", { class: "row-action is-quiet", text: "Ta bort", "aria-label": "Ta bort " + p.name,
        onClick: () => removePlayer(p) })
    ]);
  }) : [empty("Inga spelare än — lägg till laget nedan.")];

  const dupNew = state.newName.trim() && nameTaken(state.newName, null);
  const add = () => {
    const name = state.newName.trim();
    if (!name || nameTaken(name, null)) { set({ focusKey: "newName" }); return; }
    set({ roster: state.roster.concat([{ id: uid(), name, games: 0, wins: 0 }]), newName: "", focusKey: "newName" });
  };

  return el("section", { class: "scr" }, [
    topbar("Spelare", () => set({ screen: "hem", renameId: null, renameName: "" })),
    el("div", { class: "body-scroll" }, [
      el("div", { class: "group" }, [
        el("div", { class: "group-head" }, [label("Laget"), el("span", { class: "note", text: state.roster.length + " spelare" })]),
        el("div", { class: "panel" }, rows)
      ]),
      (() => {
        const isDup = v => !!(v.trim() && nameTaken(v, null));
        const addBtn = el("button", { class: "btn btn-primary", style: "min-height:52px;font-size:17px;padding:0 22px",
          text: "Lägg till", disabled: !!dupNew || !state.newName.trim(), onClick: add });
        const warn = el("div", { class: "note", style: "color:var(--color-accent-700)", text: "Namnet är redan upptaget — välj ett unikt namn." });
        warn.hidden = !dupNew;
        const input = el("input", { class: "input", type: "text", placeholder: "Namn", value: state.newName,
          "data-focus": "newName", name: "newName", autocomplete: "off", maxlength: "18", "aria-invalid": String(!!dupNew),
          onInput: e => {
            const v = e.target.value;
            setQuiet({ newName: v });                   // persist without re-render
            const d = isDup(v);
            e.target.setAttribute("aria-invalid", String(!!d));
            warn.hidden = !d;
            addBtn.disabled = !!d || !v.trim();
          },
          onKeydown: e => { if (e.key === "Enter") add(); } });
        return el("div", { class: "group" }, [
          label("Lägg till spelare"),
          el("div", { class: "add-row" }, [input, addBtn]),
          warn
        ]);
      })()
    ])
  ]);
}

/* ---------- Historik ---------- */

function renderHistorik() {
  const cards = state.archive.length ? state.archive.map(a => el("div", { class: "arch-card" }, [
    el("div", { class: "arch-top" }, [
      el("span", { class: "arch-winner", text: a.winnerName ? "🏆 " + a.winnerName : "Ingen vinnare" }),
      el("span", { class: "note", text: dateTimeSv(a.date) })
    ]),
    el("div", { class: "arch-meta", text: "Max " + a.max + " p · " + a.rounds + " omgångar · " + a.players.length + " spelare" }),
    el("div", { class: "arch-scores" }, a.players.slice().sort((x, y) => y.score - x.score).map(p =>
      el("span", { class: "score-chip" + ((a.winners && a.winners.length ? a.winners.includes(p.id) : p.id === a.winner) ? " is-win" : p.out ? " is-out" : ""), text: p.name + " " + p.score })))
  ])) : [empty("Inga färdigspelade matcher än. Vinnare hamnar här automatiskt.")];

  return el("section", { class: "scr" }, [
    topbar("Historik", () => set({ screen: "hem" }),
      state.archive.length ? el("button", { class: "btn btn-ghost", style: "min-height:38px;font-size:15px", text: "Rensa",
        onClick: () => set({ archive: [] }) }) : null),
    el("div", { class: "body-scroll" }, cards)
  ]);
}

/* ---------- Inställningar ---------- */

function toggleRow(title, sub, on, onChange) {
  return el("button", { class: "sw-row", role: "switch", "aria-checked": String(on), onClick: onChange }, [
    el("div", { class: "sw-main" }, [
      el("span", { class: "sw-title", text: title }),
      el("span", { class: "p-meta", text: sub })
    ]),
    el("span", { class: "sw", "aria-hidden": "true" }, [el("span", { class: "sw-knob" })])
  ]);
}

function renderInstallningar() {
  const s = state.settings;
  const flip = k => () => set({ settings: { ...s, [k]: !s[k] } });

  return el("section", { class: "scr" }, [
    topbar("Inställningar", () => set({ screen: "hem" })),
    el("div", { class: "body-scroll" }, [
      el("div", { class: "group" }, [
        label("Standard för nya spel"),
        scoreSteppers()
      ]),
      el("div", { class: "group" }, [
        label("Regler"),
        el("div", { class: "panel" }, [
          toggleRow("Tre bommar slår ut", "Klassisk regel — utan den spelar alla klart.", s.knockout, flip("knockout")),
          toggleRow("Halvera vid bom", "Husregel: poängen halveras i stället för att nollas.", s.halfOnMiss, flip("halfOnMiss"))
        ])
      ]),
      el("div", { class: "group" }, [
        label("Ljud och känsla"),
        el("div", { class: "panel" }, [
          toggleRow("Ljudeffekter", "Litet pling när ett kast registreras.", s.sound, flip("sound")),
          toggleRow("Vibration", "Kort haptisk puff vid markerad kägla.", s.haptics, flip("haptics"))
        ])
      ]),
      el("div", { class: "group" }, [
        label("Data"),
        el("button", { class: "btn btn-secondary btn-block cta-md", text: "Avbryt pågående spel",
          disabled: !state.game, onClick: () => set({ game: null, screen: "hem" }) }),
        el("button", { class: "btn btn-ghost btn-block", style: "min-height:50px;font-size:16px;color:var(--color-accent-700)",
          text: "Rensa all data",
          onClick: () => { if (confirm("Detta raderar alla spelare, historik och pågående spel. Går inte att ångra.")) wipeAllData(); } }),
        el("div", { class: "note", style: "text-align:center", text: "Allt sparas bara på den här enheten (localStorage)." })
      ])
    ])
  ]);
}

load();
if (state.game && state.game.finished) state.game = null;
render();
