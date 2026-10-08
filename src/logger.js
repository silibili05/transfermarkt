const STORAGE_KEY = "responseLog";
const STATISTICS_KEY = "statistics";

function createEmptyStatistics() {
  return {
    fetches: 0,
    playersFound: 0,
    playersBought: 0,
    sessionProfit: 0,
    lastResetAt: null
  };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function addEntryToStatistics(statistics, entry) {
  statistics.fetches += 1;
  statistics.playersFound += toFiniteNumber(entry?.playersFound);
  statistics.playersBought += toFiniteNumber(entry?.playersBought);
  statistics.sessionProfit += toFiniteNumber(entry?.sessionProfit);
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
      ? storedEntries.filter((entry) => (
        entry?.activity === "fetch-summary" && toFiniteNumber(entry.playersBought) > 0
      ))
      : [];
    statistics = calculateStatistics(entries);
  }

  function setStatistics(storedStatistics) {
    if (!storedStatistics || typeof storedStatistics !== "object") {
      return;
    }

    const fallback = calculateStatistics(entries);
    const sessionProfit = Number(storedStatistics.sessionProfit);

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
      sessionProfit: Number.isFinite(sessionProfit)
        ? sessionProfit
        : fallback.sessionProfit,
      lastResetAt: typeof storedStatistics.lastResetAt === "string"
        ? storedStatistics.lastResetAt
        : fallback.lastResetAt
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
      sessionProfit: statistics.sessionProfit,
      lastResetAt: statistics.lastResetAt
    };
  }

  function resetStatistics() {
    entries = [];
    statistics = {
      ...createEmptyStatistics(),
      lastResetAt: new Date().toISOString()
    };
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
    void chrome.storage.local.set({
      [STORAGE_KEY]: entries,
      [STATISTICS_KEY]: statistics
    }).catch(() => {});
    notify(completeEntry);
    return completeEntry;
  }

  function recordFetch(details = {}) {
    addEntryToStatistics(statistics, details);
    void chrome.storage.local.set({
      [STORAGE_KEY]: entries,
      [STATISTICS_KEY]: statistics
    }).catch(() => {});
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
    recordFetch,
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
    const boughtPrice = entry.boughtPrice ?? entry.boughtPrices?.[0];
    const buyMaxPrice = entry.buyMaxPrice ?? entry.maxb;
    const salePrice = entry.salePrice ?? (
      buyMaxPrice == null ? null : Number(buyMaxPrice) * 0.95
    );
    const profit = entry.profit ?? entry.sessionProfit;

    return `${entry.time} #${entry.playerId ?? "?"} | buy ${formatCoinAmount(boughtPrice)} | max ${formatCoinAmount(buyMaxPrice)} | sell ${formatCoinAmount(salePrice)} | profit ${formatProfit(profit)}`;
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

function formatCoinAmount(value) {
  if (value === null || value === undefined || value === "") {
    return "none";
  }

  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(2))) : "none";
}

function formatProfit(value) {
  const amount = formatCoinAmount(value);
  return amount === "none" || Number(value) < 0 ? amount : `+${amount}`;
}
