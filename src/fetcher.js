export const API_URL_PATTERN = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/*";

export const DEFAULT_FETCH_INTERVAL_SECONDS = 2;
export const DEFAULT_SEARCH_PRICE = 0;
export const MIN_FETCH_INTERVAL_SECONDS = 0.5;
export const MAX_FETCH_INTERVAL_SECONDS = 50000;

export function normalizeFetchIntervalSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  if (seconds < MIN_FETCH_INTERVAL_SECONDS || seconds > MAX_FETCH_INTERVAL_SECONDS) {
    return null;
  }

  return seconds;
}

export function normalizeSearchPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

export function createFetcher({
  getSessionId,
  getSearchUrl,
  getSearchPrice = () => DEFAULT_SEARCH_PRICE,
  getListingPrices = () => ({ minBid: 750, buyNowPrice: 800 }),
  getAutoListEnabled = () => true,
  getFetchIntervalSeconds = () => DEFAULT_FETCH_INTERVAL_SECONDS,
  logger,
  onStateChange,
  setCredits = () => {}
}) {
  let requestInFlight = false;
  let running = false;
  let timeoutId = null;

  function buildHeaders(withJsonBody = false) {
    return {
      Accept: "application/json",
      ...(withJsonBody ? { "Content-Type": "application/json" } : {}),
      "X-Ut-Sid": getSessionId()
    };
  }

  function buildSearchUrl() {
    const currentSearchUrl = getSearchUrl();
    if (!currentSearchUrl) {
      return null;
    }

    const url = new URL(currentSearchUrl);
    const searchPrice = normalizeSearchPrice(getSearchPrice()) ?? 0;
    url.searchParams.set("minb", String(searchPrice));

    return url;
  }

  function parseAuctionInfo(body) {
    try {
      const data = JSON.parse(body);
      return Array.isArray(data?.auctionInfo) ? data.auctionInfo : [];
    } catch {
      return [];
    }
  }

  function parseBidResponse(body) {
    try {
      const data = JSON.parse(body);
      const credits = Number(data?.credits);
      return {
        credits: data?.credits != null && Number.isFinite(credits) ? credits : null,
        playerId: data?.itemData?.id ?? data?.auctionInfo?.[0]?.itemData?.id ?? null
      };
    } catch {
      return { credits: null, playerId: null };
    }
  }

  async function moveToTransferPile(playerId, apiOrigin) {
    const itemUrl = `${apiOrigin}/ut/game/fc27/item`;
    const response = await fetch(itemUrl, {
      method: "PUT",
      headers: buildHeaders(true),
      body: JSON.stringify({
        itemData: [{ id: playerId, pile: "trade" }]
      })
    });
    await response.text();

    if (!response.ok) {
      throw new Error(`Move to transfer pile failed: HTTP ${response.status}`);
    }
  }

  async function setToTransferList(playerId, apiOrigin) {
    const { minBid, buyNowPrice } = getListingPrices();
    const transferListUrl = `${apiOrigin}/ut/game/fc27/auctionhouse`;
    await moveToTransferPile(playerId, apiOrigin);

    logger.activity("set on Transferlist", {
      playerId,
      minBid,
      buyNowPrice,
      url: transferListUrl
    });

    const response = await fetch(transferListUrl, {
      method: "POST",
      headers: buildHeaders(true),
      body: JSON.stringify({
        buyNowPrice,
        duration: 3600,
        itemData: {
          id: playerId
        },
        startingBid: minBid
      })
    });
    const body = await response.text();

    logger.bidResponse(response, body, {
      playerId,
      minBid,
      bid: buyNowPrice
    });
    if (!response.ok) {
      logger.activity("set-to-transferlist-error", {
        status: response.status,
        playerId,
        minBid,
        bid: buyNowPrice
      });
    }
  }

  async function bidOnTrade(tradeId, buyNowPrice, apiOrigin) {
    const bidUrl = `${apiOrigin}/ut/game/fc27/trade/${encodeURIComponent(tradeId)}/bid`;
    logger.activity("bid-request", {
      tradeId,
      bid: buyNowPrice,
      url: bidUrl
    });

    const response = await fetch(bidUrl, {
      method: "PUT",
      headers: buildHeaders(true),
      body: JSON.stringify({ bid: buyNowPrice })
    });
    const body = await response.text();

    logger.bidResponse(response, body, {
      tradeId,
      bid: buyNowPrice
    });
    const bidData = parseBidResponse(body);
    if (!response.ok) {
      logger.activity("bid-error", {
        status: response.status,
        tradeId,
        bid: buyNowPrice
      });
    }
    return {
      status: response.status,
      credits: bidData.credits,
      playerId: bidData.playerId
    };
  }

  async function fetchAndBid() {
    if (requestInFlight) {
      return;
    }

    requestInFlight = true;
    let playersFound = 0;
    let playersBought = 0;
    let sessionProfit = 0;
    let credits = null;
    let purchaseLog = null;
    onStateChange();

    try {
      if (!getSessionId()) {
        logger.activity("session-wait", { status: "Waiting for X-Ut-Sid" });
        return;
      }

      const searchUrl = buildSearchUrl();
      if (!searchUrl) {
        return;
      }

      const rawBuyMaxPrice = searchUrl.searchParams.get("maxb");
      const buyMaxPrice = rawBuyMaxPrice === null ? null : Number(rawBuyMaxPrice);
      logger.activity("player-search-request", { url: searchUrl.toString() });
      const searchResponse = await fetch(searchUrl, {
        cache: "no-store",
        headers: buildHeaders()
      });
      const searchBody = await searchResponse.text();

      const auctionInfo = parseAuctionInfo(searchBody);
      playersFound = auctionInfo.length;

      if (searchResponse.status !== 200) {
        logger.activity("player-search-error", { status: searchResponse.status });
        stopFetching();
        return;
      }

      const auction = auctionInfo[0];
      const tradeId = auction?.tradeIdStr || auction?.tradeId;
      const buyNowPrice = auction?.buyNowPrice;
      const playerId = auction?.itemData?.id;
      if (tradeId == null || buyNowPrice == null) {
        return;
      }

      try {
        const bidResult = await bidOnTrade(tradeId, buyNowPrice, searchUrl.origin);
        if (bidResult.status >= 200 && bidResult.status < 300) {
          playersBought = 1;
          const boughtPrice = Number(buyNowPrice);
          const netSalePrice = Number.isFinite(buyMaxPrice) ? buyMaxPrice * 0.95 : null;
          const profit = Number.isFinite(netSalePrice) && Number.isFinite(boughtPrice)
            ? netSalePrice - boughtPrice
            : null;
          sessionProfit = profit ?? 0;
          credits = bidResult.credits;
          if (credits !== null) {
            setCredits(credits);
          }

          const boughtPlayerId = bidResult.playerId ?? playerId;
          purchaseLog = {
            playersBought,
            playerId: boughtPlayerId,
            boughtPrice,
            buyMaxPrice: Number.isFinite(buyMaxPrice) ? buyMaxPrice : null,
            salePrice: netSalePrice,
            profit,
            credits
          };
          if (getAutoListEnabled() && boughtPlayerId != null) {
            try {
              await setToTransferList(boughtPlayerId, searchUrl.origin);
            } catch {
            }
          }
        }
      } catch {
      }
    } catch {
    } finally {
      requestInFlight = false;
      logger.recordFetch({
        playersFound,
        playersBought,
        sessionProfit
      });
      if (purchaseLog) {
        logger.fetchSummary(purchaseLog);
      }
      onStateChange();
    }
  }

  function currentIntervalMs() {
    const seconds = normalizeFetchIntervalSeconds(getFetchIntervalSeconds());
    return (seconds ?? DEFAULT_FETCH_INTERVAL_SECONDS) * 1000;
  }

  function scheduleNextFetch() {
    if (!running) {
      return;
    }

    timeoutId = setTimeout(() => {
      timeoutId = null;
      void fetchAndBid().finally(scheduleNextFetch);
    }, currentIntervalMs());
  }

  function startFetching() {
    if (running) {
      return;
    }

    running = true;
    onStateChange();
    void fetchAndBid().finally(scheduleNextFetch);
  }

  function stopFetching() {
    if (!running) {
      return;
    }

    running = false;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    onStateChange();
  }

  return {
    fetchAndBid,
    startFetching,
    stopFetching,
    isRunning: () => running
  };
}
