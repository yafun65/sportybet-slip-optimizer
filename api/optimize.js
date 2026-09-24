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


  /* -----------------------------------------
     INPUT
  ----------------------------------------- */

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


  /* -----------------------------------------
     CLEAN ORIGINAL SELECTIONS
  ----------------------------------------- */

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
        s.specifier ||
        null,

      outcomeId:
        String(s.outcomeId || ""),

      startTime:
        s.startTime ||
        ""

    }));


  /* -----------------------------------------
     UNIQUE EVENTS
  ----------------------------------------- */

  const eventMap =
    new Map();


  originalSelections.forEach(selection => {

    const eventKey =
      selection.eventId ||
      selection.gameId ||
      selection.event;


    if (!eventMap.has(eventKey)) {

      eventMap.set(
        eventKey,
        selection
      );

    }

  });


  const uniqueEvents =
    Array.from(eventMap.values());


  const totalGames =
    uniqueEvents.length;


  /* -----------------------------------------
     FETCH SPORTYBET MARKETS
  ----------------------------------------- */

  async function getMarkets(selection) {

    const eventId =
      selection.eventId;


    if (!eventId) {

      return {
        selection,
        markets: [],
        error: "Missing event ID."
      };

    }


    try {

      const response =
        await fetch(
          `${API_BASE}/event-markets/${encodeURIComponent(eventId)}`
        );


      const raw =
        await response.text();


      let data;

      try {

        data =
          JSON.parse(raw);

      } catch {

        return {
          selection,
          markets: [],
          error: "Invalid market response."
        };

      }


      if (!response.ok) {

        return {
          selection,
          markets: [],
          error:
            data?.error ||
            "Unable to load markets."
        };

      }


      /*
       * The Render API may return the market
       * groups directly or inside different
       * properties. Handle the common formats.
       */

      let marketGroups = [];


      if (Array.isArray(data)) {

        marketGroups = data;

      }

      else if (
        Array.isArray(data?.markets)
      ) {

        marketGroups =
          data.markets;

      }

      else if (
        Array.isArray(data?.data)
      ) {

        marketGroups =
          data.data;

      }

      else if (
        Array.isArray(data?.event?.markets)
      ) {

        marketGroups =
          data.event.markets;

      }


      return {
        selection,
        markets: marketGroups,
        error: null
      };


    } catch (error) {

      return {
        selection,
        markets: [],
        error:
          error.message ||
          "Market request failed."
      };

    }

  }


  const marketResults =
    await Promise.all(
      uniqueEvents.map(
        getMarkets
      )
    );


  /* -----------------------------------------
     FLATTEN AVAILABLE MARKETS
  ----------------------------------------- */

  function flattenMarkets(
    marketGroups
  ) {

    const output = [];


    if (
      !Array.isArray(marketGroups)
    ) {

      return output;

    }


    marketGroups.forEach(
      market => {

        if (!market) {
          return;
        }


        const marketId =
          String(
            market.id ||
            market.marketId ||
            ""
          );


        const marketName =
          market.desc ||
          market.marketName ||
          market.name ||
          "Market";


        const specifier =
          market.specifier ||
          null;


        const outcomes =
          Array.isArray(
            market.outcomes
          )
            ? market.outcomes
            : [];


        outcomes.forEach(
          outcome => {

            if (!outcome) {
              return;
            }


            const outcomeId =
              String(
                outcome.id ||
                outcome.outcomeId ||
                ""
              );


            const pick =
              outcome.desc ||
              outcome.name ||
              outcome.outcomeName ||
              "";


            const odds =
              Number(
                outcome.odds
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

          }
        );

      }
    );


    return output;

  }


  /* -----------------------------------------
     BUILD VERIFIED EVENT DATA
  ----------------------------------------- */

  const verifiedEvents =
    marketResults.map(result => ({

      original:
        result.selection,

      markets:
        flattenMarkets(
          result.markets
        ),

      error:
        result.error

    }));


  /* -----------------------------------------
     GEMINI REQUEST
  ----------------------------------------- */

  async function askGemini(
    eventData
  ) {

    const original =
      eventData.original;


    const availableMarkets =
      eventData.markets;


    /*
     * If SportyBet did not return markets,
     * don't invent anything.
     */

    if (
      !availableMarkets.length
    ) {

      return {
        success: false,
        error:
          eventData.error ||
          "No verified markets available."
      };

    }


    /*
     * Limit the market list so the AI prompt
     * stays manageable.
     */

    const marketList =
      availableMarkets
        .slice(0, 300)
        .map(
          (market, index) =>
            `${index + 1}. marketId=${market.marketId} | market=${market.market} | specifier=${market.specifier || "none"} | outcomeId=${market.outcomeId} | pick=${market.pick} | odds=${market.odds}`
        )
        .join("\n");


    const prompt = `

You are helping analyze ONE football game for a SportyBet selection optimizer.

GAME:
${original.event}

ORIGINAL SELECTION:
Market: ${original.market}
Pick: ${original.pick}
Odds: ${original.odds}

AVAILABLE SPORTYBET MARKETS:
${marketList}

TASK:

Choose exactly ONE selection from the AVAILABLE SPORTYBET MARKETS.

The chosen selection MUST:
1. Exist exactly in the supplied market list.
2. Use the exact marketId.
3. Use the exact outcomeId.
4. Use the exact specifier when one exists.
5. Never invent a market.
6. Never invent an outcome.
7. Never invent odds.
8. Return only ONE selection for this game.

Prefer a sensible alternative to the original selection when appropriate, but if the original selection is a reasonable verified option, it may be kept.

STYLE:
Write the reason naturally, like a knowledgeable football fan explaining the choice.

Do not use robotic phrases such as:
- optimize stability
- lower variance profile
- selection profile
- relative variance

Keep the reason to one short sentence.

Return ONLY valid JSON in this exact structure:

{
  "marketId": "string",
  "specifier": "string or null",
  "outcomeId": "string",
  "market": "string",
  "pick": "string",
  "odds": 0,
  "reason": "short natural explanation"
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

                temperature: 0.2,

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
          "AI request failed."
      };

    }

  }


  /* -----------------------------------------
     VERIFY AI RECOMMENDATION
  ----------------------------------------- */

  function verifyRecommendation(
    recommendation,
    availableMarkets
  ) {

    if (
      !recommendation ||
      !Array.isArray(
        availableMarkets
      )
    ) {

      return null;

    }


    const found =
      availableMarkets.find(
        market => {

          const sameMarket =
            String(
              market.marketId
            ) ===
            String(
              recommendation.marketId
            );


          const sameOutcome =
            String(
              market.outcomeId
            ) ===
            String(
              recommendation.outcomeId
            );


          const aiSpecifier =
            recommendation.specifier ||
            null;

          const marketSpecifier =
            market.specifier ||
            null;


          const sameSpecifier =
            aiSpecifier ===
            marketSpecifier;


          return (
            sameMarket &&
            sameOutcome &&
            sameSpecifier
          );

        }
      );


    if (!found) {

      return null;

    }


    return {

      event:
        recommendation.event ||
        "",

      market:
        found.market,

      pick:
        found.pick,

      odds:
        found.odds,

      eventId:
        recommendation.eventId ||
        "",

      gameId:
        recommendation.gameId ||
        "",

      marketId:
        found.marketId,

      specifier:
        found.specifier,

      outcomeId:
        found.outcomeId,

      reason:
        recommendation.reason ||
        "This alternative is available on SportyBet."

    };

  }


  /* -----------------------------------------
     AI RECOMMENDED
  ----------------------------------------- */

  const aiRecommendations = [];

  const aiErrors = [];


  /*
   * IMPORTANT:
   *
   * Run AI separately for EVERY UNIQUE GAME.
   *
   * This prevents the AI from returning only
   * one recommendation for the entire booking.
   */

  for (
    const eventData of verifiedEvents
  ) {

    const result =
      await askGemini(
        eventData
      );


    if (
      !result.success
    ) {

      aiErrors.push({

        event:
          eventData.original.event,

        error:
          result.error

      });


      /*
       * FALLBACK:
       * If the original selection itself
       * exists in the verified markets,
       * use it.
       */

      const fallback =
        eventData.markets.find(
          market =>

            String(
              market.marketId
            ) ===
            String(
              eventData.original.marketId
            ) &&

            String(
              market.outcomeId
            ) ===
            String(
              eventData.original.outcomeId
            ) &&

            String(
              market.specifier || ""
            ) ===
            String(
              eventData.original.specifier || ""
            )
        );


      if (fallback) {

        aiRecommendations.push({

          event:
            eventData.original.event,

          market:
            fallback.market,

          pick:
            fallback.pick,

          odds:
            fallback.odds,

          eventId:
            eventData.original.eventId,

          gameId:
            eventData.original.gameId,

          marketId:
            fallback.marketId,

          specifier:
            fallback.specifier,

          outcomeId:
            fallback.outcomeId,

          reason:
            "The original selection was kept because it could be verified on SportyBet."

        });

      }


      continue;

    }


    const verified =
      verifyRecommendation(
        result.recommendation,
        eventData.markets
      );


    if (verified) {

      /*
       * Always attach the correct IDs from
       * the ORIGINAL event.
       */

      verified.event =
        eventData.original.event;

      verified.eventId =
        eventData.original.eventId;

      verified.gameId =
        eventData.original.gameId;


      aiRecommendations.push(
        verified
      );

    }

    else {

      aiErrors.push({

        event:
          eventData.original.event,

        error:
          "AI returned a selection that could not be verified."

      });


      /*
       * Verified original fallback.
       */

      const fallback =
        eventData.markets.find(
          market =>

            String(
              market.marketId
            ) ===
            String(
              eventData.original.marketId
            ) &&

            String(
              market.outcomeId
            ) ===
            String(
              eventData.original.outcomeId
            ) &&

            String(
              market.specifier || ""
            ) ===
            String(
              eventData.original.specifier || ""
            )
        );


      if (fallback) {

        aiRecommendations.push({

          event:
            eventData.original.event,

          market:
            fallback.market,

          pick:
            fallback.pick,

          odds:
            fallback.odds,

          eventId:
            eventData.original.eventId,

          gameId:
            eventData.original.gameId,

          marketId:
            fallback.marketId,

          specifier:
            fallback.specifier,

          outcomeId:
            fallback.outcomeId,

          reason:
            "The original selection was kept because it could be verified on SportyBet."

        });

      }

    }

  }


  /* -----------------------------------------
     REMOVE DUPLICATE AI EVENTS
  ----------------------------------------- */

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


  /* -----------------------------------------
     CREATE SAFE / BALANCED / RISKY
  ----------------------------------------- */

  const totalSelections =
    originalSelections.length;


  /*
   * SAFE
   *
   * Keep roughly 50% of the original
   * selections, but never fewer than 2
   * when there are at least 2 available.
   */

  let safeCount;


  if (
    totalSelections <= 2
  ) {

    safeCount =
      totalSelections;

  }

  else {

    safeCount =
      Math.max(
        2,
        Math.ceil(
          totalSelections * 0.5
        )
      );

  }


  /*
   * BALANCED
   *
   * Always sits between SAFE and RISKY.
   */

  let balancedCount;


  if (
    totalSelections <= 2
  ) {

    balancedCount =
      totalSelections;

  }

  else {

    balancedCount =
      Math.max(
        safeCount + 1,
        Math.ceil(
          totalSelections * 0.75
        )
      );

    balancedCount =
      Math.min(
        balancedCount,
        totalSelections - 1
      );

  }


  /*
   * RISKY = all original selections.
   */

  const riskyCount =
    totalSelections;


  /*
   * Sort original selections by odds.
   *
   * Lower odds first for SAFE.
   * Middle range for BALANCED.
   * All for RISKY.
   */

  const sortedOriginal =
    [...originalSelections]
      .sort(
        (a, b) =>
          (a.odds || 999) -
          (b.odds || 999)
      );


  const safeSelections =
    sortedOriginal
      .slice(
        0,
        safeCount
      );


  /*
   * Balanced deliberately takes more
   * selections than SAFE.
   *
   * We take the safer selections first,
   * then add additional selections.
   */

  const balancedSelections =
    sortedOriginal
      .slice(
        0,
        balancedCount
      );


  const riskySelections =
    [...originalSelections];


  /* -----------------------------------------
     ADD PROFILE REASONS
  ----------------------------------------- */

  function addReasons(
    selections,
    profile
  ) {

    return selections.map(
      selection => {

        let reason =
          selection.reason;


        if (!reason) {

          if (
            profile === "SAFE"
          ) {

            reason =
              "This keeps the less aggressive side of the original selections.";

          }

          else if (
            profile === "BALANCED"
          ) {

            reason =
              "This keeps a middle-ground mix from the original selections.";

          }

          else if (
            profile === "RISKY"
          ) {

            reason =
              "The original selection is kept, adding more action to the ticket.";

          }

        }


        return {
          ...selection,
          reason
        };

      }
    );

  }


  const safe =
    addReasons(
      safeSelections,
      "SAFE"
    );


  const balanced =
    addReasons(
      balancedSelections,
      "BALANCED"
    );


  const risky =
    addReasons(
      riskySelections,
      "RISKY"
    );


  /* -----------------------------------------
     PROFILE SUMMARIES
  ----------------------------------------- */

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
        "I looked at the available SportyBet markets and picked one verified option for each game.",

      selections:
        finalAI

    }

  };


  /* -----------------------------------------
     VERIFICATION INFORMATION
  ----------------------------------------- */

  const verification = {

    totalGames,

    verifiedGames:
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

    errors:
      verifiedEvents
        .filter(
          event =>
            event.error
        )
        .map(
          event => ({

            event:
              event.original.event,

            error:
              event.error

          })
        ),

    aiErrors

  };


  /* -----------------------------------------
     RESPONSE
  ----------------------------------------- */

  return res.status(200).json({

    success: true,

    profiles,

    verification

  });

}
