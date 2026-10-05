const STORAGE_KEY = "responseLog";
const STATISTICS_KEY = "statistics";

function createEmptyStatistics() {
  return {
    fetches: 0,
    playersFound: 0,
    playersBought: 0,
    boughtPriceTotal: 0,
    boughtPriceCount: 0
  };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function getBoughtPrices(entry) {
  const playersBought = toFiniteNumber(entry?.playersBought);

  if (Array.isArray(entry?.boughtPrices)) {
    return entry.boughtPrices;
  }

  return playersBought > 0 && Array.isArray(entry?.bidPrices)
    ? entry.bidPrices.slice(0, playersBought)
    : [];
}

function addEntryToStatistics(statistics, entry) {
  statistics.fetches += 1;
  statistics.playersFound += toFiniteNumber(entry?.playersFound);
  statistics.playersBought += toFiniteNumber(entry?.playersBought);

  for (const price of getBoughtPrices(entry)) {
    const numericPrice = Number(price);
    if (Number.isFinite(numericPrice)) {
      statistics.boughtPriceTotal += numericPrice;
      statistics.boughtPriceCount += 1;
    }
  }
}

function calculateStatistics(entries) {
  return entries.reduce((statistics, entry) => {
    addEntryToStatistics(statistics, entry);
    return statistics;
  }, createEmptyStatistics());
}

export function createLogger({ notify }) {
  let entries = [];
  let statistics = createEmptyStatistics();

  function setEntries(storedEntries) {
    entries = Array.isArray(storedEntries)
      ? storedEntries.filter((entry) => entry?.activity === "fetch-summary")
      : [];
    statistics = calculateStatistics(entries);
  }

  function setStatistics(storedStatistics) {
    if (!storedStatistics || typeof storedStatistics !== "object") {
      return;
    }

    const fallback = calculateStatistics(entries);
    const boughtPriceCount = Number(storedStatistics.boughtPriceCount);
    const boughtPriceTotal = Number(storedStatistics.boughtPriceTotal);

    statistics = {
      fetches: Number.isFinite(Number(storedStatistics.fetches))
        ? Number(storedStatistics.fetches)
        : fallback.fetches,
      playersFound: Number.isFinite(Number(storedStatistics.playersFound))
        ? Number(storedStatistics.playersFound)
        : fallback.playersFound,
      playersBought: Number.isFinite(Number(storedStatistics.playersBought))
        ? Number(storedStatistics.playersBought)
        : fallback.playersBought,
      boughtPriceTotal: Number.isFinite(boughtPriceTotal)
        ? boughtPriceTotal
        : fallback.boughtPriceTotal,
      boughtPriceCount: Number.isFinite(boughtPriceCount)
        ? boughtPriceCount
        : fallback.boughtPriceCount
    };
  }

  function getEntries() {
    return entries;
  }

  function getStatistics() {
    return {
      fetches: statistics.fetches,
      playersFound: statistics.playersFound,
      playersBought: statistics.playersBought,
      averageBoughtPrice: statistics.boughtPriceCount > 0
        ? statistics.boughtPriceTotal / statistics.boughtPriceCount
        : null
    };
  }

  function resetStatistics() {
    entries = [];
    statistics = createEmptyStatistics();
    void chrome.storage.local.set({
      [STORAGE_KEY]: entries,
      [STATISTICS_KEY]: statistics
    }).catch(() => {});
  }

  function record(entry) {
    const completeEntry = {
      time: new Date().toLocaleTimeString("de-DE"),
      ...entry
    };

    entries.push(completeEntry);
    if (completeEntry.activity === "fetch-summary") {
      addEntryToStatistics(statistics, completeEntry);
    }
    void chrome.storage.local.set({
      [STORAGE_KEY]: entries,
      [STATISTICS_KEY]: statistics
    }).catch(() => {});
    notify(completeEntry);
    return completeEntry;
  }

  function activity(name, details = {}) {
    return null;
  }

  function searchResult(status, auctionInfoLength) {
    return null;
  }

  function bidResponse(response, body, details = {}) {
    return null;
  }

  function fetchSummary(details = {}) {
    return record({
      activity: "fetch-summary",
      ...details
    });
  }

  return {
    activity,
    bidResponse,
    fetchSummary,
    getEntries,
    getStatistics,
    resetStatistics,
    searchResult,
    setEntries,
    setStatistics
  };
}

export function formatLogEntry(entry) {
  const activity = entry.activity || entry.requestType;
  const status = typeof entry.status === "number" ? `HTTP ${entry.status}` : entry.status;

  if (activity === "fetch-summary") {
    const foundPrices = entry.foundPrices?.length ? entry.foundPrices.join(", ") : "none";
    const bidPrices = entry.bidPrices?.length ? entry.bidPrices.join(", ") : "none";
    const credits = entry.credits ?? "none";

    return `${entry.time}  minb=${entry.minb ?? "none"} maxb=${entry.maxb ?? "none"} | Found: ${entry.playersFound} players (prices: ${foundPrices}) | Bought: ${entry.playersBought} players (bid: ${bidPrices}) | Credits: ${credits}`;
  }

  if (Number.isInteger(entry.auctionInfoLength)) {
    return `${entry.time}  auctionInfo.length: ${entry.auctionInfoLength}`;
  }

  if (activity && typeof entry.body !== "string") {
    const details = Object.entries(entry)
      .filter(([key]) => !["time", "activity", "requestType", "status"].includes(key))
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const statusLabel = entry.status !== undefined ? ` [${entry.status}]` : "";

    return `${entry.time}  ${activity}${statusLabel}${details ? ` ${details}` : ""}`;
  }

  if (typeof entry.body !== "string") {
    return `${entry.time}  ${status}`;
  }

  const headers = Object.entries(entry.headers || {})
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");

  return [
    `${entry.time}  ${status}${entry.statusText ? ` ${entry.statusText}` : ""}`,
    activity ? `Activity: ${activity}` : "",
    entry.url ? `URL: ${entry.url}` : "",
    entry.maskedDefId ? `maskedDefId: ${entry.maskedDefId}` : "",
    entry.tradeId != null ? `tradeId: ${entry.tradeId}` : "",
    entry.bid != null ? `bid: ${entry.bid}` : "",
    `Headers:\n${headers || "(none)"}`,
    `Body:\n${entry.body}`
  ].filter(Boolean).join("\n");
}
