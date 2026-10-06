import { formatLogEntry } from "./logger.js";

const statusField = document.querySelector("#last-status");
const autoListToggle = document.querySelector("#auto-list-toggle");
const listingMinBidField = document.querySelector("#listing-min-bid");
const listingBuyNowField = document.querySelector("#listing-buy-now");
const fetchCountField = document.querySelector("#fetch-count");
const playersFoundField = document.querySelector("#players-found");
const playersBoughtField = document.querySelector("#players-bought");
const currentCoinsField = document.querySelector("#current-coins");
const sessionProfitField = document.querySelector("#session-profit");
const lastResetField = document.querySelector("#last-reset");
const logField = document.querySelector("#activity-log");
const fetchButton = document.querySelector("#fetch-button");
const resetButton = document.querySelector("#reset-button");
const fetchState = document.querySelector("#fetch-state");

function showStatus(status) {
  if (typeof status === "number") {
    statusField.textContent = `HTTP ${status}`;
    statusField.dataset.state = status >= 200 && status < 300 ? "success" : "error";
    return;
  }

  statusField.textContent = status || "Waiting for activity...";
  statusField.dataset.state = typeof status === "string" && status.endsWith("failed")
    ? "error"
    : "pending";
}

function renderLog(entries) {
  logField.value = Array.isArray(entries) ? entries.map(formatLogEntry).join("\n") : "";
  logField.scrollTop = logField.scrollHeight;
}

function appendLog(entry) {
  logField.value += `${logField.value ? "\n" : ""}${formatLogEntry(entry)}`;
  logField.scrollTop = logField.scrollHeight;
}

function renderStatistics(statistics) {
  fetchCountField.textContent = String(statistics?.fetches ?? 0);
  playersFoundField.textContent = String(statistics?.playersFound ?? 0);
  playersBoughtField.textContent = String(statistics?.playersBought ?? 0);
  sessionProfitField.textContent = Number.isFinite(statistics?.sessionProfit)
    ? String(Number(statistics.sessionProfit.toFixed(2)))
    : "0";

  const lastResetAt = typeof statistics?.lastResetAt === "string"
    ? new Date(statistics.lastResetAt)
    : null;
  lastResetField.textContent = lastResetAt && !Number.isNaN(lastResetAt.getTime())
    ? lastResetAt.toLocaleString("de-DE")
    : "Never";
}

function renderCurrentCoins(value) {
  currentCoinsField.textContent = Number.isFinite(value) ? String(value) : "none";
}

function renderListingPrices(prices) {
  if (Number.isFinite(prices?.minBid)) {
    listingMinBidField.value = String(prices.minBid);
  }
  if (Number.isFinite(prices?.buyNowPrice)) {
    listingBuyNowField.value = String(prices.buyNowPrice);
  }
}

function applyState(state) {
  const running = state?.running === true;
  fetchButton.textContent = running ? "Stop" : "Fetch and bid";
  fetchButton.disabled = false;
  fetchState.textContent = running ? "Fetch and bid active" : "Ready";
  fetchState.dataset.state = running ? "active" : "paused";
  autoListToggle.checked = state?.autoListEnabled !== false;
  renderListingPrices(state?.listingPrices);
  renderStatistics(state?.statistics);
  renderCurrentCoins(state?.credits);
  renderLog(state?.logs);

  if (state?.status !== null && state?.status !== undefined) {
    showStatus(state.status);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "log-entry") {
    if (message.entry?.status !== undefined) {
      showStatus(message.entry.status);
    }
    appendLog(message.entry);
  }

  if (message?.type === "fetch-state") {
    applyState(message);
  }
});

fetchButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "toggle-fetching" }, (state) => {
    if (chrome.runtime.lastError) {
      return;
    }

    applyState(state);
  });
});

resetButton.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reset-statistics" }, (state) => {
    if (chrome.runtime.lastError) {
      return;
    }

    applyState(state);
  });
});

function saveListingPrices() {
  chrome.runtime.sendMessage({
    type: "set-listing-prices",
    minBid: Number(listingMinBidField.value),
    buyNowPrice: Number(listingBuyNowField.value)
  }, (state) => {
    if (chrome.runtime.lastError) {
      return;
    }

    applyState(state);
  });
}

listingMinBidField.addEventListener("change", saveListingPrices);
listingBuyNowField.addEventListener("change", saveListingPrices);

autoListToggle.addEventListener("change", () => {
  chrome.runtime.sendMessage({
    type: "set-auto-listing",
    enabled: autoListToggle.checked
  }, (state) => {
    if (chrome.runtime.lastError) {
      return;
    }

    applyState(state);
  });
});

chrome.runtime.sendMessage({ type: "get-state" }, (state) => {
  if (chrome.runtime.lastError) {
    return;
  }

  applyState(state);
});
