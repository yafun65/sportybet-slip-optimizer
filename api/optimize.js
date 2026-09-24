export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const API_BASE =
    "https://sportybet-api.onrender.com";

  const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY;

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      success: false,
      error: "GEMINI_API_KEY is not configured."
    });
  }

  const selections =
    Array.isArray(req.body?.selections)
      ? req.body.selections
      : [];

  if (!selections.length) {
    return res.status(400).json({
      success: false,
      error: "No selections were provided."
    });
  }


  /* =====================================================
     CLEAN ORIGINAL SELECTIONS
  ===================================================== */

  const originalSelections =
    selections.map((s, index) => ({
      event:
        s.event ||
        `Game ${index + 1}`,

      market:
        s.market ||
        "Market",

      pick:
        s.pick ||
        "Selection",

      odds:
        Number(s.odds) || 0,

      eventId:
        s.eventId ||
        "",

      gameId:
        s.gameId ||
        "",

      marketId:
        String(s.marketId || ""),

      specifier:
        s.specifier ??
        null,

      outcomeId:
        String(s.outcomeId || ""),

      startTime:
        s.startTime ||
        ""
    }));


  /* =====================================================
     UNIQUE GAMES
  ===================================================== */

  const eventMap = new Map();

  originalSelections.forEach(selection => {

    const key =
      selection.eventId ||
      selection.gameId ||
      selection.event;

    if (!eventMap.has(key)) {
      eventMap.set(key, selection);
    }

  });

  const uniqueEvents =
    Array.from(eventMap.values());

  const totalGames =
    uniqueEvents.length;


  /* =====================================================
     FETCH EVENT MARKETS
  ===================================================== */

  async function fetchMarkets(selection) {

    if (!selection.eventId) {

      return {
        original: selection,
        markets: [],
        error: "Missing eventId."
      };

    }

    try {

      const response =
        await fetch(
          `${API_BASE}/event-markets/${encodeURIComponent(selection.eventId)}`
        );

      const raw =
        await response.text();

      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        return {
          original: selection,
          markets: [],
          error: "Invalid JSON from event-markets endpoint."
        };
      }

      if (!response.ok) {

        return {
          original: selection,
          markets: [],
          error:
            data?.error ||
            data?.message ||
            `Market request failed (${response.status}).`
        };

      }

      return {
        original: selection,
        raw: data,
        markets: extractMarketGroups(data),
        error: null
      };

    } catch (error) {

      return {
        original: selection,
        markets: [],
        error:
          error.message ||
          "Unable to load SportyBet markets."
      };

    }

  }


  /* =====================================================
     EXTRACT MARKET GROUPS
     
     SportyBet responses can be wrapped differently.
     This function deliberately checks several formats.
  ===================================================== */

  function extractMarketGroups(data) {

    if (Array.isArray(data)) {
      return data;
    }

    if (
      Array.isArray(data?.markets)
    ) {
      return data.markets;
    }

    if (
      Array.isArray(data?.data)
    ) {
      return data.data;
    }

    if (
      Array.isArray(data?.data?.markets)
    ) {
      return data.data.markets;
    }

    if (
      Array.isArray(data?.event?.markets)
    ) {
      return data.event.markets;
    }

    if (
      Array.isArray(data?.result?.markets)
    ) {
      return data.result.markets;
    }

    if (
      Array.isArray(data?.result)
    ) {
      return data.result;
    }

    return [];
  }


  const marketResults =
    await Promise.all(
      uniqueEvents.map(fetchMarkets)
    );


  /* =====================================================
     FLATTEN MARKETS
  ===================================================== */

  function flattenMarkets(groups) {

    const output = [];

    if (!Array.isArray(groups)) {
      return output;
    }

    groups.forEach(group => {

      if (!group) {
        return;
      }


      /*
       * Some APIs may put markets inside a group.
       */

      const nestedMarkets =
        Array.isArray(group.markets)
          ? group.markets
          : null;


      if (nestedMarkets) {

        nestedMarkets.forEach(
          nested => {

            processMarket(
              nested,
              output
            );

          }
        );

      } else {

        processMarket(
          group,
          output
        );

      }

    });

    return output;
  }


  function processMarket(
    market,
    output
  ) {

    if (!market) {
      return;
    }


    const marketId =
      String(
        market.id ??
        market.marketId ??
        ""
      );


    const marketName =
      market.desc ??
      market.marketName ??
      market.name ??
      market.description ??
      "Market";


    const specifier =
      market.specifier ??
      null;


    /*
     * SportyBet may use:
     *
     * outcomes: [...]
     *
     * or:
     *
     * outcome: [...]
     */

    let outcomes =
      Array.isArray(market.outcomes)
        ? market.outcomes
        : [];


    if (
      !outcomes.length &&
      Array.isArray(market.outcome)
    ) {

      outcomes =
        market.outcome;

    }


    outcomes.forEach(outcome => {

      if (!outcome) {
        return;
      }


      const outcomeId =
        String(
          outcome.id ??
          outcome.outcomeId ??
          ""
        );


      const pick =
        outcome.desc ??
        outcome.name ??
        outcome.outcomeName ??
        outcome.label ??
        "";


      const odds =
        Number(
          outcome.odds ??
          outcome.odd ??
          0
        );


      if (
        marketId &&
        outcomeId &&
        pick
      ) {

        output.push({

          marketId,

          market:
            marketName,

          specifier,

          outcomeId,

          pick,

          odds:
            Number.isFinite(odds)
              ? odds
              : 0

        });

      }

    });

  }


  /* =====================================================
     BUILD VERIFIED EVENT DATA
  ===================================================== */

  const verifiedEvents =
    marketResults.map(result => ({

      original:
        result.original,

      markets:
        flattenMarkets(
          result.markets
        ),

      error:
        result.error

    }));


  /* =====================================================
     FIND ORIGINAL SELECTION IN SPORTYBET MARKETS
  ===================================================== */

  function findOriginalMarket(
    original,
    markets
  ) {

    return markets.find(market => {

      const sameMarket =
        String(market.marketId) ===
        String(original.marketId);

      const sameOutcome =
        String(market.outcomeId) ===
        String(original.outcomeId);

      const originalSpecifier =
        original.specifier ??
        null;

      const marketSpecifier =
        market.specifier ??
        null;

      const sameSpecifier =
        String(originalSpecifier || "") ===
        String(marketSpecifier || "");

      return (
        sameMarket &&
        sameOutcome &&
        sameSpecifier
      );

    });

  }


  /* =====================================================
     GEMINI
  ===================================================== */

  async function askGemini(
    eventData
  ) {

    const original =
      eventData.original;

    const markets =
      eventData.markets;


    if (!markets.length) {

      return {
        success: false,
        error:
          eventData.error ||
          "No readable SportyBet markets were found."
      };

    }


    /*
     * Give Gemini the actual verified markets.
     */

    const marketList =
      markets
        .slice(0, 500)
        .map(
          (m, i) =>
            `${i + 1}. marketId=${m.marketId}; market=${m.market}; specifier=${m.specifier ?? "null"}; outcomeId=${m.outcomeId}; pick=${m.pick}; odds=${m.odds}`
        )
        .join("\n");


    const prompt = `
You are selecting ONE SportyBet option for ONE football game.

GAME:
${original.event}

ORIGINAL:
Market: ${original.market}
Pick: ${original.pick}
Odds: ${original.odds}

VERIFIED SPORTYBET OPTIONS:
${marketList}

Choose EXACTLY ONE option from the verified list.

IMPORTANT:
- Do not invent anything.
- marketId MUST come from the list.
- outcomeId MUST come from the list.
- specifier MUST come from the list.
- odds MUST come from the list.
- Return exactly one selection.
- Keep the explanation short and natural.

Return ONLY JSON:

{
  "marketId": "string",
  "specifier": "string or null",
  "outcomeId": "string",
  "reason": "one short natural sentence"
}
`;


    try {

      const response =
        await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
          encodeURIComponent(
            GEMINI_API_KEY
          ),
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json"
            },

            body: JSON.stringify({

              contents: [
                {
                  parts: [
                    {
                      text: prompt
                    }
                  ]
                }
              ],

              generationConfig: {
                temperature: 0.1,
                responseMimeType:
                  "application/json"
              }

            })
          }
        );


      const raw =
        await response.text();

      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        return {
          success: false,
          error: "Invalid response from Gemini."
        };
      }


      if (!response.ok) {

        return {
          success: false,
          error:
            data?.error?.message ||
            "Gemini request failed."
        };

      }


      const text =
        data?.candidates?.[0]
          ?.content?.parts?.[0]
          ?.text;


      if (!text) {

        return {
          success: false,
          error:
            "Gemini returned no recommendation."
        };

      }


      let recommendation;

      try {
        recommendation =
          JSON.parse(text);
      } catch {
        return {
          success: false,
          error:
            "Gemini returned invalid JSON."
        };
      }


      return {
        success: true,
        recommendation
      };

    } catch (error) {

      return {
        success: false,
        error:
          error.message ||
          "Gemini request failed."
      };

    }

  }


  /* =====================================================
     CREATE AI RECOMMENDATION FOR EVERY GAME
  ===================================================== */

  const aiRecommendations = [];
  const aiErrors = [];


  for (
    const eventData of verifiedEvents
  ) {

    let recommendation =
      null;


    /*
     * First try AI.
     */

    const ai =
      await askGemini(
        eventData
      );


    if (
      ai.success
    ) {

      const r =
        ai.recommendation;


      const verified =
        eventData.markets.find(m => {

          const sameMarket =
            String(m.marketId) ===
            String(r.marketId);

          const sameOutcome =
            String(m.outcomeId) ===
            String(r.outcomeId);

          const sameSpecifier =
            String(m.specifier || "") ===
            String(r.specifier || "");


          return (
            sameMarket &&
            sameOutcome &&
            sameSpecifier
          );

        });


      if (verified) {

        recommendation = {

          event:
            eventData.original.event,

          eventId:
            eventData.original.eventId,

          gameId:
            eventData.original.gameId,

          marketId:
            verified.marketId,

          specifier:
            verified.specifier,

          outcomeId:
            verified.outcomeId,

          market:
            verified.market,

          pick:
            verified.pick,

          odds:
            verified.odds,

          reason:
            r.reason ||
            "This alternative is available on SportyBet."

        };

      }

    }


    /*
     * If AI failed, ALWAYS try the original
     * selection as a verified fallback.
     */

    if (!recommendation) {

      const originalMarket =
        findOriginalMarket(
          eventData.original,
          eventData.markets
        );


      if (originalMarket) {

        recommendation = {

          event:
            eventData.original.event,

          eventId:
            eventData.original.eventId,

          gameId:
            eventData.original.gameId,

          marketId:
            originalMarket.marketId,

          specifier:
            originalMarket.specifier,

          outcomeId:
            originalMarket.outcomeId,

          market:
            originalMarket.market,

          pick:
            originalMarket.pick,

          odds:
            originalMarket.odds,

          reason:
            "The original selection was kept because it could be verified on SportyBet."

        };

      }

    }


    /*
     * If absolutely nothing could be verified,
     * record the reason.
     */

    if (!recommendation) {

      aiErrors.push({

        event:
          eventData.original.event,

        eventId:
          eventData.original.eventId,

        error:
          ai.error ||
          eventData.error ||
          "No verified selection could be created."

      });

    } else {

      aiRecommendations.push(
        recommendation
      );

    }

  }


  /* =====================================================
     GUARANTEE ONE SELECTION PER GAME
  ===================================================== */

  const aiByEvent =
    new Map();


  aiRecommendations.forEach(selection => {

    const key =
      selection.eventId ||
      selection.gameId ||
      selection.event;


    if (!aiByEvent.has(key)) {

      aiByEvent.set(
        key,
        selection
      );

    }

  });


  const finalAI =
    Array.from(
      aiByEvent.values()
    );


  /* =====================================================
     SAFE / BALANCED / RISKY
  ===================================================== */

  const total =
    originalSelections.length;


  let safeCount;
  let balancedCount;


  if (total <= 2) {

    safeCount = total;
    balancedCount = total;

  } else {

    safeCount =
      Math.max(
        2,
        Math.ceil(total * 0.5)
      );


    balancedCount =
      Math.max(
        safeCount + 1,
        Math.ceil(total * 0.75)
      );


    balancedCount =
      Math.min(
        balancedCount,
        total - 1
      );

  }


  const sorted =
    [...originalSelections]
      .sort(
        (a, b) =>
          (a.odds || 999) -
          (b.odds || 999)
      );


  const safe =
    sorted
      .slice(0, safeCount)
      .map(s => ({
        ...s,
        reason:
          "This keeps the less aggressive side of the original selections."
      }));


  const balanced =
    sorted
      .slice(0, balancedCount)
      .map(s => ({
        ...s,
        reason:
          "This keeps a middle-ground mix from the original selections."
      }));


  const risky =
    originalSelections.map(s => ({
      ...s,
      reason:
        "The original selection is kept, adding more action to the ticket."
    }));


  /* =====================================================
     SUMMARIES
  ===================================================== */

  const profiles = {

    SAFE: {

      summary:
        "I’ve trimmed this down to the less aggressive picks.",

      selections:
        safe

    },


    BALANCED: {

      summary:
        "A middle-ground mix — not too cautious, not too aggressive.",

      selections:
        balanced

    },


    RISKY: {

      summary:
        "This keeps more of the action, but there’s less room for mistakes.",

      selections:
        risky

    },


    "AI RECOMMENDED": {

      summary:
        `I looked at the available SportyBet markets and picked one verified option for each game.`,

      selections:
        finalAI

    }

  };


  /* =====================================================
     VERIFICATION
  ===================================================== */

  const verification = {

    totalGames:

      totalGames,

    gamesWithMarkets:

      verifiedEvents.filter(
        e =>
          e.markets.length > 0
      ).length,

    aiExpected:

      totalGames,

    aiCreated:

      finalAI.length,

    aiComplete:

      finalAI.length === totalGames,

    aiErrors

  };


  /* =====================================================
     RETURN
  ===================================================== */

  return res.status(200).json({

    success: true,

    profiles,

    verification

  });

}
