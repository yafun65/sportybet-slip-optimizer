export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const { selections } = req.body || {};

    if (!Array.isArray(selections) || selections.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No selections received"
      });
    }

    const RENDER_API =
      process.env.RENDER_API_URL ||
      "https://sportybet-api.onrender.com";

    const GEMINI_KEY = process.env.GEMINI_API_KEY;

    const clean = (value) =>
      String(value ?? "").trim();

    /*
    =========================================================
    1. UNIQUE EVENTS
    =========================================================
    */

    const uniqueSelections = [];
    const seenEvents = new Set();

    for (const selection of selections) {
      const eventId = clean(selection.eventId);

      if (!eventId) continue;

      if (seenEvents.has(eventId)) continue;

      seenEvents.add(eventId);
      uniqueSelections.push(selection);
    }

    const eventIds = uniqueSelections.map(
      (selection) => clean(selection.eventId)
    );

    /*
    =========================================================
    2. GET BATCH SPORTYBET MARKETS
    =========================================================
    */

    let batchData;

    try {
      const response = await fetch(
        `${RENDER_API}/event-markets?eventIds=${encodeURIComponent(
          eventIds.join(",")
        )}`
      );

      if (!response.ok) {
        return res.status(502).json({
          success: false,
          error:
            "SportyBet market service failed",
          status: response.status
        });
      }

      batchData = await response.json();
    } catch (error) {
      return res.status(502).json({
        success: false,
        error:
          "Could not connect to SportyBet market service",
        details: error.message
      });
    }

    if (!Array.isArray(batchData?.results)) {
      return res.status(502).json({
        success: false,
        error:
          "Invalid SportyBet market response"
      });
    }

    /*
    =========================================================
    3. STORE BATCH RESULTS
    =========================================================
    */

    const eventMap = new Map();

    for (const result of batchData.results) {
      if (!result) continue;

      const eventId = clean(
        result.eventId ||
        result.event?.eventId
      );

      if (!eventId) continue;

      const event =
        result.event || {
          eventId,
          gameId: result.gameId,
          homeTeamName:
            result.homeTeamName,
          awayTeamName:
            result.awayTeamName,
          startTime:
            result.startTime
        };

      const markets = Array.isArray(
        result.markets
      )
        ? result.markets
        : [];

      eventMap.set(eventId, {
        event,
        markets
      });
    }

    /*
    =========================================================
    4. FIND EVENTS WITH NO USABLE MARKETS
    =========================================================

    A batch result existing does NOT necessarily mean it
    contains the actual market data.

    Only request the individual endpoint for events that
    need it.
    =========================================================
    */

    const missingMarketEvents = [];

    for (const eventId of eventIds) {
      const existing =
        eventMap.get(eventId);

      if (
        !existing ||
        !Array.isArray(existing.markets) ||
        existing.markets.length === 0
      ) {
        missingMarketEvents.push(
          eventId
        );
      }
    }

    /*
    =========================================================
    5. LOAD MISSING EVENTS INDIVIDUALLY
    =========================================================

    Maximum is normally only a few requests because the
    batch endpoint already supplied most events.

    =========================================================
    */

    for (const eventId of missingMarketEvents) {
      try {
        const response = await fetch(
          `${RENDER_API}/event-markets/${encodeURIComponent(
            eventId
          )}`
        );

        if (!response.ok) {
          continue;
        }

        const data =
          await response.json();

        if (
          data?.event &&
          Array.isArray(data.markets)
        ) {
          eventMap.set(eventId, {
            event: data.event,
            markets: data.markets
          });
        }
      } catch (error) {
        console.log(
          "Individual market request failed:",
          eventId,
          error.message
        );
      }
    }

    /*
    =========================================================
    6. NORMALIZE ACTIVE SPORTYBET OPTIONS
    =========================================================
    */

    function getOptions(eventData) {
      const options = [];

      if (!eventData) return options;

      for (const market of eventData.markets || []) {
        if (
          !market ||
          !Array.isArray(
            market.outcomes
          )
        ) {
          continue;
        }

        for (const outcome of market.outcomes) {
          if (!outcome) continue;

          if (
            outcome.isActive === false
          ) {
            continue;
          }

          const odds =
            Number(outcome.odds);

          if (
            !outcome.outcomeId ||
            !Number.isFinite(odds) ||
            odds <= 1
          ) {
            continue;
          }

          options.push({
            event:
              `${eventData.event.homeTeamName} vs ${eventData.event.awayTeamName}`,

            market:
              market.market || "",

            pick:
              outcome.pick || "",

            odds,

            eventId:
              clean(eventData.event.eventId),

            gameId:
              clean(eventData.event.gameId),

            marketId:
              clean(market.marketId),

            specifier:
              clean(market.specifier),

            outcomeId:
              clean(outcome.outcomeId),

            startTime:
              eventData.event.startTime
          });
        }
      }

      return options;
    }

    /*
    =========================================================
    7. VERIFY ORIGINAL PICKS
    =========================================================
    */

    function verifyOriginal(
      original,
      options
    ) {
      return (
        options.find(
          (option) =>
            clean(option.eventId) ===
              clean(original.eventId) &&
            clean(option.marketId) ===
              clean(original.marketId) &&
            clean(option.specifier) ===
              clean(original.specifier) &&
            clean(option.outcomeId) ===
              clean(original.outcomeId)
        ) || null
      );
    }

    /*
    =========================================================
    8. BUILD COMPLETE EVENT LIST
    =========================================================
    */

    const completeEvents = [];

    for (const original of uniqueSelections) {
      const eventId =
        clean(original.eventId);

      const eventData =
        eventMap.get(eventId);

      if (!eventData) {
        completeEvents.push({
          eventId,
          original,
          eventData: null,
          options: [],
          verifiedOriginal: null
        });

        continue;
      }

      const options =
        getOptions(eventData);

      const verifiedOriginal =
        verifyOriginal(
          original,
          options
        );

      completeEvents.push({
        eventId,
        original,
        eventData,
        options,
        verifiedOriginal
      });
    }

    /*
    =========================================================
    9. SAFE / BALANCED / RISKY
    =========================================================
    */

    const verifiedOriginals =
      completeEvents
        .map(
          (item) =>
            item.verifiedOriginal
        )
        .filter(Boolean);

    const sortedByOdds =
      [...verifiedOriginals].sort(
        (a, b) =>
          Number(a.odds) -
          Number(b.odds)
      );

    const safeCount = Math.max(
      1,
      Math.ceil(
        sortedByOdds.length * 0.5
      )
    );

    const balancedCount = Math.max(
      1,
      Math.ceil(
        sortedByOdds.length * 0.75
      )
    );

    const safeSelections =
      sortedByOdds.slice(
        0,
        safeCount
      );

    const balancedSelections =
      sortedByOdds.slice(
        0,
        balancedCount
      );

    const riskySelections =
      [...verifiedOriginals];

    /*
    =========================================================
    10. DETERMINISTIC AI FALLBACK
    =========================================================

    This is the important part.

    We don't depend on Gemini to return every event.

    For every game:

    1. Use a verified Gemini pick if available.
    2. Otherwise use a different real SportyBet option.
    3. Otherwise use the verified original.
    4. Otherwise use the first active SportyBet option.

    =========================================================
    */

    const preferredMarkets = [
      "Double Chance",
      "Over/Under",
      "GG/NG",
      "Draw No Bet",
      "1X2",
      "1X2 - 2UP",
      "Asian Handicap",
      "Handicap"
    ];

    function chooseFallback(item) {
      if (!item.options.length) {
        return null;
      }

      /*
      Prefer a different market from the original.
      */

      if (item.verifiedOriginal) {
        for (const marketName of preferredMarkets) {
          const alternative =
            item.options.find(
              (option) =>
                clean(option.market)
                  .toLowerCase() ===
                  marketName.toLowerCase() &&
                !(
                  clean(
                    option.marketId
                  ) ===
                    clean(
                      item.verifiedOriginal
                        .marketId
                    ) &&
                  clean(
                    option.specifier
                  ) ===
                    clean(
                      item.verifiedOriginal
                        .specifier
                    ) &&
                  clean(
                    option.outcomeId
                  ) ===
                    clean(
                      item.verifiedOriginal
                        .outcomeId
                    )
                )
            );

          if (alternative) {
            return alternative;
          }
        }

        /*
        Any different verified option.
        */

        const different =
          item.options.find(
            (option) =>
              !(
                clean(
                  option.marketId
                ) ===
                  clean(
                    item.verifiedOriginal
                      .marketId
                  ) &&
                clean(
                  option.specifier
                ) ===
                  clean(
                    item.verifiedOriginal
                      .specifier
                  ) &&
                clean(
                  option.outcomeId
                ) ===
                  clean(
                    item.verifiedOriginal
                      .outcomeId
                  )
              )
          );

        if (different) {
          return different;
        }

        /*
        No alternative exists.
        */

        return item.verifiedOriginal;
      }

      /*
      No verified original.
      Use a real active SportyBet option.
      */

      for (
        const marketName of preferredMarkets
      ) {
        const preferred =
          item.options.find(
            (option) =>
              clean(option.market)
                .toLowerCase() ===
              marketName.toLowerCase()
          );

        if (preferred) {
          return preferred;
        }
      }

      return item.options[0];
    }

    /*
    =========================================================
    11. ASK GEMINI — OPTIONAL
    =========================================================
    */

    const aiEvents =
      completeEvents
        .filter(
          (item) =>
            item.options.length > 0
        )
        .map((item) => ({
          eventId: item.eventId,

          event:
            `${item.eventData.event.homeTeamName} vs ${item.eventData.event.awayTeamName}`,

          original:
            item.verifiedOriginal,

          availableOptions:
            item.options.slice(0, 30)
        }));

    let aiReturned = [];

    if (
      GEMINI_KEY &&
      aiEvents.length
    ) {
      const prompt = `
You are analyzing SportyBet football selections.

Return ONE selection for EVERY event below.

Never skip an event.

Every recommendation MUST come directly from the availableOptions for that event.

Never invent any:
- eventId
- marketId
- specifier
- outcomeId
- odds
- market
- pick

Return JSON only:

{
  "selections": [
    {
      "eventId": "exact event ID",
      "marketId": "exact market ID",
      "specifier": "exact specifier",
      "outcomeId": "exact outcome ID",
      "reason": "one short natural sentence"
    }
  ]
}

Use natural football-fan language.

Do not promise results.

Do not invent statistics or team information.

EVENTS:

${JSON.stringify(aiEvents)}
`;

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
            GEMINI_KEY
          )}`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json"
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

        if (response.ok) {
          const data =
            await response.json();

          let text =
            data?.candidates?.[0]
              ?.content?.parts?.[0]
              ?.text || "";

          text = text
            .replace(
              /^```json\s*/i,
              ""
            )
            .replace(
              /^```\s*/i,
              ""
            )
            .replace(
              /\s*```$/i,
              ""
            )
            .trim();

          try {
            const parsed =
              JSON.parse(text);

            if (
              Array.isArray(
                parsed?.selections
              )
            ) {
              aiReturned =
                parsed.selections;
            }
          } catch (error) {
            console.log(
              "Gemini JSON parse error:",
              error.message
            );
          }
        } else {
          console.log(
            "Gemini returned status:",
            response.status
          );
        }
      } catch (error) {
        console.log(
          "Gemini request failed:",
          error.message
        );
      }
    }

    /*
    =========================================================
    12. VALIDATE GEMINI PICKS
    =========================================================
    */

    const validatedAI =
      new Map();

    for (const aiPick of aiReturned) {
      if (!aiPick?.eventId) {
        continue;
      }

      const item =
        completeEvents.find(
          (eventItem) =>
            clean(
              eventItem.eventId
            ) ===
            clean(
              aiPick.eventId
            )
        );

      if (!item) continue;

      const verified =
        item.options.find(
          (option) =>
            clean(
              option.eventId
            ) ===
              clean(
                aiPick.eventId
              ) &&
            clean(
              option.marketId
            ) ===
              clean(
                aiPick.marketId
              ) &&
            clean(
              option.specifier
            ) ===
              clean(
                aiPick.specifier
              ) &&
            clean(
              option.outcomeId
            ) ===
              clean(
                aiPick.outcomeId
              )
        );

      if (!verified) {
        continue;
      }

      if (
        validatedAI.has(
          item.eventId
        )
      ) {
        continue;
      }

      validatedAI.set(
        item.eventId,
        {
          ...verified,

          reason:
            clean(
              aiPick.reason
            ) ||
            "This is a verified SportyBet option available for this game."
        }
      );
    }

    /*
    =========================================================
    13. BUILD FINAL AI RECOMMENDED
    =========================================================
    */

    const finalAISelections = [];

    for (const item of completeEvents) {
      /*
      A. Valid Gemini selection
      */

      if (
        validatedAI.has(
          item.eventId
        )
      ) {
        finalAISelections.push(
          validatedAI.get(
            item.eventId
          )
        );

        continue;
      }

      /*
      B. Deterministic SportyBet fallback
      */

      const fallback =
        chooseFallback(item);

      if (fallback) {
        let reason =
          "This is a verified SportyBet option available for this game.";

        if (
          item.verifiedOriginal &&
          clean(
            fallback.marketId
          ) ===
            clean(
              item.verifiedOriginal
                .marketId
            ) &&
          clean(
            fallback.specifier
          ) ===
            clean(
              item.verifiedOriginal
                .specifier
            ) &&
          clean(
            fallback.outcomeId
          ) ===
            clean(
              item.verifiedOriginal
                .outcomeId
            )
        ) {
          reason =
            "The original SportyBet pick was kept because no different verified option was available.";
        } else if (
          item.verifiedOriginal
        ) {
          reason =
            "This is a different verified SportyBet option available for this game.";
        }

        finalAISelections.push({
          ...fallback,
          reason
        });
      }
    }

    /*
    =========================================================
    14. DIAGNOSTICS
    =========================================================
    */

    const missingMarketEventIds =
      completeEvents
        .filter(
          (item) =>
            item.options.length ===
            0
        )
        .map(
          (item) =>
            item.eventId
        );

    /*
    =========================================================
    15. FINAL RESPONSE
    =========================================================
    */

    return res.status(200).json({
      success: true,

      profiles: {
        SAFE: {
          summary:
            "I’ve trimmed this down to the less aggressive picks.",

          selections:
            safeSelections
        },

        BALANCED: {
          summary:
            "A middle-ground mix — not too cautious, not too aggressive.",

          selections:
            balancedSelections
        },

        RISKY: {
          summary:
            "This keeps more of the action, but there’s less room for mistakes.",

          selections:
            riskySelections
        },

        "AI RECOMMENDED": {
          summary:
            "I checked the available SportyBet markets and picked one option for each game.",

          selections:
            finalAISelections
        }
      },

      diagnostics: {
        receivedSelections:
          selections.length,

        requestedEvents:
          uniqueSelections.length,

        batchEventsReturned:
          batchData.results.length,

        individualMarketRequests:
          missingMarketEvents.length,

        usableEvents:
          completeEvents.filter(
            (item) =>
              item.options.length > 0
          ).length,

        verifiedOriginals:
          verifiedOriginals.length,

        aiReturned:
          aiReturned.length,

        aiValidated:
          validatedAI.size,

        aiFinalSelections:
          finalAISelections.length,

        missingMarketEventIds,

        finalAIEventIds:
          finalAISelections.map(
            (item) =>
              item.eventId
          )
      }
    });
  } catch (error) {
    console.error(
      "OPTIMIZER ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Optimizer server error",
      details:
        error.message
    });
  }
    }
