export const API_URL_PATTERN = "https://utas.mob.v1.prd.futc-ext.gcp.ea.com/*";

const FETCH_INTERVAL_MS = 2000;
const MIN_BID_INCREMENT = 50;
const MIN_BID_RESET = 1000;

export function createFetcher({
  getSessionId,
  getSearchUrl,
  getListingPrices = () => ({ minBid: 750, buyNowPrice: 800 }),
  getAutoListEnabled = () => true,
  logger,
  onStateChange,
  setStatus,
  setCredits = () => {}
}) {
  let requestInFlight = false;
  let intervalId = null;
  let capturedSearchUrl = null;
  let minBid = null;

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
    if (currentSearchUrl !== capturedSearchUrl) {
      capturedSearchUrl = currentSearchUrl;
      minBid = Number(url.searchParams.get("minb")) || 0;
    }

    url.searchParams.set("minb", String(minBid));
    minBid += MIN_BID_INCREMENT;
    if (minBid >= MIN_BID_RESET) {
      minBid = 0;
    }

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

    return response.status;
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
    let foundPrices = [];
    let playersBought = 0;
    let bidPrices = [];
    let boughtPrices = [];
    let credits = null;
    let minb = null;
    let maxb = null;
    onStateChange();

    try {
      if (!getSessionId()) {
        setStatus("Waiting for X-Ut-Sid");
        logger.activity("session-wait", { status: "Waiting for X-Ut-Sid" });
        return;
      }

      const searchUrl = buildSearchUrl();
      if (!searchUrl) {
        setStatus("Waiting for transfer-market search");
        return;
      }

      minb = searchUrl.searchParams.get("minb");
      maxb = searchUrl.searchParams.get("maxb");
      logger.activity("player-search-request", { url: searchUrl.toString() });
      const searchResponse = await fetch(searchUrl, {
        cache: "no-store",
        headers: buildHeaders()
      });
      const searchBody = await searchResponse.text();
      setStatus(searchResponse.status);

      const auctionInfo = parseAuctionInfo(searchBody);
      playersFound = auctionInfo.length;
      foundPrices = auctionInfo
        .map((auction) => auction?.buyNowPrice)
        .filter((price) => price != null);

      if (!searchResponse.ok) {
        logger.activity("player-search-error", { status: searchResponse.status });
        return;
      }

      const auction = auctionInfo[0];
      const tradeId = auction?.tradeIdStr || auction?.tradeId;
      const buyNowPrice = auction?.buyNowPrice;
      const playerId = auction?.itemData?.id;
      if (tradeId == null || buyNowPrice == null) {
        return;
      }

      bidPrices = [buyNowPrice];
      try {
        const bidResult = await bidOnTrade(tradeId, buyNowPrice, searchUrl.origin);
        setStatus(bidResult.status);
        if (bidResult.status >= 200 && bidResult.status < 300) {
          playersBought = 1;
          boughtPrices = [buyNowPrice];
          credits = bidResult.credits;
          if (credits !== null) {
            setCredits(credits);
          }

          const boughtPlayerId = bidResult.playerId ?? playerId;
          if (getAutoListEnabled() && boughtPlayerId != null) {
            try {
              setStatus(await setToTransferList(boughtPlayerId, searchUrl.origin));
            } catch (error) {
              setStatus("Transfer list failed");
            }
          }
        }
      } catch (error) {
        setStatus("Bid failed");
      }
    } catch (error) {
      setStatus("Search failed");
    } finally {
      requestInFlight = false;
      logger.fetchSummary({
        minb,
        maxb,
        playersFound,
        foundPrices,
        playersBought,
        bidPrices,
        boughtPrices,
        credits
      });
      onStateChange();
    }
  }

  function startFetching() {
    if (intervalId !== null) {
      return;
    }

    intervalId = setInterval(() => {
      void fetchAndBid();
    }, FETCH_INTERVAL_MS);
    onStateChange();
    void fetchAndBid();
  }

  function stopFetching() {
    if (intervalId === null) {
      return;
    }

    clearInterval(intervalId);
    intervalId = null;
    onStateChange();
  }

  return {
    fetchAndBid,
    startFetching,
    stopFetching,
    isRunning: () => intervalId !== null
  };
}
