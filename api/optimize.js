// api/optimize.js

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
        error: "No selections supplied"
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: "GEMINI_API_KEY is not configured"
      });
    }

    // ---------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------

    const uniqueEvents = [];

    for (const selection of selections) {
      const eventId = String(selection.eventId || "").trim();

      if (!eventId) continue;

      if (!uniqueEvents.some(x => x.eventId === eventId)) {
        uniqueEvents.push({
          eventId,
          event: selection.event || "Unknown match"
        });
      }
    }

    if (uniqueEvents.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No valid event IDs found"
      });
    }

    // ---------------------------------------------------------
    // Fetch the actual SportyBet markets
    // ---------------------------------------------------------

    async function getMarkets(eventId) {
      const url =
        `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(eventId)}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(
          `SportyBet markets request failed for ${eventId}: HTTP ${response.status}`
        );
      }

      const data = await response.json();

      if (!data || !Array.isArray(data.markets)) {
        throw new Error(
          `Unexpected market response for ${eventId}`
        );
      }

      const available = [];

      for (const market of data.markets) {
        if (!market || !Array.isArray(market.outcomes)) continue;

        for (const outcome of market.outcomes) {
          if (!outcome) continue;

          if (outcome.isActive === false) continue;

          const marketId = String(market.marketId ?? "").trim();
          const outcomeId = String(outcome.outcomeId ?? "").trim();

          if (!marketId || !outcomeId) continue;

          const odds = Number(outcome.odds);

          if (!Number.isFinite(odds) || odds <= 0) continue;

          available.push({
            eventId,
            marketId,
            market: String(market.market || ""),
            specifier:
              market.specifier === null ||
              market.specifier === undefined
                ? null
                : String(market.specifier),
            outcomeId,
            pick: String(outcome.pick || ""),
            odds
          });
        }
      }

      return available;
    }

    const marketResults = await Promise.all(
      uniqueEvents.map(async event => {
        try {
          const markets = await getMarkets(event.eventId);

          return {
            ...event,
            markets,
            error: null
          };
        } catch (error) {
          return {
            ...event,
            markets: [],
            error: error.message
          };
        }
      })
    );

    // ---------------------------------------------------------
    // Original selections lookup
    // ---------------------------------------------------------

    const originalByEvent = new Map();

    for (const selection of selections) {
      const eventId = String(selection.eventId || "").trim();

      if (!eventId) continue;

      if (!originalByEvent.has(eventId)) {
        originalByEvent.set(eventId, []);
      }

      originalByEvent.get(eventId).push(selection);
    }

    // ---------------------------------------------------------
    // SAFE / BALANCED / RISKY
    //
    // These only use original selections.
    // ---------------------------------------------------------

    const sortedOriginal = [...selections].sort((a, b) => {
      const oddsA = Number(a.odds);
      const oddsB = Number(b.odds);

      return (
        (Number.isFinite(oddsA) ? oddsA : 999) -
        (Number.isFinite(oddsB) ? oddsB : 999)
      );
    });

    const total = selections.length;

    const safeCount = Math.max(1, Math.ceil(total * 0.5));
    const balancedCount = Math.max(1, Math.ceil(total * 0.75));
    const riskyCount = total;

    function makeOriginalProfile(list, summary) {
      return {
        selections: list.map(item => ({
          event: item.event,
          market: item.market,
          pick: item.pick,
          odds: Number(item.odds),
          eventId: item.eventId,
          gameId: item.gameId,
          marketId: item.marketId,
          specifier:
            item.specifier === undefined ? null : item.specifier,
          outcomeId: item.outcomeId,
          startTime: item.startTime,
          reason:
            Number(item.odds) >= 2
              ? "The odds are higher here, so this adds more risk to the ticket."
              : "This keeps a relatively modest-odds pick from the original selections."
        })),
        summary,
        selectionCount: list.length
      };
    }

    const safeSelections = sortedOriginal.slice(0, safeCount);

    const balancedSelections = sortedOriginal.slice(
      0,
      Math.min(balancedCount, total)
    );

    const riskySelections = [...selections];

    // ---------------------------------------------------------
    // Gemini
    // ---------------------------------------------------------

    async function askGemini(eventData) {
      if (!eventData.markets.length) {
        return null;
      }

      // Keep the prompt reasonably sized.
      // The model sees the actual SportyBet IDs and outcomes.
      const marketList = eventData.markets.map(m => ({
        marketId: m.marketId,
        market: m.market,
        specifier: m.specifier,
        outcomeId: m.outcomeId,
        pick: m.pick,
        odds: m.odds
      }));

      const original =
        originalByEvent.get(eventData.eventId)?.[0] || null;

      const prompt = `
You are helping analyze a football betting selection.

Your task is to choose EXACTLY ONE available SportyBet selection for this match.

IMPORTANT:
- You may ONLY choose an option that appears in AVAILABLE SPORTYBET MARKETS.
- Never invent a market.
- Never invent a marketId.
- Never invent an outcomeId.
- Never invent a specifier.
- The returned marketId, outcomeId and specifier must exactly match one available row.
- Choose ONE selection only.
- Do not return multiple selections.
- Do not return a recommendation for another match.

Match:
${eventData.event}

Original user selection:
${JSON.stringify(original)}

AVAILABLE SPORTYBET MARKETS:
${JSON.stringify(marketList)}

Choose one reasonable alternative or keep the original if appropriate.

Return ONLY valid JSON in this exact format:

{
  "marketId": "string",
  "specifier": null,
  "outcomeId": "string",
  "reason": "short natural explanation"
}

STYLE:
Sound like a knowledgeable football fan explaining the pick to another fan.

Keep the reason to ONE short sentence.

Do not use certainty language.
Do not claim that a selection is guaranteed.
Do not invent team form, injuries, statistics or other information that was not provided.
`;

      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
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

      if (!response.ok) {
        const errorText = await response.text();

        throw new Error(
          `Gemini request failed: HTTP ${response.status} ${errorText}`
        );
      }

      const data = await response.json();

      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map(part => part.text || "")
          .join("")
          .trim();

      if (!text) {
        throw new Error("Gemini returned an empty response");
      }

      let parsed;

      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("Gemini returned invalid JSON");
      }

      return parsed;
    }

    // ---------------------------------------------------------
    // Strict validation
    // ---------------------------------------------------------

    function validateRecommendation(eventData, recommendation) {
      if (!recommendation) return null;

      const marketId = String(
        recommendation.marketId ?? ""
      ).trim();

      const outcomeId = String(
        recommendation.outcomeId ?? ""
      ).trim();

      const specifier =
        recommendation.specifier === null ||
        recommendation.specifier === undefined ||
        recommendation.specifier === ""
          ? null
          : String(recommendation.specifier);

      if (!marketId || !outcomeId) {
        return null;
      }

      const match = eventData.markets.find(item => {
        const sameMarket =
          String(item.marketId) === marketId;

        const sameOutcome =
          String(item.outcomeId) === outcomeId;

        const itemSpecifier =
          item.specifier === null ||
          item.specifier === undefined ||
          item.specifier === ""
            ? null
            : String(item.specifier);

        const sameSpecifier =
          itemSpecifier === specifier;

        return (
          sameMarket &&
          sameOutcome &&
          sameSpecifier
        );
      });

      if (!match) {
        return null;
      }

      return {
        event: eventData.event,
        market: match.market,
        pick: match.pick,
        odds: match.odds,
        eventId: match.eventId,
        marketId: match.marketId,
        specifier: match.specifier,
        outcomeId: match.outcomeId,
        reason:
          typeof recommendation.reason === "string" &&
          recommendation.reason.trim()
            ? recommendation.reason.trim()
            : "This option is available on SportyBet and gives a different way to approach the game."
      };
    }

    // ---------------------------------------------------------
    // AI RECOMMENDED
    //
    // ONE selection for EVERY unique event.
    // ---------------------------------------------------------

    const aiRecommendedSelections = [];
    const aiErrors = [];

    for (const eventData of marketResults) {
      try {
        const recommendation = await askGemini(eventData);

        const validated = validateRecommendation(
          eventData,
          recommendation
        );

        if (validated) {
          aiRecommendedSelections.push(validated);
        } else {
          aiErrors.push({
            eventId: eventData.eventId,
            event: eventData.event,
            error: "Gemini recommendation did not match an available SportyBet selection"
          });
        }
      } catch (error) {
        aiErrors.push({
          eventId: eventData.eventId,
          event: eventData.event,
          error: error.message
        });
      }
    }

    // ---------------------------------------------------------
    // Odds
    // ---------------------------------------------------------

    function combinedOdds(list) {
      if (!Array.isArray(list) || list.length === 0) {
        return null;
      }

      let result = 1;

      for (const item of list) {
        const odds = Number(item.odds);

        if (!Number.isFinite(odds) || odds <= 0) {
          return null;
        }

        result *= odds;
      }

      return Number(result.toFixed(2));
    }

    function profile(list, summary) {
      return {
        selections: list,
        selectionCount: list.length,
        combinedOdds: combinedOdds(list),
        summary
      };
    }

    const profiles = {
      SAFE: profile(
        safeSelections.map(item => ({
          event: item.event,
          market: item.market,
          pick: item.pick,
          odds: Number(item.odds),
          eventId: item.eventId,
          gameId: item.gameId,
          marketId: item.marketId,
          specifier:
            item.specifier === undefined
              ? null
              : item.specifier,
          outcomeId: item.outcomeId,
          startTime: item.startTime,
          reason:
            Number(item.odds) >= 2
              ? "The odds are higher here, so this is one of the more aggressive original picks."
              : "This keeps one of the less aggressive picks from your original selections."
        })),
        "I’ve trimmed this down to the less aggressive picks."
      ),

      BALANCED: profile(
        balancedSelections.map(item => ({
          event: item.event,
          market: item.market,
          pick: item.pick,
          odds: Number(item.odds),
          eventId: item.eventId,
          gameId: item.gameId,
          marketId: item.marketId,
          specifier:
            item.specifier === undefined
              ? null
              : item.specifier,
          outcomeId: item.outcomeId,
          startTime: item.startTime,
          reason:
            Number(item.odds) >= 2
              ? "The odds are higher here, so this adds more risk to the ticket."
              : "This keeps the pick without adding another high-odds selection."
        })),
        "A middle-ground mix — not too cautious, not too aggressive."
      ),

      RISKY: profile(
        riskySelections.map(item => ({
          event: item.event,
          market: item.market,
          pick: item.pick,
          odds: Number(item.odds),
          eventId: item.eventId,
          gameId: item.gameId,
          marketId: item.marketId,
          specifier:
            item.specifier === undefined
              ? null
              : item.specifier,
          outcomeId: item.outcomeId,
          startTime: item.startTime,
          reason:
            Number(item.odds) >= 2
              ? "The odds are higher here, so there’s less room for mistakes."
              : "This keeps another original selection in the ticket."
        })),
        "This keeps more of the action, but there’s less room for mistakes."
      ),

      "AI RECOMMENDED": profile(
        aiRecommendedSelections,
        "I looked at the available SportyBet markets and picked one verified option for each game."
      )
    };

    // ---------------------------------------------------------
    // Diagnostic information
    // ---------------------------------------------------------

    const diagnostics = {
      requestedSelections: selections.length,
      uniqueEvents: uniqueEvents.length,
      eventsWithMarkets: marketResults.filter(
        x => x.markets.length > 0
      ).length,
      aiRecommendedCount: aiRecommendedSelections.length,
      aiExpectedCount: uniqueEvents.length,
      aiComplete:
        aiRecommendedSelections.length === uniqueEvents.length,
      marketErrors: marketResults
        .filter(x => x.error)
        .map(x => ({
          eventId: x.eventId,
          event: x.event,
          error: x.error
        })),
      aiErrors
    };

    return res.status(200).json({
      success: true,
      profiles,
      diagnostics
    });

  } catch (error) {
    console.error("OPTIMIZE ERROR:", error);

    return res.status(500).json({
      success: false,
      error: error.message || "Optimization failed"
    });
  }
}
