export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  // Get and validate booking code
  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{4,20}$/.test(code)) {
    return res.status(400).json({
      success: false,
      error: "Please enter a valid SportyBet booking code."
    });
  }

  try {
    // Load booking from SportyBet API
    const response = await fetch(
      `https://sportybet-api.onrender.com/booking/${encodeURIComponent(code)}`
    );

    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error("SportyBet API returned non-JSON:", raw);

      return res.status(502).json({
        success: false,
        error: "SportyBet returned an unexpected response."
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error:
          data?.error ||
          data?.message ||
          "Unable to load the SportyBet booking.",
        details: data
      });
    }

    /*
     * -------------------------------------------------------
     * Extract selections from the SportyBet booking response.
     *
     * The API normally stores them here:
     *
     * data.booking.data.outcomes
     *
     * But this function also checks a few alternative locations
     * so small changes in the API response do not break the app.
     * -------------------------------------------------------
     */

    const outcomes =
      Array.isArray(data?.booking?.data?.outcomes)
        ? data.booking.data.outcomes
        : Array.isArray(data?.data?.outcomes)
        ? data.data.outcomes
        : Array.isArray(data?.outcomes)
        ? data.outcomes
        : Array.isArray(data?.booking?.outcomes)
        ? data.booking.outcomes
        : Array.isArray(data?.selections)
        ? data.selections
        : [];

    const selections = outcomes
      .map((item) => {
        const event = item?.event || {};

        const markets = Array.isArray(event?.markets)
          ? event.markets
          : Array.isArray(item?.markets)
          ? item.markets
          : [];

        /*
         * The booking outcome normally corresponds to one market.
         * First try to find the market matching the selection's
         * market ID/specifier. Otherwise use the first market.
         */

        let marketObject = markets.find((market) => {
          const marketId =
            market?.id ??
            market?.marketId ??
            "";

          const specifier =
            market?.specifier ??
            "";

          return (
            String(marketId) === String(item?.marketId ?? "") &&
            String(specifier) === String(item?.specifier ?? "")
          );
        });

        if (!marketObject) {
          marketObject = markets.find((market) => {
            const marketId =
              market?.id ??
              market?.marketId ??
              "";

            return (
              String(marketId) ===
              String(item?.marketId ?? "")
            );
          });
        }

        if (!marketObject) {
          marketObject = markets[0] || {};
        }

        const marketOutcomes =
          Array.isArray(marketObject?.outcomes)
            ? marketObject.outcomes
            : [];

        /*
         * Find the exact outcome where possible.
         */

        let outcomeObject = marketOutcomes.find((outcome) => {
          const outcomeId =
            outcome?.id ??
            outcome?.outcomeId ??
            "";

          return (
            String(outcomeId) ===
            String(item?.outcomeId ?? "")
          );
        });

        if (!outcomeObject) {
          outcomeObject = marketOutcomes[0] || {};
        }

        /*
         * Build the event name.
         */

        const homeTeam =
          event?.homeTeamName ||
          event?.homeTeam?.name ||
          item?.homeTeamName ||
          "";

        const awayTeam =
          event?.awayTeamName ||
          event?.awayTeam?.name ||
          item?.awayTeamName ||
          "";

        const eventName =
          item?.eventName ||
          event?.name ||
          (homeTeam && awayTeam
            ? `${homeTeam} vs ${awayTeam}`
            : "Unknown event");

        /*
         * Build market name.
         */

        const marketName =
          item?.marketName ||
          item?.marketDesc ||
          marketObject?.desc ||
          marketObject?.name ||
          marketObject?.marketName ||
          "Market";

        /*
         * Build selection/pick name.
         */

        const pick =
          item?.outcomeName ||
          item?.pick ||
          item?.selection ||
          outcomeObject?.desc ||
          outcomeObject?.name ||
          outcomeObject?.outcomeName ||
          "Selection";

        /*
         * Odds.
         */

        const odds =
          item?.odds ??
          outcomeObject?.odds ??
          outcomeObject?.odd ??
          "";

        /*
         * Event ID.
         */

        const eventId =
          item?.eventId ||
          event?.eventId ||
          event?.id ||
          "";

        /*
         * Game ID.
         */

        const gameId =
          item?.gameId ||
          event?.gameId ||
          event?.id ||
          "";

        /*
         * Market ID.
         */

        const marketId =
          item?.marketId ||
          marketObject?.id ||
          marketObject?.marketId ||
          "";

        /*
         * Specifier.
         */

        const specifier =
          item?.specifier ??
          marketObject?.specifier ??
          "";

        /*
         * Outcome ID.
         */

        const outcomeId =
          item?.outcomeId ||
          outcomeObject?.id ||
          outcomeObject?.outcomeId ||
          "";

        /*
         * Start time.
         */

        const startTime =
          item?.startTime ||
          event?.estimateStartTime ||
          event?.startTime ||
          "";

        return {
          event: String(eventName),
          market: String(marketName),
          pick: String(pick),
          odds: odds,

          eventId: String(eventId),
          gameId: String(gameId),
          marketId: String(marketId),
          specifier: specifier ? String(specifier) : "",
          outcomeId: String(outcomeId),
          startTime: startTime
            ? String(startTime)
            : ""
        };
      })
      .filter((selection) => {
        /*
         * Only keep entries that contain enough information
         * to represent a real SportyBet selection.
         */

        return (
          selection.event &&
          selection.market &&
          selection.pick
        );
      });

    /*
     * Remove accidental duplicate selections.
     */

    const uniqueSelections = [];

    const seen = new Set();

    for (const selection of selections) {
      const key = [
        selection.eventId,
        selection.gameId,
        selection.marketId,
        selection.specifier,
        selection.outcomeId
      ].join("|");

      if (!seen.has(key)) {
        seen.add(key);
        uniqueSelections.push(selection);
      }
    }

    /*
     * If the booking API returned data but we could not
     * identify any selections, return a useful error instead
     * of making the frontend look like the booking loaded normally.
     */

    if (!uniqueSelections.length) {
      console.error(
        "No selections extracted from SportyBet booking:",
        JSON.stringify(data)
      );

      return res.status(422).json({
        success: false,
        error:
          "The booking was found, but no selections could be extracted from the SportyBet response."
      });
    }

    /*
     * Return the original booking data as well as the
     * normalized selections.
     *
     * Your current index.html can read data.selections.
     */

    return res.status(200).json({
      success: true,
      code,
      selections: uniqueSelections,
      booking: data.booking || data,
      source: data
    });

  } catch (error) {
    console.error("Load slip error:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to connect to the SportyBet API."
    });
  }
           }
