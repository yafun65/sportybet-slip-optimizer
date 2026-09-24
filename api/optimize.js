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
      process.env.RENDER_API_URL || "https://sportybet-api.onrender.com";

    const GEMINI_KEY = process.env.GEMINI_API_KEY;

    /*
      ---------------------------------------------------------
      HELPERS
      ---------------------------------------------------------
    */

    const clean = (value) => String(value ?? "").trim();

    const same = (a, b) => clean(a) === clean(b);

    const sameSelection = (a, b) => {
      return (
        same(a.eventId, b.eventId) &&
        same(a.marketId, b.marketId) &&
        same(a.specifier, b.specifier) &&
        same(a.outcomeId, b.outcomeId)
      );
    };

    const normalizeOutcome = (event, market, outcome) => ({
      event: `${event.homeTeamName} vs ${event.awayTeamName}`,
      market: market.market,
      pick: outcome.pick,
      odds: Number(outcome.odds),
      eventId: clean(event.eventId),
      gameId: clean(event.gameId),
      marketId: clean(market.marketId),
      specifier: clean(market.specifier),
      outcomeId: clean(outcome.outcomeId),
      startTime: event.startTime
    });

    /*
      Only use active, valid SportyBet outcomes.
    */
    const getActiveOutcomes = (eventData) => {
      if (!eventData || !Array.isArray(eventData.markets)) {
        return [];
      }

      const output = [];

      for (const market of eventData.markets) {
        if (!market || !Array.isArray(market.outcomes)) continue;

        for (const outcome of market.outcomes) {
          if (!outcome) continue;

          if (outcome.isActive === false) continue;

          if (!outcome.outcomeId) continue;

          const odds = Number(outcome.odds);

          if (!Number.isFinite(odds) || odds <= 1) continue;

          output.push(
            normalizeOutcome(eventData.event, market, outcome)
          );
        }
      }

      return output;
    };

    /*
      Find an exact original selection inside SportyBet's
      currently available markets.
    */
    const findVerifiedOriginal = (selection, eventData) => {
      const available = getActiveOutcomes(eventData);

      return (
        available.find((item) =>
          sameSelection(item, selection)
        ) || null
      );
    };

    /*
      Prefer common/simple markets when we need a deterministic
      fallback for an event that Gemini did not return.
    */
    const MARKET_PRIORITY = [
      "Double Chance",
      "Over/Under",
      "GG/NG",
      "Draw No Bet",
      "1X2",
      "1X2 - 2UP",
      "Asian Handicap",
      "Handicap",
      "Odd/Even"
    ];

    const chooseFallback = (eventData, original) => {
      const available = getActiveOutcomes(eventData);

      if (!available.length) return null;

      /*
        First try to find a different market/outcome from the
        original selection.
      */
      const different = available.find((item) => {
        if (!original) return true;

        return !sameSelection(item, original);
      });

      /*
        Prefer familiar/simple markets.
      */
      for (const preferredMarket of MARKET_PRIORITY) {
        const preferred = available.find(
          (item) =>
            clean(item.market).toLowerCase() ===
            clean(preferredMarket).toLowerCase() &&
            (!original || !sameSelection(item, original))
        );

        if (preferred) return preferred;
      }

      /*
        If no different market can be found, keep the verified
        original selection.
      */
      if (original) return original;

      /*
        Last possible fallback: first verified active outcome.
      */
      return available[0];
    };

    /*
      ---------------------------------------------------------
      1. REMOVE DUPLICATE EVENTS
      ---------------------------------------------------------
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

    if (!uniqueSelections.length) {
      return res.status(400).json({
        success: false,
        error: "No valid event IDs were found in the selections"
      });
    }

    /*
      ---------------------------------------------------------
      2. LOAD SPORTYBET MARKETS
      ---------------------------------------------------------
    */

    const eventIds = uniqueSelections.map((s) => clean(s.eventId));

    let marketData = {
      success: true,
      results: []
    };

    /*
      Try the batch endpoint first.
    */
    try {
      const batchResponse = await fetch(
        `${RENDER_API}/event-markets?eventIds=${encodeURIComponent(
          eventIds.join(",")
        )}`
      );

      if (batchResponse.ok) {
        const data = await batchResponse.json();

        if (data && Array.isArray(data.results)) {
          marketData = data;
        }
      }
    } catch (error) {
      console.log("Batch market request failed:", error.message);
    }

    /*
      Build lookup from batch response.
    */
    const eventMap = new Map();

    if (Array.isArray(marketData.results)) {
      for (const result of marketData.results) {
        if (!result || !result.eventId) continue;

        eventMap.set(clean(result.eventId), result);
      }
    }

    /*
      ---------------------------------------------------------
      IMPORTANT:
      If batch endpoint did not return every event, request
      the missing events individually.
      ---------------------------------------------------------
    */

    const missingEventIds = eventIds.filter(
      (eventId) => !eventMap.has(eventId)
    );

    if (missingEventIds.length) {
      const individualResults = await Promise.all(
        missingEventIds.map(async (eventId) => {
          try {
            const response = await fetch(
              `${RENDER_API}/event-markets/${encodeURIComponent(eventId)}`
            );

            if (!response.ok) {
              return {
                eventId,
                success: false
              };
            }

            const data = await response.json();

            return {
              eventId,
              success: true,
              data
            };
          } catch (error) {
            return {
              eventId,
              success: false,
              error: error.message
            };
          }
        })
      );

      for (const item of individualResults) {
        if (!item.success || !item.data) continue;

        /*
          Individual endpoint structure:
          {
            event: {...},
            markets: [...]
          }
        */

        if (item.data.event && Array.isArray(item.data.markets)) {
          eventMap.set(item.eventId, item.data);
        }
      }
    }

    /*
      ---------------------------------------------------------
      3. NORMALIZE EVENT DATA
      ---------------------------------------------------------
    */

    const normalizedEvents = [];

    for (const selection of uniqueSelections) {
      const eventId = clean(selection.eventId);
      const raw = eventMap.get(eventId);

      if (!raw) {
        continue;
      }

      /*
        Handle either:
        A. { event, markets }
        B. { eventId, event, markets }
      */

      const event =
        raw.event ||
        {
          eventId: raw.eventId,
          gameId: raw.gameId,
          homeTeamName: raw.homeTeamName,
          awayTeamName: raw.awayTeamName,
          startTime: raw.startTime
        };

      if (!event || !event.eventId) continue;

      normalizedEvents.push({
        event,
        markets: Array.isArray(raw.markets) ? raw.markets : [],
        original: selection
      });
    }

    /*
      ---------------------------------------------------------
      4. VERIFY ORIGINAL SELECTIONS
      ---------------------------------------------------------
    */

    const verifiedOriginals = [];

    for (const item of normalizedEvents) {
      const verified = findVerifiedOriginal(
        item.original,
        item
      );

      if (verified) {
        verifiedOriginals.push(verified);
      }
    }

    /*
      ---------------------------------------------------------
      5. SAFE / BALANCED / RISKY
      ---------------------------------------------------------
    */

    const sortByOdds = (items) =>
      [...items].sort(
        (a, b) => Number(a.odds) - Number(b.odds)
      );

    const safeCount = Math.max(
      1,
      Math.ceil(verifiedOriginals.length * 0.5)
    );

    const balancedCount = Math.max(
      1,
      Math.ceil(verifiedOriginals.length * 0.75)
    );

    const safeSelections = sortByOdds(
      verifiedOriginals
    ).slice(0, safeCount);

    const balancedSelections = sortByOdds(
      verifiedOriginals
    ).slice(0, balancedCount);

    const riskySelections = [...verifiedOriginals];

    /*
      ---------------------------------------------------------
      6. PREPARE SPORTYBET MARKET DATA FOR GEMINI
      ---------------------------------------------------------
    */

    const aiEvents = normalizedEvents.map((item) => {
      const available = getActiveOutcomes(item);

      /*
        Keep prompt reasonably sized.
      */
      const limited = available.slice(0, 80);

      return {
        eventId: clean(item.event.eventId),
        gameId: clean(item.event.gameId),
        event: `${item.event.homeTeamName} vs ${item.event.awayTeamName}`,
        original: findVerifiedOriginal(
          item.original,
          item
        ),
        availableMarkets: limited
      };
    });

    /*
      ---------------------------------------------------------
      7. ASK GEMINI FOR ONE SELECTION PER EVENT
      ---------------------------------------------------------
    */

    let aiRawSelections = [];

    if (GEMINI_KEY && aiEvents.length) {
      const prompt = `
You are helping analyze a SportyBet football selection list.

IMPORTANT:
Return EXACTLY ONE selection for EVERY event listed below.

There are ${aiEvents.length} events.

You MUST NOT skip an event.

You may choose:
1. The original verified selection, OR
2. A different market/outcome from the available SportyBet markets.

Every recommended selection MUST come directly from the provided availableMarkets list.

Do not invent:
- market IDs
- outcome IDs
- specifiers
- odds
- events
- markets
- picks

The eventId must match exactly.

Return ONLY valid JSON.

Required format:

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

Make the reasons sound natural and human, like a knowledgeable football fan explaining the ticket to another fan.

Avoid robotic or corporate wording.

Keep each reason to one short sentence.

Do not make unsupported claims about form, injuries, probability or match outcomes.

Here are the events and their REAL SportyBet markets:

${JSON.stringify(aiEvents)}
`;

      try {
        const response = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
            encodeURIComponent(GEMINI_KEY),
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

          const text =
            data?.candidates?.[0]?.content?.parts?.[0]?.text ||
            "";

          if (text) {
            let cleaned = text.trim();

            /*
              Remove accidental markdown fences.
            */
            cleaned = cleaned
              .replace(/^```json\s*/i, "")
              .replace(/^```\s*/i, "")
              .replace(/\s*```$/i, "")
              .trim();

            try {
              const parsed = JSON.parse(cleaned);

              if (Array.isArray(parsed?.selections)) {
                aiRawSelections = parsed.selections;
              }
            } catch (parseError) {
              console.log(
                "Gemini JSON parse failed:",
                parseError.message
              );
            }
          }
        } else {
          console.log(
            "Gemini request failed:",
            response.status
          );
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
      8. VALIDATE GEMINI SELECTIONS
      ---------------------------------------------------------
    */

    const validatedAI = [];

    for (const aiPick of aiRawSelections) {
      if (!aiPick || !aiPick.eventId) continue;

      const eventData = normalizedEvents.find(
        (item) =>
          clean(item.event.eventId) ===
          clean(aiPick.eventId)
      );

      if (!eventData) continue;

      const available = getActiveOutcomes(eventData);

      const exact = available.find(
        (item) =>
          same(item.eventId, aiPick.eventId) &&
          same(item.marketId, aiPick.marketId) &&
          same(item.specifier, aiPick.specifier) &&
          same(item.outcomeId, aiPick.outcomeId)
      );

      if (!exact) continue;

      validatedAI.push({
        ...exact,
        reason:
          clean(aiPick.reason) ||
          "This is one of the verified SportyBet options available for this game."
      });
    }

    /*
      Remove duplicate AI events.
    */
    const validatedMap = new Map();

    for (const selection of validatedAI) {
      const eventId = clean(selection.eventId);

      if (!validatedMap.has(eventId)) {
        validatedMap.set(eventId, selection);
      }
    }

    /*
      ---------------------------------------------------------
      9. GUARANTEE ONE AI SELECTION PER EVENT
      ---------------------------------------------------------
      
      This is the critical fix.

      For EVERY event:
      - use a validated Gemini selection if available
      - otherwise choose a real SportyBet alternative
      - otherwise use the verified original

      Gemini can return 2, 5 or 8.
      The server will still build the final list
      event-by-event.
    */

    const finalAISelections = [];

    for (const item of normalizedEvents) {
      const eventId = clean(item.event.eventId);

      /*
        Gemini's verified choice.
      */
      const aiChoice = validatedMap.get(eventId);

      if (aiChoice) {
        finalAISelections.push(aiChoice);
        continue;
      }

      /*
        Verified original.
      */
      const verifiedOriginal = findVerifiedOriginal(
        item.original,
        item
      );

      /*
        Try a genuine alternative first.
      */
      const fallback = chooseFallback(
        item,
        verifiedOriginal
      );

      if (fallback) {
        finalAISelections.push({
          ...fallback,
          reason:
            fallback &&
            verifiedOriginal &&
            sameSelection(fallback, verifiedOriginal)
              ? "The original SportyBet pick was kept because it could be verified for this game."
              : "This is a verified SportyBet market available for this game."
        });
      }
    }

    /*
      ---------------------------------------------------------
      10. HUMAN-FRIENDLY SUMMARIES
      ---------------------------------------------------------
    */

    const summaries = {
      safe:
        "I’ve trimmed this down to the less aggressive picks.",

      balanced:
        "A middle-ground mix — not too cautious, not too aggressive.",

      risky:
        "This keeps more of the action, but there’s less room for mistakes.",

      ai:
        "I checked the available SportyBet markets and picked one option for each game."
    };

    /*
      ---------------------------------------------------------
      11. RESPONSE
      ---------------------------------------------------------
    */

    return res.status(200).json({
      success: true,

      profiles: {
        SAFE: {
          summary: summaries.safe,
          selections: safeSelections
        },

        BALANCED: {
          summary: summaries.balanced,
          selections: balancedSelections
        },

        RISKY: {
          summary: summaries.risky,
          selections: riskySelections
        },

        "AI RECOMMENDED": {
          summary: summaries.ai,
          selections: finalAISelections
        }
      },

      diagnostics: {
        receivedSelections: selections.length,
        uniqueEvents: uniqueSelections.length,
        marketEventsFound: normalizedEvents.length,
        verifiedOriginals: verifiedOriginals.length,
        aiReturned: aiRawSelections.length,
        aiValidated: validatedAI.length,
        aiFinalSelections: finalAISelections.length,
        missingEvents: uniqueSelections
          .filter(
            (selection) =>
              !normalizedEvents.some(
                (item) =>
                  clean(item.event.eventId) ===
                  clean(selection.eventId)
              )
          )
          .map((selection) => ({
            eventId: selection.eventId,
            event: selection.event
          }))
      }
    });
  } catch (error) {
    console.error("Optimizer error:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Optimizer failed"
    });
  }
}

Now deploy this file to Vercel and test the same 8-selection booking again.

The important result we want is:

AI RECOMMENDED → 8 selections, not 2.

The response should also show something like:

- "uniqueEvents: 8"
- "marketEventsFound: 8"
- "aiFinalSelections: 8"

If "marketEventsFound" is less than 8, that will tell us the remaining issue is with the SportyBet market data rather than the AI.
