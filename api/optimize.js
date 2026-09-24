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

    const clean = (v) => String(v ?? "").trim();

    /*
    ---------------------------------------------------------
    1. UNIQUE EVENTS
    ---------------------------------------------------------
    */

    const uniqueSelections = [];
    const seen = new Set();

    for (const selection of selections) {
      const eventId = clean(selection.eventId);

      if (!eventId || seen.has(eventId)) continue;

      seen.add(eventId);
      uniqueSelections.push(selection);
    }

    if (!uniqueSelections.length) {
      return res.status(400).json({
        success: false,
        error: "No valid event IDs found"
      });
    }

    const eventIds = uniqueSelections.map(
      (s) => clean(s.eventId)
    );

    /*
    ---------------------------------------------------------
    2. GET SPORTYBET MARKETS
    ---------------------------------------------------------
    */

    let marketResponse;

    try {
      const response = await fetch(
        `${RENDER_API}/event-markets?eventIds=${encodeURIComponent(
          eventIds.join(",")
        )}`
      );

      if (!response.ok) {
        return res.status(502).json({
          success: false,
          error: `SportyBet market service returned ${response.status}`
        });
      }

      marketResponse = await response.json();
    } catch (error) {
      return res.status(502).json({
        success: false,
        error: "Could not load SportyBet markets",
        details: error.message
      });
    }

    if (
      !marketResponse ||
      !Array.isArray(marketResponse.results)
    ) {
      return res.status(502).json({
        success: false,
        error: "SportyBet market response was invalid"
      });
    }

    /*
    ---------------------------------------------------------
    3. CREATE EVENT LOOKUP
    ---------------------------------------------------------
    */

    const eventMap = new Map();

    for (const result of marketResponse.results) {
      if (!result) continue;

      const eventId = clean(
        result.eventId ||
        result.event?.eventId
      );

      if (!eventId) continue;

      const event = result.event || {
        eventId,
        gameId: result.gameId,
        homeTeamName: result.homeTeamName,
        awayTeamName: result.awayTeamName,
        startTime: result.startTime
      };

      eventMap.set(eventId, {
        event,
        markets: Array.isArray(result.markets)
          ? result.markets
          : []
      });
    }

    /*
    ---------------------------------------------------------
    4. NORMALIZE AVAILABLE SPORTYBET OPTIONS
    ---------------------------------------------------------
    */

    function getAvailableOptions(eventData) {
      const output = [];

      if (!eventData) return output;

      for (const market of eventData.markets || []) {
        if (!market || !Array.isArray(market.outcomes)) {
          continue;
        }

        for (const outcome of market.outcomes) {
          if (!outcome) continue;

          if (outcome.isActive === false) continue;

          const odds = Number(outcome.odds);

          if (
            !outcome.outcomeId ||
            !Number.isFinite(odds) ||
            odds <= 1
          ) {
            continue;
          }

          output.push({
            event:
              `${eventData.event.homeTeamName} vs ${eventData.event.awayTeamName}`,

            market: market.market,

            pick: outcome.pick,

            odds,

            eventId: clean(eventData.event.eventId),

            gameId: clean(eventData.event.gameId),

            marketId: clean(market.marketId),

            specifier: clean(market.specifier),

            outcomeId: clean(outcome.outcomeId),

            startTime: eventData.event.startTime
          });
        }
      }

      return output;
    }

    /*
    ---------------------------------------------------------
    5. VERIFY ORIGINAL SELECTION
    ---------------------------------------------------------
    */

    function findOriginal(selection, options) {
      return (
        options.find(
          (option) =>
            clean(option.eventId) ===
              clean(selection.eventId) &&
            clean(option.marketId) ===
              clean(selection.marketId) &&
            clean(option.specifier) ===
              clean(selection.specifier) &&
            clean(option.outcomeId) ===
              clean(selection.outcomeId)
        ) || null
      );
    }

    /*
    ---------------------------------------------------------
    6. BUILD DATA FOR EVERY EVENT
    ---------------------------------------------------------
    */

    const eventDataList = [];

    for (const selection of uniqueSelections) {
      const eventId = clean(selection.eventId);

      const eventData = eventMap.get(eventId);

      if (!eventData) continue;

      const options = getAvailableOptions(eventData);

      const original = findOriginal(
        selection,
        options
      );

      eventDataList.push({
        eventId,
        eventData,
        options,
        original
      });
    }

    /*
    ---------------------------------------------------------
    7. ORIGINAL VERIFIED SELECTIONS
    ---------------------------------------------------------
    */

    const verifiedOriginals = eventDataList
      .map((item) => item.original)
      .filter(Boolean);

    /*
    ---------------------------------------------------------
    8. SAFE / BALANCED / RISKY
    ---------------------------------------------------------
    */

    const sorted = [...verifiedOriginals].sort(
      (a, b) => a.odds - b.odds
    );

    const safeCount = Math.max(
      1,
      Math.ceil(sorted.length * 0.5)
    );

    const balancedCount = Math.max(
      1,
      Math.ceil(sorted.length * 0.75)
    );

    const safeSelections = sorted.slice(
      0,
      safeCount
    );

    const balancedSelections = sorted.slice(
      0,
      balancedCount
    );

    const riskySelections = [...verifiedOriginals];

    /*
    ---------------------------------------------------------
    9. PREPARE COMPACT AI DATA
    ---------------------------------------------------------
    */

    const aiEvents = eventDataList.map((item) => {
      /*
      We don't need to send every single market to Gemini.
      Send the first 40 verified active options.
      */

      const options = item.options.slice(0, 40);

      return {
        eventId: item.eventId,

        event:
          `${item.eventData.event.homeTeamName} vs ${item.eventData.event.awayTeamName}`,

        original: item.original,

        availableOptions: options
      };
    });

    /*
    ---------------------------------------------------------
    10. ASK GEMINI
    ---------------------------------------------------------
    */

    let aiReturned = [];

    if (GEMINI_KEY && aiEvents.length) {
      const prompt = `
You are analyzing a SportyBet football selection list.

IMPORTANT RULE:
You MUST return EXACTLY ONE selection for EVERY event listed below.

There are ${aiEvents.length} events.

Never skip an event.

Every selection must come directly from that event's availableOptions.

Never invent:
- event IDs
- market IDs
- outcome IDs
- specifiers
- odds
- markets
- picks

Return ONLY JSON in this format:

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

STYLE:
Sound like a knowledgeable football fan explaining the ticket.

Keep reasons short and natural.

Do not claim that a selection is guaranteed.

Do not invent team form, injuries or statistics.

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
                responseMimeType: "application/json"
              }
            })
          }
        );

        if (response.ok) {
          const data = await response.json();

          let text =
            data?.candidates?.[0]?.content?.parts?.[0]
              ?.text || "";

          text = text
            .replace(/^```json/i, "")
            .replace(/^```/, "")
            .replace(/```$/, "")
            .trim();

          try {
            const parsed = JSON.parse(text);

            if (Array.isArray(parsed?.selections)) {
              aiReturned = parsed.selections;
            }
          } catch (error) {
            console.log(
              "Gemini JSON error:",
              error.message
            );
          }
        }
      } catch (error) {
        console.log(
          "Gemini request error:",
          error.message
        );
      }
    }

    /*
    ---------------------------------------------------------
    11. VALIDATE AI PICKS
    ---------------------------------------------------------
    */

    const validatedMap = new Map();

    for (const aiPick of aiReturned) {
      if (!aiPick?.eventId) continue;

      const item = eventDataList.find(
        (eventItem) =>
          clean(eventItem.eventId) ===
          clean(aiPick.eventId)
      );

      if (!item) continue;

      const verified = item.options.find(
        (option) =>
          clean(option.eventId) ===
            clean(aiPick.eventId) &&
          clean(option.marketId) ===
            clean(aiPick.marketId) &&
          clean(option.specifier) ===
            clean(aiPick.specifier) &&
          clean(option.outcomeId) ===
            clean(aiPick.outcomeId)
      );

      if (!verified) continue;

      if (validatedMap.has(item.eventId)) {
        continue;
      }

      validatedMap.set(item.eventId, {
        ...verified,

        reason:
          clean(aiPick.reason) ||
          "This is a verified SportyBet option available for this game."
      });
    }

    /*
    ---------------------------------------------------------
    12. GUARANTEE ONE SELECTION PER EVENT
    ---------------------------------------------------------
    */

    const finalAISelections = [];

    for (const item of eventDataList) {
      /*
      First choice:
      Validated Gemini recommendation.
      */

      if (validatedMap.has(item.eventId)) {
        finalAISelections.push(
          validatedMap.get(item.eventId)
        );

        continue;
      }

      /*
      Second choice:
      Find a genuine alternative market.
      */

      let alternative = null;

      if (item.original) {
        alternative = item.options.find(
          (option) =>
            !(
              clean(option.marketId) ===
                clean(item.original.marketId) &&
              clean(option.specifier) ===
                clean(item.original.specifier) &&
              clean(option.outcomeId) ===
                clean(item.original.outcomeId)
            )
        );
      }

      /*
      If a different verified market exists,
      use it.
      */

      if (alternative) {
        finalAISelections.push({
          ...alternative,

          reason:
            "This is a different verified SportyBet option available for this game."
        });

        continue;
      }

      /*
      Final fallback:
      verified original selection.
      */

      if (item.original) {
        finalAISelections.push({
          ...item.original,

          reason:
            "The original SportyBet pick was kept because it could be verified for this game."
        });

        continue;
      }

      /*
      If there was no original but SportyBet supplied
      an active market, use the first verified option.
      */

      if (item.options.length) {
        finalAISelections.push({
          ...item.options[0],

          reason:
            "This is a verified SportyBet option available for this game."
        });
      }
    }

    /*
    ---------------------------------------------------------
    13. RESPONSE
    ---------------------------------------------------------
    */

    return res.status(200).json({
      success: true,

      profiles: {
        SAFE: {
          summary:
            "I’ve trimmed this down to the less aggressive picks.",

          selections: safeSelections
        },

        BALANCED: {
          summary:
            "A middle-ground mix — not too cautious, not too aggressive.",

          selections: balancedSelections
        },

        RISKY: {
          summary:
            "This keeps more of the action, but there’s less room for mistakes.",

          selections: riskySelections
        },

        "AI RECOMMENDED": {
          summary:
            "I checked the available SportyBet markets and picked one option for each game.",

          selections: finalAISelections
        }
      },

      diagnostics: {
        receivedSelections: selections.length,

        requestedEvents: uniqueSelections.length,

        sportBetEventsReturned:
          marketResponse.results.length,

        usableEvents:
          eventDataList.length,

        verifiedOriginals:
          verifiedOriginals.length,

        aiReturned:
          aiReturned.length,

        aiValidated:
          validatedMap.size,

        aiFinalSelections:
          finalAISelections.length,

        requestedEventIds:
          eventIds,

        finalAIEventIds:
          finalAISelections.map(
            (item) => item.eventId
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
      error: "Optimizer server error",
      details: error.message
    });
  }
}
