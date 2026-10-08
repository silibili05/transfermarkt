import {
  createFetcher,
  API_URL_PATTERN,
  DEFAULT_FETCH_INTERVAL_SECONDS,
  DEFAULT_SEARCH_PRICE,
  normalizeFetchIntervalSeconds,
  normalizeSearchPrice
} from "./fetcher.js";
import { createLogger } from "./logger.js";

let utSid = null;
let searchUrl = null;
let searchPrice = DEFAULT_SEARCH_PRICE;
let listingPrices = {
  minBid: 750,
  buyNowPrice: 800
};
let autoListEnabled = true;
let fetchIntervalSeconds = DEFAULT_FETCH_INTERVAL_SECONDS;
let credits = null;

function notifyPopup(message) {
  chrome.runtime.sendMessage(
    message,
    () => void chrome.runtime.lastError
  );
}

const logger = createLogger({
  notify: (entry) => notifyPopup({ type: "log-entry", entry })
});

const fetcher = createFetcher({
  getSessionId: () => utSid,
  getSearchUrl: () => searchUrl,
  getSearchPrice: () => searchPrice,
  getListingPrices: () => listingPrices,
  getAutoListEnabled: () => autoListEnabled,
  getFetchIntervalSeconds: () => fetchIntervalSeconds,
  logger,
  onStateChange: () => notifyPopup({ type: "fetch-state", ...getState() }),
  setCredits: (value) => {
    credits = value;
    void chrome.storage.local.set({ credits }).catch(() => {});
  }
});

const stateReady = loadState();

chrome.webRequest.onBeforeSendHeaders.addListener(
  capturePageRequest,
  { urls: [API_URL_PATTERN], types: ["xmlhttprequest"] },
  ["requestHeaders"]
);

async function loadState() {
  try {
    const stored = await chrome.storage.local.get({
      responseLog: [],
      statistics: null,
      searchUrl: null,
      searchPrice,
      listingPrices,
      autoListEnabled,
      fetchIntervalSeconds,
      credits: null,
      utSid: null
    });

    logger.setEntries(stored.responseLog);
    logger.setStatistics(stored.statistics);
    if (!searchUrl && typeof stored.searchUrl === "string" && stored.searchUrl) {
      searchUrl = stored.searchUrl;
    }
    const storedSearchPrice = normalizeSearchPrice(stored.searchPrice);
    if (storedSearchPrice !== null) {
      searchPrice = storedSearchPrice;
    }
    if (stored.listingPrices && typeof stored.listingPrices === "object") {
      const minBid = Number(stored.listingPrices.minBid);
      const buyNowPrice = Number(stored.listingPrices.buyNowPrice);
      if (Number.isFinite(minBid) && minBid >= 0
        && Number.isFinite(buyNowPrice) && buyNowPrice >= 0) {
        listingPrices = { minBid, buyNowPrice };
      }
    }
    if (typeof stored.autoListEnabled === "boolean") {
      autoListEnabled = stored.autoListEnabled;
    }
    const storedInterval = normalizeFetchIntervalSeconds(stored.fetchIntervalSeconds);
    if (storedInterval !== null) {
      fetchIntervalSeconds = storedInterval;
    }
    const storedCredits = Number(stored.credits);
    if (Number.isFinite(storedCredits) && stored.credits !== null) {
      credits = storedCredits;
    }
    if (!utSid && typeof stored.utSid === "string" && stored.utSid) {
      utSid = stored.utSid;
    }
  } catch {
    logger.setEntries([]);
  }
}

function capturePageRequest({ requestHeaders, url, tabId }) {
  const requestedUrl = new URL(url);
  const sessionHeader = requestHeaders?.find(
    ({ name, value }) => name.toLowerCase() === "x-ut-sid" && value
  );

  if (tabId >= 0 && requestedUrl.pathname.endsWith("/transfermarket")) {
    const nextSearchUrl = requestedUrl.toString();
    if (nextSearchUrl !== searchUrl) {
      searchUrl = nextSearchUrl;
      void chrome.storage.local.set({ searchUrl }).catch(() => {});
    }
  }

  if (sessionHeader?.value && sessionHeader.value !== utSid) {
    utSid = sessionHeader.value;
    void chrome.storage.local.set({ utSid }).catch(() => {});
    void stateReady.then(() => logger.activity("session", {
      message: "X-Ut-Sid captured"
    }));
  }
}

function getState() {
  const statistics = logger.getStatistics();

  return {
    running: fetcher.isRunning(),
    logs: logger.getEntries(),
    statistics,
    searchPrice,
    listingPrices,
    autoListEnabled,
    fetchIntervalSeconds,
    credits
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!["get-state", "toggle-fetching", "reset-statistics", "set-search-price", "set-listing-prices", "set-auto-listing", "set-fetch-interval"].includes(message?.type)) {
    return;
  }

  stateReady.then(() => {
    if (message.type === "toggle-fetching") {
      if (fetcher.isRunning()) {
        fetcher.stopFetching();
      } else {
        fetcher.startFetching();
      }
    }

    if (message.type === "reset-statistics") {
      logger.resetStatistics();
    }

    if (message.type === "set-search-price") {
      const nextSearchPrice = normalizeSearchPrice(message.price);
      if (nextSearchPrice !== null) {
        searchPrice = nextSearchPrice;
        void chrome.storage.local.set({ searchPrice }).catch(() => {});
      }
    }

    if (message.type === "set-listing-prices") {
      const minBid = Number(message.minBid);
      const buyNowPrice = Number(message.buyNowPrice);
      if (Number.isFinite(minBid) && minBid >= 0
        && Number.isFinite(buyNowPrice) && buyNowPrice >= 0) {
        listingPrices = { minBid, buyNowPrice };
        void chrome.storage.local.set({ listingPrices }).catch(() => {});
      }
    }

    if (message.type === "set-auto-listing" && typeof message.enabled === "boolean") {
      autoListEnabled = message.enabled;
      void chrome.storage.local.set({ autoListEnabled }).catch(() => {});
    }

    if (message.type === "set-fetch-interval") {
      const seconds = normalizeFetchIntervalSeconds(message.seconds);
      if (seconds !== null) {
        fetchIntervalSeconds = seconds;
        void chrome.storage.local.set({ fetchIntervalSeconds }).catch(() => {});
      }
    }

    sendResponse(getState());
  });

  return true;
});
