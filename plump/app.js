"use strict";

const R = window.PlumpRules;
const STORE_KEY = "plump.v1";
const STORE_VERSION = 1;
const DEFAULT_SETTINGS = {
  startCards: 10,
  shortGame: false,
  manyOnes: true,
  threePlumps: false,
  tenX: true,
  openBid: false
};
const SCREENS = new Set([
  "hem", "nytt", "bud", "spel", "resultat", "protokoll", "slut",
  "spelare", "historik", "regler", "installningar"
]);

const clone = value => JSON.parse(JSON.stringify(value));
const uid = () => "p_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
const gameUid = () => "g_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 9);
const maxStartCards = playerCount => Math.min(10, Math.floor(52 / Math.max(3, playerCount)));
const app = document.getElementById("app");

const state = {
  screen: "hem",
  roster: [],
  picked: [],
  order: [],
  settings: clone(DEFAULT_SETTINGS),
  mode: "total",
  game: null,
  history: [],
  archive: [],
  newName: "",
  formError: ""
};

function validPlayer(player) {
  return player && typeof player.id === "string" && typeof player.name === "string";
}

function normalizeGame(raw) {
  if (!raw || !Array.isArray(raw.players) || raw.players.length < 3) return null;
  const game = clone(raw);
  game.id = typeof game.id === "string" ? game.id : gameUid();
  game.players = game.players.filter(validPlayer).map(player => ({
    id: player.id,
    name: player.name.slice(0, 18),
    score: Number.isFinite(player.score) ? player.score : 0,
    plumps: Number.isFinite(player.plumps) ? player.plumps : 0,
    streak: Number.isFinite(player.streak) ? player.streak : 0
  }));
  if (game.players.length < 3) return null;
  game.settings = { ...DEFAULT_SETTINGS, ...(game.settings || {}) };
  game.settings.startCards = Math.max(3, Math.min(10, Number(game.settings.startCards) || 10));
  const savedDeals = Array.isArray(game.deals)
    ? game.deals.map(Number).filter(cards => cards >= 1 && cards <= 10)
    : [];
  game.deals = savedDeals.length ? savedDeals : R.buildDeals(game.settings, game.players.length);
  game.dealIndex = Math.max(0, Math.min(
    Number(game.dealIndex) || 0,
    game.finished ? game.deals.length : game.deals.length - 1
  ));
  const count = game.players.length;
  game.rows = Array.isArray(game.rows) ? game.rows.filter(row =>
    row && Array.isArray(row.bids) && row.bids.length === count &&
    Array.isArray(row.tricks) && row.tricks.length === count
  ).map((row, rowIndex) => {
    const plump = Array.isArray(row.plump) && row.plump.length === count
      ? row.plump.map(Boolean)
      : row.bids.map((bid, index) => bid !== row.tricks[index]);
    return {
      cards: Number(row.cards) || game.deals[rowIndex] || 1,
      dealer: Number.isInteger(row.dealer) ? row.dealer : rowIndex % count,
      bids: row.bids.map(Number),
      tricks: row.tricks.map(Number),
      pts: Array.isArray(row.pts) && row.pts.length === count ? row.pts.map(Number) : new Array(count).fill(0),
      plump,
      zeroed: Array.isArray(row.zeroed) && row.zeroed.length === count
        ? row.zeroed.map(Boolean)
        : new Array(count).fill(false),
      totals: Array.isArray(row.totals) && row.totals.length === count
        ? row.totals.map(Number)
        : new Array(count).fill(0)
    };
  }) : [];
  game.phase = ["bud", "spel", "resultat"].includes(game.phase) ? game.phase : "bud";
  game.finished = Boolean(game.finished);
  game.archived = Boolean(game.archived);
  game.lastRow = game.phase === "resultat" && game.rows.length
    ? game.rows[game.rows.length - 1]
    : null;
  game.bids = Array.isArray(game.bids) && game.bids.length === count
    ? game.bids.map(bid => bid === null ? null : Number(bid))
    : new Array(count).fill(null);
  game.tricks = Array.isArray(game.tricks) && game.tricks.length === count
    ? game.tricks.map(Number)
    : new Array(count).fill(0);
  game.made = Array.isArray(game.made) && game.made.length === count
    ? game.made.map(value => value === true ? true : value === false ? false : null)
    : new Array(count).fill(null);
  const live = game.live || {};
  game.live = {
    trick: Math.max(1, Number(live.trick) || 1),
    leader: Number.isInteger(live.leader) ? live.leader : null,
    wins: Array.isArray(live.wins) && live.wins.length === count
      ? live.wins.map(value => Math.max(0, Number(value) || 0))
      : new Array(count).fill(0)
  };
  if (game.phase === "resultat" && !game.lastRow) {
    game.phase = game.bids.every(bid => bid !== null) ? "spel" : "bud";
  }
  return game;
}

function normalize() {
  state.settings = { ...DEFAULT_SETTINGS, ...(state.settings || {}) };
  state.settings.startCards = Math.max(3, Math.min(10, Number(state.settings.startCards) || 10));
  Object.keys(DEFAULT_SETTINGS).filter(key => key !== "startCards").forEach(key => {
    state.settings[key] = Boolean(state.settings[key]);
  });
  const seenRosterIds = new Set();
  state.roster = Array.isArray(state.roster) ? state.roster.filter(validPlayer).map(player => ({
    id: player.id,
    name: player.name.trim().slice(0, 18),
    games: Math.max(0, Number(player.games) || 0),
    wins: Math.max(0, Number(player.wins) || 0)
  })).filter(player => {
    if (!player.name || seenRosterIds.has(player.id)) return false;
    seenRosterIds.add(player.id);
    return true;
  }) : [];
  const rosterIds = new Set(state.roster.map(player => player.id));
  state.picked = Array.isArray(state.picked)
    ? [...new Set(state.picked.filter(id => rosterIds.has(id)))].slice(0, 7)
    : [];
  state.order = Array.isArray(state.order)
    ? [...new Set(state.order.filter(id => state.picked.includes(id)))]
    : [];
  state.picked.forEach(id => { if (!state.order.includes(id)) state.order.push(id); });
  state.settings.startCards = Math.min(state.settings.startCards, maxStartCards(state.order.length));
  state.mode = state.mode === "live" ? "live" : "total";
  state.game = normalizeGame(state.game);
  state.history = Array.isArray(state.history) ? state.history.slice(-10) : [];
  state.archive = Array.isArray(state.archive) ? state.archive.filter(entry =>
    entry && typeof entry.id === "string" && Array.isArray(entry.players)).map(entry => ({
      id: entry.id,
      date: typeof entry.date === "string" ? entry.date : new Date(0).toISOString(),
      deals: Math.max(0, Number(entry.deals) || 0),
      winners: Array.isArray(entry.winners) ? entry.winners.filter(id => typeof id === "string") : [],
      winnerName: typeof entry.winnerName === "string" ? entry.winnerName : "",
      players: entry.players.filter(validPlayer).map(player => ({
        id: player.id,
        name: player.name,
        score: Number(player.score) || 0,
        plumps: Math.max(0, Number(player.plumps) || 0),
        win: Boolean(player.win)
      }))
    })) : [];
  if (!SCREENS.has(state.screen)) state.screen = "hem";
  if (["bud", "spel", "resultat", "protokoll", "slut"].includes(state.screen) && !state.game) {
    state.screen = "hem";
  }
  if (state.game && state.game.finished && ["bud", "spel", "resultat"].includes(state.screen)) {
    state.screen = "slut";
  }
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && saved.version === STORE_VERSION && saved.data) Object.assign(state, saved.data);
  } catch (_) {
    // Corrupt or unavailable storage starts clean.
  }
  normalize();
  if (state.game?.finished && !state.game.archived &&
      !state.archive.some(entry => entry.id === state.game.id)) {
    archiveFinishedGame(state.game);
    state.game.archived = true;
    save();
  }
}

function save() {
  const data = {
    screen: state.screen,
    roster: state.roster,
    picked: state.picked,
    order: state.order,
    settings: state.settings,
    mode: state.mode,
    game: state.game,
    history: state.history,
    archive: state.archive
  };
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ version: STORE_VERSION, data }));
  } catch (_) {
    // The app remains usable when storage is unavailable.
  }
}

function setState(change, shouldRender = true) {
  const patch = typeof change === "function" ? change(state) : change;
  if (!patch) return;
  Object.assign(state, patch);
  normalize();
  save();
  if (shouldRender) render();
}

function mutateGame(mutator) {
  if (!state.game || state.game.finished) return;
  const previous = { game: clone(state.game), screen: state.screen };
  const game = clone(state.game);
  const result = mutator(game) || {};
  if (result.abort) return;
  state.history = state.history.slice(-9).concat(previous);
  state.game = game;
  state.screen = result.screen || state.screen;
  normalize();
  save();
  render();
}

function undo() {
  const snapshots = state.history.slice();
  const previous = snapshots.pop();
  if (!previous) return;
  state.game = normalizeGame(previous.game);
  state.screen = previous.screen;
  state.history = snapshots;
  save();
  render();
}

function emptyDeal(count) {
  return {
    bids: new Array(count).fill(null),
    tricks: new Array(count).fill(0),
    made: new Array(count).fill(null),
    live: { trick: 1, leader: null, wins: new Array(count).fill(0) }
  };
}

function createGame(players) {
  const settings = clone(state.settings);
  settings.startCards = Math.min(settings.startCards, maxStartCards(players.length));
  return {
    id: gameUid(),
    players: players.map(player => ({
      id: player.id, name: player.name, score: 0, plumps: 0, streak: 0
    })),
    settings,
    deals: R.buildDeals(settings, players.length),
    dealIndex: 0,
    rows: [],
    ...emptyDeal(players.length),
    phase: "bud",
    finished: false,
    archived: false,
    lastRow: null
  };
}

function startGame() {
  const players = state.order.map(id => state.roster.find(player => player.id === id)).filter(Boolean);
  if (players.length < 3 || players.length > 7) return;
  if (state.game && !state.game.finished &&
      !window.confirm("Starta ett nytt spel? Det pågående spelet avslutas utan att sparas i historiken.")) {
    return;
  }
  setState({ game: createGame(players), history: [], screen: "bud" });
}

function replayGame() {
  if (!state.game) return;
  const players = state.game.players.map(player => ({ id: player.id, name: player.name }));
  setState({
    picked: players.map(player => player.id).filter(id => state.roster.some(r => r.id === id)),
    order: players.map(player => player.id).filter(id => state.roster.some(r => r.id === id)),
    game: createGame(players),
    history: [],
    screen: "bud"
  });
}

function placeBid(value) {
  mutateGame(game => {
    const bidder = R.nextBidder(game);
    const cards = game.deals[game.dealIndex];
    if (bidder < 0 || value < 0 || value > cards || value === R.forbiddenBid(game)) {
      return { abort: true };
    }
    game.bids[bidder] = value;
    if (R.nextBidder(game) < 0) {
      game.phase = "spel";
      game.live.leader = (R.dealerIndex(game) + 1) % game.players.length;
      return { screen: "spel" };
    }
    return {};
  });
}

function pushRow(game) {
  const row = R.applyRow(game.players, {
    cards: game.deals[game.dealIndex],
    dealer: R.dealerIndex(game),
    bids: game.bids,
    tricks: game.tricks,
    made: game.made
  }, game.settings);
  game.rows.push(row);
  game.lastRow = row;
  game.phase = "resultat";
}

function tapWinner(index) {
  mutateGame(game => {
    const cards = game.deals[game.dealIndex];
    if (game.live.trick > cards) return { abort: true };
    game.live.wins[index] += 1;
    game.live.leader = index;
    game.live.trick += 1;
    if (game.live.trick > cards) {
      game.tricks = game.live.wins.slice();
      pushRow(game);
      return { screen: "resultat" };
    }
    return {};
  });
}

function setMade(index, value) {
  mutateGame(game => {
    game.made[index] = game.made[index] === value ? null : value;
  });
}

function finishTotal() {
  if (!state.game || !R.totalStatus(state.game).ok) return;
  mutateGame(game => {
    game.tricks = R.tricksFromMade(game).tricks;
    pushRow(game);
    return { screen: "resultat" };
  });
}

function archiveFinishedGame(game) {
  if (state.archive.some(entry => entry.id === game.id)) return;
  const winners = R.winnerIds(game.players);
  const entry = {
    id: game.id,
    date: new Date().toISOString(),
    deals: game.rows.length,
    winners,
    winnerName: winners.map(id => game.players.find(player => player.id === id)?.name)
      .filter(Boolean).join(" & "),
    players: R.standings(game.players).map(player => ({
      id: player.id,
      name: player.name,
      score: player.score,
      plumps: player.plumps,
      win: winners.includes(player.id)
    }))
  };
  state.archive = [entry, ...state.archive.filter(item => item.id !== game.id)];
  state.roster = state.roster.map(player => {
    if (!game.players.some(gamePlayer => gamePlayer.id === player.id)) return player;
    return {
      ...player,
      games: player.games + 1,
      wins: player.wins + (winners.includes(player.id) ? 1 : 0)
    };
  });
}

function finishGame() {
  if (!state.game) return;
  const game = clone(state.game);
  if (!game.finished) {
    game.finished = true;
    game.phase = "resultat";
    archiveFinishedGame(game);
  }
  game.archived = true;
  state.game = game;
  state.screen = "slut";
  state.history = [];
  save();
  render();
}

function nextDeal() {
  if (!state.game) return;
  if (state.game.dealIndex + 1 >= state.game.deals.length) {
    finishGame();
    return;
  }
  mutateGame(game => {
    game.dealIndex += 1;
    Object.assign(game, emptyDeal(game.players.length));
    game.phase = "bud";
    game.lastRow = null;
    return { screen: "bud" };
  });
}

function confirmFinishEarly() {
  if (!state.game || state.game.finished) return;
  if (window.confirm("Avsluta spelet nu? Resultatet efter spelade givar sparas i historiken.")) {
    finishGame();
  }
}

function navigate(screen) {
  if (!SCREENS.has(screen)) return;
  setState({ screen });
}

function resume() {
  if (!state.game) return;
  navigate(state.game.finished ? "slut" : state.game.phase);
}

function el(tag, props, children) {
  const node = document.createElement(tag);
  const properties = props || {};
  Object.entries(properties).forEach(([key, value]) => {
    if (value === null || value === undefined || value === false) return;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "disabled") node.disabled = Boolean(value);
    else if (key === "value") node.value = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  });
  const list = Array.isArray(children) ? children : children == null ? [] : [children];
  list.flat(Infinity).forEach(child => {
    if (child === null || child === undefined || child === false) return;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return node;
}

const div = (className, children, props) => el("div", { class: className, ...(props || {}) }, children);
const text = (tag, className, value) => el(tag, { class: className, text: value });
const btn = (label, className, onClick, props) =>
  el("button", { type: "button", class: className, text: label, onClick, ...(props || {}) });

function topbar(title, back, trailing) {
  return div("topbar", [
    back ? btn("‹", "back", back, { "aria-label": "Tillbaka" }) : null,
    text("h1", "screen-title", title),
    trailing || null
  ]);
}

function group(label, content, note) {
  return div("group", [
    div("group-head", [text("div", "label", label), note ? text("span", "note", note) : null]),
    content
  ]);
}

function footer(children) {
  return div("footer", children);
}

function cardsFan() {
  return div("card-fan", [
    div("playing-card", [
      text("span", "card-corner", "A♦"), text("span", "", "♦"),
      text("span", "card-corner bottom", "A♦")
    ]),
    div("playing-card", [
      text("span", "card-corner", "K♠"), text("span", "", "♚"),
      text("span", "card-corner bottom", "K♠")
    ]),
    div("playing-card", [text("span", "card-corner", "●"), text("span", "", "●")])
  ]);
}

function renderHem() {
  const active = state.game && !state.game.finished;
  return el("section", { class: "screen hem" }, [
    div("blob blob-a"), div("blob blob-b"), cardsFan(),
    el("header", {}, [
      text("h1", "wordmark", "Plump"),
      text("p", "tagline", "Bjud, ta dina stick — vi håller protokollet.")
    ]),
    active ? div("resume-card", [
      text("div", "eyebrow", "Pågående spel · giv " +
        (state.game.dealIndex + 1) + " av " + state.game.deals.length),
      text("div", "roster-line", state.game.players.map(player => player.name).join(", ")),
      btn("Fortsätt spel", "btn btn-primary btn-block cta-md", resume)
    ]) : null,
    btn("Nytt spel", "btn btn-primary btn-block cta-lg", () => navigate("nytt")),
    btn("Spelare", "btn btn-secondary btn-block cta-md", () => navigate("spelare")),
    btn("Historik", "btn btn-secondary btn-block cta-md", () => navigate("historik")),
    btn("Regler", "btn btn-secondary btn-block cta-md", () => navigate("regler")),
    btn("Inställningar", "btn btn-ghost btn-block cta-md", () => navigate("installningar"))
  ]);
}

function togglePicked(id) {
  const selected = state.picked.includes(id);
  if (!selected && state.picked.length >= 7) {
    state.formError = "Högst sju spelare kan vara med.";
    render();
    return;
  }
  const picked = selected ? state.picked.filter(value => value !== id) : [...state.picked, id];
  const order = state.order.filter(value => picked.includes(value));
  picked.forEach(value => { if (!order.includes(value)) order.push(value); });
  setState({ picked, order, formError: "" });
}

function movePlayer(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.order.length) return;
  const order = state.order.slice();
  [order[index], order[target]] = [order[target], order[index]];
  setState({ order });
}

function shufflePlayers() {
  const order = state.order.slice();
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  setState({ order });
}

function settingSwitch(key, title, subtitle) {
  const on = Boolean(state.settings[key]);
  const control = btn("", "switch-row", () => {
    setState({ settings: { ...state.settings, [key]: !state.settings[key] } });
  }, {
    role: "switch",
    "aria-checked": String(on),
    "aria-label": title
  });
  control.append(
    div("switch-main", [
    text("span", "switch-title", title),
    text("span", "note", subtitle)
    ]),
    div("switch")
  );
  return control;
}

function renderNytt() {
  const selected = new Set(state.picked);
  const chips = state.roster.map(player =>
    btn((selected.has(player.id) ? "✓ " : "○ ") + player.name, "chip",
      () => togglePicked(player.id), { "aria-pressed": String(selected.has(player.id)) }));
  const orderRows = state.order.map((id, index) => {
    const player = state.roster.find(item => item.id === id);
    return div("order-row", [
      text("span", "position", String(index + 1)),
      text("span", "order-name", player ? player.name : "?"),
      index === 0 ? text("span", "tag", "Delar först") : null,
      btn("▲", "move", () => movePlayer(index, -1), {
        disabled: index === 0,
        "aria-label": "Flytta " + (player?.name || "") + " upp"
      }),
      btn("▼", "move", () => movePlayer(index, 1), {
        disabled: index === state.order.length - 1,
        "aria-label": "Flytta " + (player?.name || "") + " ned"
      })
    ]);
  });
  const settings = state.settings;
  const maxCards = maxStartCards(state.order.length);
  const deals = R.buildDeals(settings, Math.max(3, state.order.length));
  const sequence = settings.startCards + " → 1";
  const variants = div("panel", [
    settingSwitch("manyOnes", "Flera 1-givar", "En giv med ett kort per spelare i rad."),
    settingSwitch("threePlumps", "Tre plumpar i rad", "Nollställer spelarens poäng."),
    settingSwitch("tenX", "10× för samtliga stick", "Alla stick ger kort × 10 poäng."),
    settingSwitch("openBid", "Öppet bud", "Visas som valt; buden registreras i turordning.")
  ]);
  return el("section", { class: "screen" }, [
    topbar("Nytt spel", () => navigate("hem")),
    div("body", [
      group("Vilka är med?", div("chips", chips), state.picked.length + " valda"),
      !state.roster.length ? div("empty", [
        "Lägg först till minst tre spelare.",
        btn("Hantera spelare", "btn btn-ghost btn-block", () => navigate("spelare"))
      ]) : null,
      group("Turordning", div("", [
        div("group-head", [
          text("span", "note", "Första spelaren delar först."),
          btn("⟳ Slumpa", "btn btn-ghost", shufflePlayers, { disabled: state.order.length < 2 })
        ]),
        div("panel", orderRows),
        text("div", "note", "Den som sitter efter den som delar bjuder först. Den som delar bjuder sist och får ta smällen.")
      ])),
      group("Spelets längd", div("", [
        div("length-grid", [
          div("length-card", [
            text("h3", "", "Kort i första given"),
            div("step", [
              btn("−", "", () => setState({ settings: { ...state.settings,
                startCards: Math.max(3, state.settings.startCards - 1) } }), {
                disabled: settings.startCards <= 3, "aria-label": "Färre kort"
              }),
              el("output", { text: settings.startCards, "aria-label": "Kort i första given" }),
              btn("+", "", () => setState({ settings: { ...state.settings,
                startCards: Math.min(maxCards, state.settings.startCards + 1) } }), {
                disabled: settings.startCards >= maxCards, "aria-label": "Fler kort"
              })
            ])
          ]),
          div("length-card", [
            text("h3", "", "Kortföljd"),
            btn(sequence + " → " + settings.startCards, "sequence",
              () => setState({ settings: { ...state.settings, shortGame: false } }),
              { "aria-pressed": String(!settings.shortGame) }),
            btn(sequence, "sequence",
              () => setState({ settings: { ...state.settings, shortGame: true } }),
              { "aria-pressed": String(settings.shortGame) })
          ])
        ]),
        text("div", "note", deals.length + " givar · " +
          (settings.shortGame ? sequence : sequence + " → " + settings.startCards) +
          " kort" + (settings.manyOnes ? " samt en 1-giv per spelare" : ""))
      ])),
      group("Varianter", variants, "gäller detta spel"),
      text("div", "note", "Ändringarna sparas som standard för nästa spel."),
      state.formError ? text("div", "form-error", state.formError) : null
    ]),
    footer([
      btn("Starta spel", "btn btn-primary btn-block cta-main", startGame, {
        disabled: state.picked.length < 3 || state.picked.length > 7
      }),
      state.picked.length < 3 ? text("div", "helper", "Välj minst tre spelare") : null
    ])
  ]);
}

function gameTopbar() {
  const game = state.game;
  const cards = game.deals[game.dealIndex];
  const dealer = game.players[R.dealerIndex(game)];
  return div("topbar compact", [
    div("topbar-main", [
      text("div", "game-title", "Giv " + (game.dealIndex + 1) + " av " + game.deals.length),
      text("div", "game-sub", cards + " kort · " + dealer.name + " delar")
    ]),
    div("top-actions", [
      btn("Hem", "btn btn-ghost", () => navigate("hem")),
      btn("Protokoll", "btn btn-secondary", () => navigate("protokoll"))
    ])
  ]);
}

function renderBud() {
  const game = state.game;
  const cards = game.deals[game.dealIndex];
  const dealer = R.dealerIndex(game);
  const bidder = R.nextBidder(game);
  const sum = R.bidSum(game);
  const forbidden = R.forbiddenBid(game);
  const queue = R.bidQueue(game);
  const keys = [];
  for (let value = 0; value <= cards; value += 1) {
    const blocked = value === forbidden || bidder < 0;
    keys.push(btn(String(value), "key" + (blocked ? " forbidden" : ""),
      () => placeBid(value), {
        disabled: blocked,
        "aria-label": blocked ? value + " är inte tillåtet" : "Bjud " + value
      }));
  }
  const player = bidder >= 0 ? game.players[bidder] : null;
  const warning = forbidden >= 0 && forbidden <= cards;
  const rows = game.players.map((item, index) => div("list-row", [
    text("span", "marker", index === bidder ? "▶" : ""),
    text("span", "row-name", item.name),
    index === dealer ? text("span", "tag dealer", "Delar") : null,
    index === (dealer + 1) % game.players.length ? text("span", "tag", "Första bud") : null,
    text("span", "bid-value", game.bids[index] === null ? "–" : String(game.bids[index]))
  ]));
  return el("section", { class: "screen" }, [
    gameTopbar(),
    div("bid-fixed", [
      div("bidder", [
        div("bidder-main", [
          text("span", "eyebrow", "Bud"),
          text("span", "bidder-name", player ? player.name : "Alla har bjudit"),
          text("span", "bidder-meta", player
            ? bidder === dealer ? "Delar — bjuder sist" : "Bjuder " + (queue.indexOf(bidder) + 1) + " av " + game.players.length
            : "Dela ut korten och spela")
        ]),
        text("span", "bidder-score", player ? player.score + " p" : "")
      ]),
      game.settings.openBid ? text("div", "open-rule", "Öppet bud valt · registrera allas visade bud i turordning") : null,
      div("keypad", keys),
      text("div", "status" + (warning ? " warn" : ""), warning
        ? game.players[dealer].name + " kan inte bjuda " + forbidden + " — summan får inte bli " + cards
        : "Bjudet hittills: " + sum + " av " + cards + " stick")
    ]),
    div("bid-scroll", [
      text("div", "label", "Budrunda"),
      div("panel", rows)
    ]),
    footer([
      btn("↩ Ångra senaste budet", "btn btn-ghost btn-block", undo, {
        disabled: state.history.length === 0
      })
    ])
  ]);
}

function modeTabs() {
  return div("mode-tabs", [
    btn("Stick för stick", "mode-tab", () => setState({ mode: "live" }), {
      "aria-pressed": String(state.mode === "live")
    }),
    btn("Räkna in totalt", "mode-tab", () => setState({ mode: "total" }), {
      "aria-pressed": String(state.mode === "total")
    })
  ]);
}

function renderLivePlay() {
  const game = state.game;
  const cards = game.deals[game.dealIndex];
  const leader = game.live.leader === null
    ? (R.dealerIndex(game) + 1) % game.players.length
    : game.live.leader;
  const buttons = game.players.map((player, index) =>
    btn("", "winner-button" + (index === leader ? " leader" : ""), () => tapWinner(index), {
      "aria-label": player.name + " tog sticket"
    }).appendChild(text("strong", "", player.name))?.parentNode);
  buttons.forEach((button, index) => {
    const player = game.players[index];
    button.append(
      text("small", "", "bud " + game.bids[index] + (index === leader ? " · utspel" : "")),
      el("output", { text: game.live.wins[index], "aria-label": game.live.wins[index] + " tagna stick" })
    );
  });
  return div("play-area", [
    div("live-banner", [
      div("", [
        text("div", "live-kicker", "Stick " + Math.min(game.live.trick, cards) + " av " + cards),
        text("div", "live-name", "Utspel: " + game.players[leader].name)
      ]),
      text("div", "live-left", (cards - game.live.trick + 1) + " stick kvar")
    ]),
    text("div", "label", "Vem tog sticket?"),
    div("winner-buttons", buttons),
    div("play-footer", [
      text("div", "helper", "Tryck på den som tog sticket — hen spelar ut nästa."),
      btn("↩ Ångra senaste sticket", "btn btn-ghost btn-block", undo, {
        disabled: state.history.length === 0
      })
    ])
  ]);
}

function renderTotalPlay() {
  const game = state.game;
  const cards = game.deals[game.dealIndex];
  const rows = game.players.map((player, index) => {
    const answer = game.made[index];
    return div("count-row", [
      div("count-main", [
        text("strong", "", player.name),
        text("small", "", "bud " + game.bids[index] + " · " +
          (answer === false ? "plump" : player.score + " p"))
      ]),
      btn("Tog " + game.bids[index], "choice made", () => setMade(index, true), {
        "aria-pressed": String(answer === true)
      }),
      btn("Plump", "choice plump", () => setMade(index, false), {
        "aria-pressed": String(answer === false)
      })
    ]);
  });
  const status = R.totalStatus(game);
  return div("play-area", [
    div("play-scroll", [
      div("group-head", [
        text("div", "label", "Klarade budet?"),
        text("span", "note", "Bjudet: " + R.bidSum(game) + " av " + cards)
      ]),
      div("panel", rows)
    ]),
    div("play-footer", [
      text("div", "status" + (status.ok ? " good" : ""), status.text),
      btn("Räkna ut given", "btn btn-primary btn-block cta-main", finishTotal, {
        disabled: !status.ok
      }),
      btn("↩ Ångra senaste ändringen", "btn btn-ghost btn-block", undo, {
        disabled: state.history.length === 0
      })
    ])
  ]);
}

function renderSpel() {
  return el("section", { class: "screen" }, [
    gameTopbar(),
    modeTabs(),
    state.mode === "live" ? renderLivePlay() : renderTotalPlay()
  ]);
}

function renderResultat() {
  const game = state.game;
  const row = game.lastRow;
  if (!row) {
    state.screen = game.phase;
    return render();
  }
  const made = row.plump.filter(value => !value).length;
  const plumpNames = game.players.filter((_, index) => row.plump[index]).map(player => player.name);
  const zeroed = game.players.filter((_, index) => row.zeroed[index]).map(player => player.name);
  const rows = game.players.map((player, index) => div("result-row", [
    text("span", "row-name", player.name),
    text("span", "result-detail", "bud " + row.bids[index] + " · " +
      (row.tricks[index] < 0 ? "annat antal" : row.tricks[index] + " stick")),
    text("span", "gain" + (row.plump[index] ? " plumped" : ""),
      row.plump[index] ? "● plump" : "+" + row.pts[index]),
    text("span", "score-value", String(row.totals[index]))
  ]));
  const isLast = game.dealIndex + 1 >= game.deals.length;
  return el("section", { class: "screen result-screen" }, [
    div("blob blob-a"),
    topbar("Giv " + game.rows.length + " klar"),
    div("body", [
      div("summary-card", [
        text("div", "eyebrow", "Given slutspelad"),
        text("div", "summary-title", row.cards + " kort · " + made + " av " +
          game.players.length + " klarade budet"),
        text("div", "summary-sub", plumpNames.length
          ? "Plump för " + plumpNames.join(", ") + "."
          : "Ingen plump den här given — ovanligt!")
      ]),
      group("Givens poäng", div("panel", rows)),
      text("div", "note", zeroed.length
        ? zeroed.join(", ") + " fick tre plumpar i rad — poängen nollställd."
        : "Rätt bud ger 10 poäng plus 1 per taget stick.")
    ]),
    footer([
      btn(isLast ? "Avsluta spelet" : "Nästa giv — " + game.deals[game.dealIndex + 1] + " kort",
        "btn btn-primary btn-block cta-main", nextDeal),
      btn("Protokoll", "btn btn-secondary btn-block cta-md", () => navigate("protokoll")),
      btn("↩ Ångra given", "btn btn-ghost btn-block", undo, {
        disabled: state.history.length === 0
      })
    ])
  ]);
}

function rankRows(players, winners) {
  return R.standings(players).map((player, index) => div("rank-row", [
    text("span", "rank" + (winners?.includes(player.id) ? " winner" : ""), String(index + 1)),
    text("span", "row-name", player.name),
    text("span", "rank-meta", player.plumps + (player.plumps === 1 ? " plump" : " plumpar")),
    text("span", "score-value", String(player.score))
  ]));
}

function renderProtokoll() {
  const game = state.game;
  const columns = "72px repeat(" + game.players.length + ", 62px)";
  const grid = div("protocol", [], { style: "grid-template-columns:" + columns });
  grid.append(
    div("proto-cell proto-head proto-label", ["Giv"]),
    ...game.players.map(player => div("proto-cell proto-head", [player.name]))
  );
  game.deals.forEach((cards, dealIndex) => {
    const row = game.rows[dealIndex];
    const current = !game.finished && dealIndex === game.dealIndex;
    grid.append(div("proto-cell proto-label" + (current ? " current" : ""), [
      text("span", "proto-top", "Giv " + (dealIndex + 1)),
      text("span", "proto-main", cards + " kort")
    ]));
    game.players.forEach((_, playerIndex) => {
      if (row) {
        grid.append(div("proto-cell", [
          text("span", "proto-top", row.bids[playerIndex] + "/" +
            (row.tricks[playerIndex] < 0 ? "–" : row.tricks[playerIndex])),
          text("span", "proto-main", row.plump[playerIndex] ? "●" : String(row.pts[playerIndex]))
        ]));
      } else {
        grid.append(div("proto-cell" + (current ? " proto-current" : ""), [
          text("span", "proto-top", current && game.bids[playerIndex] !== null
            ? "bud " + game.bids[playerIndex] : ""),
          text("span", "proto-open", current ? "nu" : "")
        ]));
      }
    });
  });
  grid.append(div("proto-cell proto-label proto-total", [
    text("span", "label", "Totalt")
  ]));
  game.players.forEach(player => grid.append(div("proto-cell proto-total", [
    text("span", "proto-top", player.plumps + (player.plumps === 1 ? " plump" : " plumpar")),
    text("span", "score-value", String(player.score))
  ])));
  return el("section", { class: "screen" }, [
    div("topbar", [
      btn("‹", "back", () => navigate(game.finished ? "slut" : game.phase), { "aria-label": "Tillbaka" }),
      text("h1", "screen-title", "Protokoll"),
      text("span", "note", game.rows.length + " av " + game.deals.length + " givar")
    ]),
    div("body protocol-body", [
      div("protocol-wrap", [grid]),
      group("Ställning", div("panel", rankRows(game.players))),
      text("div", "note", "Varje ruta visar bud/stick och poängen. ● = plump. Vid lika poäng vinner den med minst plumpar.")
    ]),
    footer([
      btn(game.finished ? "Till resultatet" : "Tillbaka till given",
        "btn btn-primary btn-block cta-md", () => navigate(game.finished ? "slut" : game.phase)),
      !game.finished ? btn("Avsluta spelet", "btn btn-ghost btn-block", confirmFinishEarly) : null,
      !game.finished ? btn("↩ Ångra senaste ändringen", "btn btn-ghost btn-block", undo, {
        disabled: state.history.length === 0
      }) : null
    ])
  ]);
}

function renderSlut() {
  const game = state.game;
  const ranked = R.standings(game.players);
  const winners = R.winnerIds(game.players);
  const winnerPlayers = winners.map(id => game.players.find(player => player.id === id));
  const top = ranked[0];
  return el("section", { class: "screen finish" }, [
    div("blob blob-a"), div("blob blob-b"),
    div("body", [
      div("win-card", [
        text("div", "eyebrow", winners.length > 1 ? "Delad vinst" : "Vinnare"),
        text("div", "win-name", winnerPlayers.map(player => player.name).join(" & ")),
        text("div", "win-sub", winners.length > 1
          ? "Lika poäng och lika många plumpar efter " + game.rows.length + " givar. Grattis!"
          : top.score + " poäng på " + game.rows.length + " givar med " + top.plumps +
            (top.plumps === 1 ? " plump" : " plumpar") + ". Grattis!")
      ]),
      group("Resultat", div("panel", rankRows(game.players, winners)))
    ]),
    footer([
      btn("Spela igen — samma lag", "btn btn-primary btn-block cta-main", replayGame),
      btn("Visa protokollet", "btn btn-secondary btn-block cta-md", () => navigate("protokoll")),
      btn("Till start", "btn btn-ghost btn-block", () => navigate("hem"))
    ])
  ]);
}

function addPlayer() {
  const name = state.newName.trim();
  if (!name) return;
  if (state.roster.some(player => player.name.toLocaleLowerCase("sv") === name.toLocaleLowerCase("sv"))) {
    setState({ formError: "Det finns redan en spelare med det namnet." });
    return;
  }
  const player = { id: uid(), name: name.slice(0, 18), games: 0, wins: 0 };
  const picked = state.picked.length < 7 ? [...state.picked, player.id] : state.picked;
  const order = state.picked.length < 7 ? [...state.order, player.id] : state.order;
  setState({ roster: [...state.roster, player], picked, order, newName: "", formError: "" });
}

function removePlayer(id) {
  const player = state.roster.find(item => item.id === id);
  if (!player) return;
  setState({
    roster: state.roster.filter(item => item.id !== id),
    picked: state.picked.filter(item => item !== id),
    order: state.order.filter(item => item !== id)
  });
}

function renderSpelare() {
  const rows = state.roster.map(player => div("player-row", [
    text("span", "avatar", player.name.slice(0, 1).toLocaleUpperCase("sv")),
    div("player-main", [
      text("div", "player-name", player.name),
      text("div", "player-meta", player.games + " spel · " + player.wins +
        (player.wins === 1 ? " vinst" : " vinster"))
    ]),
    btn("Ta bort", "row-action", () => removePlayer(player.id), {
      "aria-label": "Ta bort " + player.name
    })
  ]));
  const input = el("input", {
    class: "input",
    value: state.newName,
    maxlength: "18",
    placeholder: "Namn",
    "aria-label": "Spelarens namn",
    onInput: event => {
      state.newName = event.target.value;
      state.formError = "";
      save();
      const add = document.getElementById("add-player");
      if (add) add.disabled = !state.newName.trim();
    },
    onKeydown: event => { if (event.key === "Enter") addPlayer(); }
  });
  return el("section", { class: "screen" }, [
    topbar("Spelare", () => navigate("hem")),
    div("body", [
      group("Laget", rows.length ? div("panel", rows) : div("empty", ["Inga spelare ännu."]),
        state.roster.length + " spelare"),
      group("Lägg till spelare", div("", [
        div("add-row", [
          input,
          btn("Lägg till", "btn btn-primary", addPlayer, {
            id: "add-player", disabled: !state.newName.trim()
          })
        ]),
        text("div", "form-error", state.formError),
        text("div", "note", "3–7 spelare fungerar; 4–5 är bäst.")
      ]))
    ])
  ]);
}

function formatDate(iso) {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      day: "numeric", month: "short", year: "numeric"
    }).format(new Date(iso));
  } catch (_) {
    return "";
  }
}

function clearHistory() {
  if (state.archive.length && window.confirm("Rensa hela spelhistoriken? Spelarstatistiken behålls.")) {
    setState({ archive: [] });
  }
}

function renderHistorik() {
  const cards = state.archive.map(entry => div("archive-card", [
    div("archive-head", [
      text("span", "archive-winner", entry.winnerName ? "🏆 " + entry.winnerName : "Ingen vinnare"),
      text("span", "archive-date", formatDate(entry.date))
    ]),
    text("div", "note", entry.deals + " givar · " + entry.players.length + " spelare"),
    div("score-chips", entry.players.map(player =>
      text("span", "score-chip" + (player.win ? " winner" : ""), player.name + " " + player.score)))
  ]));
  return el("section", { class: "screen" }, [
    topbar("Historik", () => navigate("hem"),
      btn("Rensa", "btn btn-ghost", clearHistory, { disabled: !state.archive.length })),
    div("body", cards.length ? cards : [div("empty", ["Inga avslutade spel ännu."])])
  ]);
}

function ruleBlock(title, copy) {
  return div("rule-block", [text("h3", "", title), text("p", "", copy)]);
}

function renderRegler() {
  const deals = R.buildDeals({ startCards: 10, shortGame: false, manyOnes: false }, 5);
  return el("section", { class: "screen" }, [
    topbar("Regler", () => navigate("hem")),
    div("body", [
      group("Det du behöver", div("panel settings-card", [
        text("p", "rule-text", "Vanlig kortlek (52 kort) och 3–7 spelare — bäst med 4–5. Appen sköter protokollet.")
      ])),
      group("Så spelas en giv", div("panel rules-panel", [
        ruleBlock("1. Ge kort", "Dela medsols, ett kort i taget, tills alla har lika många som givens antal. Resten läggs åt sidan. Givaren roterar medsols."),
        ruleBlock("2. Budgivning", "Spelaren till vänster om givaren börjar, sedan medsols. Var och en säger hur många stick hen tänker ta (0 är tillåtet). Summan av buden får inte bli lika med antalet stick — givaren bjuder sist och får ibland ta smällen. Det garanterar att någon plumpar."),
        ruleBlock("3. Spela", "Den till vänster om givaren spelar ut första kortet och bestämmer färgen. Man är färgtvungen — har du färgen måste du följa. Högsta kortet i den spelade färgen tar sticket (ess högst, tvåa lägst) och vinnaren spelar ut nästa."),
        ruleBlock("4. Poäng", "Exakt som budet ger 10 poäng plus 1 per taget stick — bud 3 och 3 stick ger 13. Rätt bud på 0 ger 10 poäng. Fler eller färre stick än budet ger 0 poäng och en plump.")
      ])),
      group("Spelets gång", div("panel settings-card", [
        text("p", "rule-text", "Ett spel är oftast 19 givar: 10 kort i första given, sedan 9, 8 … ner till 1 och därefter upp till 10 igen."),
        div("deal-chips", deals.map(cards =>
          text("span", "deal-chip" + (cards === 1 ? " one" : ""), String(cards)))),
        text("p", "rule-text", "Flest poäng när alla givar är spelade vinner. Vid lika poäng vinner den med minst plumpar.")
      ])),
      group("Vanliga varianter", div("panel rules-panel", [
        ruleBlock("Kort spel", "Bara nedåt, 10 → 1, i stället för ner och upp."),
        ruleBlock("Flera 1-givar", "En giv med ett kort är lätt att förutse — spela en 1-giv per spelare i rad i stället för en enda."),
        ruleBlock("Tre plumpar i rad", "Tre plumpar i rad nollställer spelarens poäng."),
        ruleBlock("10× för samtliga stick", "Bjuder du alla stick i given och tar dem får du antal kort × 10 poäng. Gäller inte given med ett kort."),
        ruleBlock("Öppet bud", "Alla bjuder samtidigt med fingrar i stället för i tur och ordning.")
      ])),
      text("div", "note", "Kom överens om varianterna innan ni börjar — de skiljer sig mellan olika sällskap."),
      group("Appen", div("panel rules-panel", [
        ruleBlock("Allt sparas lokalt", "Spelare, historik och pågående spel sparas bara i den här webbläsaren på den här enheten. Ingen inloggning, ingen server."),
        ruleBlock("Ångra och rätta", "Ett fel bud eller stick kan ångras direkt, och en färdig giv kan räknas om från givresultatet.")
      ]))
    ])
  ]);
}

function abortGame() {
  if (!state.game || state.game.finished) return;
  if (window.confirm("Avbryt det pågående spelet? Det sparas inte i historiken.")) {
    setState({ game: null, history: [], screen: "hem" });
  }
}

function wipeAll() {
  if (!window.confirm("Rensa alla spelare, inställningar, pågående spel och all historik?")) return;
  try { localStorage.removeItem(STORE_KEY); } catch (_) {}
  Object.assign(state, {
    screen: "hem",
    roster: [],
    picked: [],
    order: [],
    settings: clone(DEFAULT_SETTINGS),
    mode: "total",
    game: null,
    history: [],
    archive: [],
    newName: "",
    formError: ""
  });
  save();
  render();
}

function renderInstallningar() {
  return el("section", { class: "screen" }, [
    topbar("Inställningar", () => navigate("hem")),
    div("body", [
      group("Kort och varianter", div("panel settings-card", [
        text("p", "", "Antal kort, kortföljd och varianter väljs när ni startar spelet — de senaste valen kommer upp förvalda nästa gång."),
        btn("Till Nytt spel", "btn btn-secondary btn-block", () => navigate("nytt"))
      ])),
      group("Data", div("", [
        btn("Avbryt pågående spel", "btn btn-secondary btn-block cta-md", abortGame, {
          disabled: !state.game || state.game.finished
        }),
        btn("Rensa all data", "btn btn-ghost btn-block cta-md", wipeAll),
        text("div", "helper", "Allt sparas bara på den här enheten.")
      ]))
    ])
  ]);
}

function render() {
  let screen;
  switch (state.screen) {
    case "nytt": screen = renderNytt(); break;
    case "bud": screen = state.game ? renderBud() : renderHem(); break;
    case "spel": screen = state.game ? renderSpel() : renderHem(); break;
    case "resultat": screen = state.game ? renderResultat() : renderHem(); break;
    case "protokoll": screen = state.game ? renderProtokoll() : renderHem(); break;
    case "slut": screen = state.game ? renderSlut() : renderHem(); break;
    case "spelare": screen = renderSpelare(); break;
    case "historik": screen = renderHistorik(); break;
    case "regler": screen = renderRegler(); break;
    case "installningar": screen = renderInstallningar(); break;
    default: screen = renderHem();
  }
  if (screen) app.replaceChildren(screen);
}

load();
render();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./service-worker.js").catch(() => {}));
}
