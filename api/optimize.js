// api/optimize.js
//
// TEMPORARY DIAGNOSTIC VERSION
// This does NOT use Gemini.
// It only checks whether Vercel can fetch and parse
// the SportyBet markets correctly.

export default async function handler(req, res) {
  try {
    let selections = [];

    // ---------------------------------------------------------
    // GET
    // Example:
    // /api/optimize?code=JQVHY8
    //
    // POST
    // The normal frontend sends:
    // { selections: [...] }
    // ---------------------------------------------------------

    if (req.method === "GET") {
      const code = String(req.query?.code || "").trim();

      if (!code) {
        return res.status(200).json({
          success: true,
          message:
            "Diagnostic endpoint is working. Add ?code=JQVHY8"
        });
      }

      const bookingURL =
        `https://sportybet-api.onrender.com/booking/${encodeURIComponent(code)}`;

      const bookingResponse = await fetch(bookingURL);

      const bookingText = await bookingResponse.text();

      let bookingData;

      try {
        bookingData = JSON.parse(bookingText);
      } catch {
        return res.status(200).json({
          success: false,
          step: "booking",
          httpStatus: bookingResponse.status,
          error: "Render booking endpoint did not return JSON",
          responsePreview: bookingText.slice(0, 1000)
        });
      }

      selections =
        Array.isArray(bookingData?.selections)
          ? bookingData.selections
          : Array.isArray(bookingData?.booking?.selections)
            ? bookingData.booking.selections
            : [];

      if (selections.length === 0) {
        return res.status(200).json({
          success: false,
          step: "booking",
          message: "Booking loaded but no selections were found.",
          bookingKeys: Object.keys(bookingData || {}),
          bookingData
        });
      }
    }

    if (req.method === "POST") {
      selections = Array.isArray(req.body?.selections)
        ? req.body.selections
        : [];
    }

    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No selections supplied"
      });
    }

    // ---------------------------------------------------------
    // Get unique events
    // ---------------------------------------------------------

    const events = [];

    for (const selection of selections) {
      const eventId = String(selection?.eventId || "").trim();

      if (!eventId) continue;

      if (!events.some(event => event.eventId === eventId)) {
        events.push({
          eventId,
          event: selection.event || "Unknown event"
        });
      }
    }

    // ---------------------------------------------------------
    // Fetch markets for every event
    // ---------------------------------------------------------

    const results = [];

    for (const event of events) {
      const result = {
        eventId: event.eventId,
        event: event.event,
        fetchSuccess: false,
        httpStatus: null,
        topLevelKeys: [],
        marketCount: 0,
        activeOutcomeCount: 0,
        sampleMarkets: [],
        error: null
      };

      try {
        const url =
          `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(event.eventId)}`;

        const response = await fetch(url);

        result.httpStatus = response.status;

        const text = await response.text();

        let data;

        try {
          data = JSON.parse(text);
        } catch {
          result.error =
            "Response was not valid JSON: " +
            text.slice(0, 500);

          results.push(result);
          continue;
        }

        result.fetchSuccess = response.ok;
        result.topLevelKeys = Object.keys(data || {});

        // -----------------------------------------------------
        // EXACT SportyBet structure from your endpoint:
        //
        // {
        //   event: {...},
        //   markets: [
        //      {
        //        marketId,
        //        market,
        //        specifier,
        //        outcomes: [...]
        //      }
        //   ]
        // }
        // -----------------------------------------------------

        if (!Array.isArray(data?.markets)) {
          result.error =
            "data.markets is not an array";

          result.dataShape = {
            isObject:
              typeof data === "object" && data !== null,
            marketsType:
              Array.isArray(data?.markets)
                ? "array"
                : typeof data?.markets,
            eventType:
              typeof data?.event,
            marketCountField:
              data?.marketCount
          };

          results.push(result);
          continue;
        }

        result.marketCount = data.markets.length;

        let activeOutcomes = 0;

        for (const market of data.markets) {
          if (!Array.isArray(market?.outcomes)) continue;

          for (const outcome of market.outcomes) {
            if (outcome?.isActive !== false) {
              activeOutcomes++;
            }
          }
        }

        result.activeOutcomeCount = activeOutcomes;

        // -----------------------------------------------------
        // Show first 10 markets with their outcomes.
        // This lets us see exactly what Vercel receives.
        // -----------------------------------------------------

        result.sampleMarkets = data.markets
          .slice(0, 10)
          .map(market => ({
            marketId: market?.marketId ?? null,
            market: market?.market ?? null,
            specifier: market?.specifier ?? null,
            outcomeCount:
              Array.isArray(market?.outcomes)
                ? market.outcomes.length
                : 0,
            outcomes:
              Array.isArray(market?.outcomes)
                ? market.outcomes.slice(0, 5).map(outcome => ({
                    outcomeId:
                      outcome?.outcomeId ?? null,
                    pick:
                      outcome?.pick ?? null,
                    odds:
                      outcome?.odds ?? null,
                    isActive:
                      outcome?.isActive ?? null
                  }))
                : []
          }));

      } catch (error) {
        result.error =
          error?.message || String(error);
      }

      results.push(result);
    }

    // ---------------------------------------------------------
    // Final diagnostic
    // ---------------------------------------------------------

    return res.status(200).json({
      success: true,

      message:
        "SportyBet market diagnostic completed. Gemini was NOT called.",

      selectionCount: selections.length,

      eventCount: events.length,

      events: results,

      summary: {
        eventsRequested: events.length,

        eventsFetchedSuccessfully:
          results.filter(
            item => item.fetchSuccess
          ).length,

        eventsWithMarkets:
          results.filter(
            item => item.marketCount > 0
          ).length,

        totalMarkets:
          results.reduce(
            (sum, item) =>
              sum + item.marketCount,
            0
          ),

        totalActiveOutcomes:
          results.reduce(
            (sum, item) =>
              sum + item.activeOutcomeCount,
            0
          )
      }
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Diagnostic failed"
    });
  }
}

Now deploy it.

Then open this exact link:

"Run the market diagnostic for JQVHY8" (https://sportybet-slip-optimizer.vercel.app/api/optimize?code=JQVHY8&utm_source=chatgpt.com)

What I need from you

Copy the JSON it gives you and paste it here.

This time we are not guessing. The response will tell us exactly:

- whether Vercel loads the booking
- how many events it sees
- whether it can reach Render
- HTTP status for each event
- how many markets each event has
- how many outcomes are available
- the exact market structure Vercel receives

Once we see that, we'll fix the actual failure and then restore Gemini + the four profiles.
