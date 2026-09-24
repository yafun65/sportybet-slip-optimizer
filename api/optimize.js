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


  /* =====================================================
     INPUT
  ===================================================== */

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
     ORIGINAL SELECTIONS
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
        s.specifier ?? null,

      outcomeId:
        String(s.outcomeId || ""),

      startTime:
        s.startTime || ""
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

  async function fetchEventMarkets(selection) {

    if (!selection.eventId) {
      return {
        original: selection,
        markets: [],
        error: "Missing event ID."
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
          error: "Invalid JSON returned by Render."
        };
      }

      if (!response.ok) {
        return {
          original: selection,
          markets: [],
          error:
            data?.error ||
            data?.message ||
            `SportyBet market request failed (${response.status}).`
        };
      }


      /*
       * IMPORTANT:
       *
       * The Render endpoint may return:
       *
       * 1. [ market, market, market ]
       *
       * 2. { markets: [...] }
       *
       * 3. { data: [...] }
       *
       * 4. { data: { markets: [...] } }
       *
       * 5. { outcomes: [...] }
       *
       * 6. { data: { outcomes: [...] } }
       *
       * 7. nested markets containing outcomes.
       *
       * We handle all of them.
       */

      const markets =
        parseSportyBetMarkets(data);


      return {
        original: selection,
        markets,
        error:
          markets.length
            ? null
            : "SportyBet returned no readable market outcomes."
      };

    } catch (error) {

      return {
        original: selection,
        markets: [],
        error:
          error.message ||
          "Unable to connect to the market endpoint."
      };

    }

  }


  /* =====================================================
     PARSE SPORTYBET MARKETS
  ===================================================== */

  function parseSportyBetMarkets(data) {

    let source = null;


    /* Direct array */

    if (Array.isArray(data)) {
      source = data;
    }


    /* { markets: [] } */

    else if (
      Array.isArray(data?.markets)
    ) {
      source = data.markets;
    }


    /* { outcomes: [] } */

    else if (
      Array.isArray(data?.outcomes)
    ) {
      source = data.outcomes;
    }


    /* { data: [] } */

    else if (
      Array.isArray(data?.data)
    ) {
      source = data.data;
    }


    /* { data: { markets: [] } } */

    else if (
      Array.isArray(data?.data?.markets)
    ) {
      source = data.data.markets;
    }


    /* { data: { outcomes: [] } } */

    else if (
      Array.isArray(data?.data?.outcomes)
    ) {
      source = data.data.outcomes;
    }


    /* { event: { markets: [] } } */

    else if (
      Array.isArray(data?.event?.markets)
    ) {
      source = data.event.markets;
    }


    /* { result: { markets: [] } } */

    else if (
      Array.isArray(data?.result?.markets)
    ) {
      source = data.result.markets;
    }


    /* { result: { outcomes: [] } } */

    else if (
      Array.isArray(data?.result?.outcomes)
    ) {
      source = data.result.outcomes;
    }


    if (!Array.isArray(source)) {
      return [];
    }


    const output = [];


    source.forEach(item => {

      if (!item) {
        return;
      }


      /*
       * CASE 1:
       *
       * This item is already a flat outcome:
       *
       * {
       *   marketId,
       *   marketDesc,
       *   outcomeId,
       *   outcomeDesc,
       *   odds,
       *   specifier
       * }
       */

      const directMarketId =
        item.marketId ??
        item.market_id;

      const directOutcomeId =
        item.outcomeId ??
        item.outcome_id;

      const directMarketName =
        item.marketDesc ??
        item.marketName ??
        item.market ??
        item.desc;

      const directPick =
        item.outcomeDesc ??
        item.outcomeName ??
        item.pick ??
        item.outcome;


      if (
        directMarketId != null &&
        directOutcomeId != null &&
        directPick
      ) {

        output.push({

          marketId:
            String(directMarketId),

          market:
            String(
              directMarketName ||
              "Market"
            ),

          specifier:
            item.specifier ??
            null,

          outcomeId:
            String(directOutcomeId),

          pick:
            String(directPick),

          odds:
            Number(
              item.odds ??
              item.odd ??
              0
            ) || 0

        });

        return;
      }


      /*
       * CASE 2:
       *
       * This is a market containing outcomes.
       */

      const marketId =
        item.id ??
        item.marketId ??
        item.market_id;


      const marketName =
        item.desc ??
        item.marketDesc ??
        item.marketName ??
        item.name ??
        "Market";


      const specifier =
        item.specifier ??
        null;


      let outcomes =
        Array.isArray(item.outcomes)
          ? item.outcomes
          : [];


      if (
        !outcomes.length &&
        Array.isArray(item.outcome)
      ) {
        outcomes =
          item.outcome;
      }


      outcomes.forEach(outcome => {

        if (!outcome) {
          return;
        }


        const outcomeId =
          outcome.id ??
          outcome.outcomeId ??
          outcome.outcome_id;


        const pick =
          outcome.desc ??
          outcome.outcomeDesc ??
          outcome.name ??
          outcome.outcomeName ??
          outcome.label;


        const odds =
          Number(
            outcome.odds ??
            outcome.odd ??
            0
          ) || 0;


        if (
          marketId != null &&
          outcomeId != null &&
          pick
        ) {

          output.push({

            marketId:
              String(marketId),

            market:
              String(marketName),

            specifier,

            outcomeId:
              String(outcomeId),

            pick:
              String(pick),

            odds

          });

        }

      });

    });


    /*
     * Remove duplicate market/outcome rows.
     */

    const unique =
      new Map();


    output.forEach(item => {

      const key =
        [
          item.marketId,
          item.specifier || "",
          item.outcomeId
        ].join("|");


      if (!unique.has(key)) {
        unique.set(key, item);
      }

    });


    return Array.from(
      unique.values()
    );

  }


  /* =====================================================
     LOAD MARKETS FOR EVERY GAME
  ===================================================== */

  const marketResults =
    await Promise.all(
      uniqueEvents.map(
        fetchEventMarkets
      )
    );


  const verifiedEvents =
    marketResults.map(result => ({

      original:
        result.original,

      markets:
        result.markets,

      error:
        result.error

    }));


  /* =====================================================
     FIND ORIGINAL SELECTION
  ===================================================== */

  function findOriginalSelection(
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

      const sameSpecifier =
        String(
          market.specifier || ""
        ) ===
        String(
          original.specifier || ""
        );

      return (
        sameMarket &&
        sameOutcome &&
        sameSpecifier
      );

    });

  }


  /* =====================================================
     GEMINI — ONE GAME AT A TIME
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
          "No verified SportyBet markets available."
      };

    }


    /*
     * Send the actual verified options to Gemini.
     */

    const marketList =
      markets
        .slice(0, 600)
        .map(
          (m, index) =>
            `${index + 1}. marketId=${m.marketId} | market=${m.market} | specifier=${m.specifier ?? "null"} | outcomeId=${m.outcomeId} | pick=${m.pick} | odds=${m.odds}`
        )
        .join("\n");


    const prompt = `
You are helping select ONE football betting option.

GAME:
${original.event}

ORIGINAL SELECTION:
Market: ${original.market}
Pick: ${original.pick}
Odds: ${original.odds}

THESE ARE REAL SPORTYBET OPTIONS:
${marketList}

Choose exactly ONE option from that list.

Rules:
- Never invent a market.
- Never invent an outcome.
- Never invent an odds value.
- marketId must come from the list.
- outcomeId must come from the list.
- specifier must come from the list.
- Choose exactly one option.
- Keep the reason short and natural.

Return ONLY this JSON:

{
  "marketId": "string",
  "specifier": "string or null",
  "outcomeId": "string",
  "reason": "short natural reason"
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
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({

                contents: [
                  {
                    parts: [
                      {
                        text:
                          prompt
                      }
                    ]
                  }
                ],

                generationConfig: {

                  temperature:
                    0.1,

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
        data =
          JSON.parse(raw);
      } catch {
        return {
          success: false,
          error:
            "Gemini returned invalid JSON."
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
            "Gemini recommendation was not valid JSON."
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
     CREATE EXACTLY ONE AI PICK PER GAME
  ===================================================== */

  const aiRecommendations = [];
  const aiErrors = [];


  for (
    const eventData of verifiedEvents
  ) {

    let chosen =
      null;


    /*
     * Ask Gemini.
     */

    const ai =
      await askGemini(
        eventData
      );


    if (ai.success) {

      const r =
        ai.recommendation;


      /*
       * Verify Gemini's IDs against
       * the actual SportyBet market list.
       */

      const verified =
        eventData.markets.find(
          market => {

            return (

              String(
                market.marketId
              ) ===
              String(
                r.marketId
              )

              &&

              String(
                market.outcomeId
              ) ===
              String(
                r.outcomeId
              )

              &&

              String(
                market.specifier || ""
              ) ===
              String(
                r.specifier || ""
              )

            );

          }
        );


      if (verified) {

        chosen = {

          event:
            eventData.original.event,

          eventId:
            eventData.original.eventId,

          gameId:
            eventData.original.gameId,

          market:
            verified.market,

          pick:
            verified.pick,

          odds:
            verified.odds,

          marketId:
            verified.marketId,

          specifier:
            verified.specifier,

          outcomeId:
            verified.outcomeId,

          reason:
            r.reason ||
            "This alternative is available on SportyBet."

        };

      }

    }


    /*
     * IMPORTANT FALLBACK
     *
     * If Gemini fails or returns something
     * that cannot be verified, use the ORIGINAL
     * selection — but only if SportyBet confirms
     * that it still exists.
     */

    if (!chosen) {

      const originalVerified =
        findOriginalSelection(
          eventData.original,
          eventData.markets
        );


      if (originalVerified) {

        chosen = {

          event:
            eventData.original.event,

          eventId:
            eventData.original.eventId,

          gameId:
            eventData.original.gameId,

          market:
            originalVerified.market,

          pick:
            originalVerified.pick,

          odds:
            originalVerified.odds,

          marketId:
            originalVerified.marketId,

          specifier:
            originalVerified.specifier,

          outcomeId:
            originalVerified.outcomeId,

          reason:
            "The original selection was kept because it is still available on SportyBet."

        };

      }

    }


    if (chosen) {

      aiRecommendations.push(
        chosen
      );

    } else {

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

    }

  }


  /* =====================================================
     ENSURE UNIQUE GAME COUNT
  ===================================================== */

  const aiMap =
    new Map();


  aiRecommendations.forEach(
    selection => {

      const key =
        selection.eventId ||
        selection.gameId ||
        selection.event;


      if (!aiMap.has(key)) {

        aiMap.set(
          key,
          selection
        );

      }

    }
  );


  const finalAI =
    Array.from(
      aiMap.values()
    );


  /* =====================================================
     SAFE / BALANCED / RISKY
  ===================================================== */

  const total =
    originalSelections.length;


  let safeCount;
  let balancedCount;


  if (total <= 2) {

    safeCount =
      total;

    balancedCount =
      total;

  } else {

    safeCount =
      Math.max(
        2,
        Math.ceil(
          total * 0.5
        )
      );


    balancedCount =
      Math.max(
        safeCount + 1,
        Math.ceil(
          total * 0.75
        )
      );


    balancedCount =
      Math.min(
        balancedCount,
        total - 1
      );

  }


  /*
   * Lowest odds first.
   */

  const sorted =
    [...originalSelections]
      .sort(
        (a, b) =>
          (a.odds || 999) -
          (b.odds || 999)
      );


  const safe =
    sorted
      .slice(
        0,
        safeCount
      )
      .map(selection => ({

        ...selection,

        reason:
          "This keeps the less aggressive side of the original selections."

      }));


  const balanced =
    sorted
      .slice(
        0,
        balancedCount
      )
      .map(selection => ({

        ...selection,

        reason:
          "This keeps a middle-ground mix from the original selections."

      }));


  const risky =
    originalSelections
      .map(selection => ({

        ...selection,

        reason:
          "The original selection is kept, adding more action to the ticket."

      }));


  /* =====================================================
     PROFILES
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
        event =>
          event.markets.length > 0
      ).length,

    aiExpected:
      totalGames,

    aiCreated:
      finalAI.length,

    aiComplete:
      finalAI.length === totalGames,

    aiErrors:

      aiErrors

  };


  /* =====================================================
     RESPONSE
  ===================================================== */

  return res.status(200).json({

    success: true,

    profiles,

    verification

  });

}
