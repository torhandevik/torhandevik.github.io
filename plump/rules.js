(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PlumpRules = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function buildDeals(settings, playerCount) {
    const deals = [];
    for (let cards = settings.startCards; cards >= 1; cards -= 1) deals.push(cards);
    if (settings.manyOnes) {
      for (let i = 1; i < playerCount; i += 1) deals.push(1);
    }
    if (!settings.shortGame) {
      for (let cards = 2; cards <= settings.startCards; cards += 1) deals.push(cards);
    }
    return deals;
  }

  function pointsFor(bid, tricks, cards, tenX) {
    if (bid !== tricks) return 0;
    if (tenX && cards > 1 && bid === cards) return cards * 10;
    return 10 + tricks;
  }

  function dealerIndex(game) {
    return game.dealIndex % game.players.length;
  }

  function bidQueue(game) {
    const queue = [];
    const dealer = dealerIndex(game);
    for (let i = 1; i <= game.players.length; i += 1) {
      queue.push((dealer + i) % game.players.length);
    }
    return queue;
  }

  function nextBidder(game) {
    return bidQueue(game).find(index => game.bids[index] === null) ?? -1;
  }

  function bidSum(game) {
    return game.bids.reduce((sum, bid) => sum + (bid === null ? 0 : bid), 0);
  }

  function forbiddenBid(game) {
    if (game.bids.filter(bid => bid === null).length !== 1) return -1;
    return game.deals[game.dealIndex] - bidSum(game);
  }

  function tricksFromMade(game) {
    const cards = game.deals[game.dealIndex];
    const tricks = new Array(game.players.length).fill(-1);
    const plumpers = [];
    let taken = 0;
    game.made.forEach((made, index) => {
      if (made === true) {
        tricks[index] = game.bids[index];
        taken += game.bids[index];
      } else {
        plumpers.push(index);
      }
    });
    const rest = cards - taken;
    if (plumpers.length === 1) tricks[plumpers[0]] = rest;
    else if (rest === 0) plumpers.forEach(index => { tricks[index] = 0; });
    return { tricks, rest, plumpers };
  }

  function totalStatus(game) {
    const cards = game.deals[game.dealIndex];
    const open = game.made.filter(value => value === null).length;
    const result = tricksFromMade(game);
    if (open > 0) {
      return {
        ok: false,
        text: open === game.players.length ? "Markera vad var och en tog" : open + " spelare kvar"
      };
    }
    if (result.plumpers.length === 0) {
      return { ok: false, text: "Någon måste ha plumpat — buden kan aldrig summera till " + cards };
    }
    if (result.rest < 0) {
      return {
        ok: false,
        text: "De klarade buden ger " + (cards - result.rest) + " stick — mer än givens " + cards
      };
    }
    if (result.plumpers.length === 1 && result.rest === game.bids[result.plumpers[0]]) {
      const index = result.plumpers[0];
      return {
        ok: false,
        text: game.players[index].name + " får " + result.rest +
          " stick kvar — det är ju budet, inte en plump"
      };
    }
    return {
      ok: true,
      text: result.plumpers.length === 1
        ? game.players[result.plumpers[0]].name + " tog " + result.rest +
          " på ett bud om " + game.bids[result.plumpers[0]]
        : result.plumpers.length + " plumpar delar på " + result.rest + " stick"
    };
  }

  function applyRow(players, row, settings) {
    const points = [];
    const plump = [];
    const zeroed = [];
    players.forEach((player, index) => {
      const made = typeof row.made?.[index] === "boolean"
        ? row.made[index]
        : row.bids[index] === row.tricks[index];
      const gained = made
        ? pointsFor(row.bids[index], row.tricks[index], row.cards, settings.tenX)
        : 0;
      let reset = false;
      if (made) {
        player.score += gained;
        player.streak = 0;
      } else {
        player.plumps += 1;
        player.streak += 1;
        if (settings.threePlumps && player.streak >= 3) {
          player.score = 0;
          player.streak = 0;
          reset = true;
        }
      }
      points.push(gained);
      plump.push(!made);
      zeroed.push(reset);
    });
    return {
      cards: row.cards,
      dealer: row.dealer,
      bids: row.bids.slice(),
      tricks: row.tricks.slice(),
      pts: points,
      plump,
      zeroed,
      totals: players.map(player => player.score)
    };
  }

  function standings(players) {
    return players.slice().sort((a, b) =>
      (b.score - a.score) || (a.plumps - b.plumps) || a.name.localeCompare(b.name, "sv"));
  }

  function winnerIds(players) {
    const ranked = standings(players);
    if (!ranked.length) return [];
    return ranked
      .filter(player => player.score === ranked[0].score && player.plumps === ranked[0].plumps)
      .map(player => player.id);
  }

  return {
    buildDeals,
    pointsFor,
    dealerIndex,
    bidQueue,
    nextBidder,
    bidSum,
    forbiddenBid,
    tricksFromMade,
    totalStatus,
    applyRow,
    standings,
    winnerIds
  };
});
