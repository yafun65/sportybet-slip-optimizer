export const maxDuration = 60;

const RENDER_API = "https://sportybet-api.onrender.com";

function clean(value) {
  return value === null || value === undefined ? null : String(value).trim();
}

function same(a, b) {
  return clean(a) === clean(b);
}

function flattenMarkets(eventData) {
  const markets = Array.isArray(eventData?.markets)
    ? eventData.markets
    : [];

  const rows = [];

  for (const market of markets) {
    const marketId = clean(market.marketId);
    const marketName = clean(market.market);
    const specifier =
      market.specifier === null || market.specifier === undefined
        ? null
        : clean(market.specifier);

    const outcomes = Array.isArray(market.outcomes)
      ? market.outcomes
      : [];

    for (const outcome of outcomes) {
      if (outcome?.isActive === false) continue;

      rows.push({
        marketId,
        market: marketName,
        specifier,
        outcomeId: clean(outcome.outcomeId),
        pick: clean(outcome.pick),
        odds: Number(outcome.odds)
      });
    }
  }

  return rows.filter(
    x =>
      x.marketId &&
      x.outcomeId &&
      x.pick &&
      Number.isFinite(x.odds) &&
      x.odds > 0
  );
}

function getRequestedCount(total) {
  if (total <= 1) return total;
  if (total === 2) return 1;
  if (total === 3) return 2;
  if (total === 4) return 2;

  return Math.max(1, Math.floor(total * 0.5));
}

function chooseOriginalSelections(selections, count, mode) {
  const sorted = [...selections].sort(
    (a, b) => Number(a.odds || 999) - Number(b.odds || 999)
  );

  if (mode === "SAFE") {
    return sorted.slice(0, count);
  }

  if (mode === "BALANCED") {
    return sorted.slice(0, count);
  }

  return selections.slice(0, count);
}

function combinedOdds(selections) {
  if (!Array.isArray(selections) || !selections.length) return null;

  const odds = selections
    .map(x => Number(x.odds))
    .filter(x => Number.isFinite(x) && x > 0);

  if (!odds.length) return null;

  return odds.reduce((total, value) => total * value, 1);
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in Vercel.");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
      encodeURIComponent(apiKey),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Gemini request failed (${response.status}): ${text.slice(0, 500)}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }

  const output =
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

  if (!output) {
    throw new Error("Gemini returned an empty response.");
  }

  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      "Gemini response could not be parsed as JSON: " +
        output.slice(0, 500)
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const input = req.body || {};

    const selections = Array.isArray(input.selections)
      ? input.selections
      : [];

    if (!selections.length) {
      return res.status(400).json({
        success: false,
        error: "No selections supplied."
      });
    }

    /*
      ---------------------------------------------------------
      1. NORMALIZE ORIGINAL SELECTIONS
      ---------------------------------------------------------
    */

    const normalized = selections
      .map(item => ({
        event: clean(item.event),
        market: clean(item.market),
        pick: clean(item.pick),
        odds: Number(item.odds),
        eventId: clean(item.eventId),
        gameId: clean(item.gameId),
        marketId: clean(item.marketId),
        specifier:
          item.specifier === null ||
          item.specifier === undefined ||
          item.specifier === ""
            ? null
            : clean(item.specifier),
        outcomeId: clean(item.outcomeId),
        startTime: item.startTime
      }))
      .filter(item => item.eventId);

    if (!normalized.length) {
      return res.status(400).json({
        success: false,
        error: "No valid event IDs were found."
      });
    }

    /*
      ---------------------------------------------------------
      2. UNIQUE EVENTS
      ---------------------------------------------------------
    */

    const uniqueEventIds = [
      ...new Set(normalized.map(item => item.eventId))
    ];

    /*
      ---------------------------------------------------------
      3. ONE BATCH REQUEST TO RENDER
      ---------------------------------------------------------
    */

    const eventIdsQuery = uniqueEventIds
      .map(id => encodeURIComponent(id))
      .join(",");

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 25000);

    let marketResponse;

    try {
      marketResponse = await fetch(
        `${RENDER_API}/event-markets?eventIds=${eventIdsQuery}`,
        {
          method: "GET",
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const marketText = await marketResponse.text();

    if (!marketResponse.ok) {
      return res.status(502).json({
        success: false,
        error: `SportyBet market service returned ${marketResponse.status}.`,
        details: marketText.slice(0, 500)
      });
    }

    let marketData;

    try {
      marketData = JSON.parse(marketText);
    } catch {
      return res.status(502).json({
        success: false,
        error: "SportyBet market service returned invalid JSON."
      });
    }

    /*
      ---------------------------------------------------------
      4. BUILD EVENT -> AVAILABLE MARKETS MAP
      ---------------------------------------------------------
    */

    const eventMarkets = new Map();

    const results = Array.isArray(marketData?.results)
      ? marketData.results
      : [];

    for (const result of results) {
      const eventId = clean(result?.eventId);

      if (!eventId || result?.success === false) continue;

      const rows = flattenMarkets(result);

      eventMarkets.set(eventId, {
        event: result.event || null,
        markets: rows
      });
    }

    /*
      ---------------------------------------------------------
      5. SAFE / BALANCED / RISKY
      ---------------------------------------------------------
    */

    const total = normalized.length;

    const safeCount = getRequestedCount(total);
    const balancedCount =
      total <= 2
        ? total
        : Math.max(1, Math.ceil(total * 0.75));

    const riskyCount = total;

    const safeSelections = chooseOriginalSelections(
      normalized,
      safeCount,
      "SAFE"
    );

    const balancedSelections = chooseOriginalSelections(
      normalized,
      balancedCount,
      "BALANCED"
    );

    const riskySelections = chooseOriginalSelections(
      normalized,
      riskyCount,
      "RISKY"
    );

    /*
      ---------------------------------------------------------
      6. PREPARE ALL MARKETS FOR AI
      ---------------------------------------------------------
    */

    const aiEvents = uniqueEventIds.map(eventId => {
      const original =
        normalized.find(x => x.eventId === eventId) || {};

      const available = eventMarkets.get(eventId);

      return {
        eventId,
        event:
          available?.event ||
          {
            eventId,
            homeTeamName: original.event?.split(" vs ")[0] || "",
            awayTeamName: original.event?.split(" vs ")[1] || ""
          },
        originalSelection: original,
        markets: available?.markets || []
      };
    });

    /*
      ---------------------------------------------------------
      7. ASK GEMINI FOR ONE PICK PER GAME
      ---------------------------------------------------------
    */

    const aiPrompt = `
You are helping analyze a SportyBet selection list.

IMPORTANT:
You MUST return EXACTLY ONE recommendation for EVERY UNIQUE eventId provided.

If there are 4 unique games, return 4 recommendations.
If there are 8 unique games, return 8 recommendations.

Never return one recommendation for the entire ticket.

You may choose ANY market from the supplied SportyBet markets.

However:
- You may ONLY choose markets and outcomes that appear in the supplied data.
- Never invent a marketId.
- Never invent an outcomeId.
- Never invent a specifier.
- Never invent odds.
- Every eventId must appear exactly once.
- Prefer straightforward markets rather than exotic markets when there is a reasonable alternative.
- This is not a guarantee of winning. You are simply selecting an alternative market that fits the available options.

STYLE:
Make summaries and reasons sound natural and human, like a knowledgeable football fan explaining the ticket to another fan.

DO NOT use robotic or corporate phrases such as:
"optimize stability"
"lower variance profile"
"selection profile"
"relative variance"
"this profile focuses on"

Prefer short conversational wording.

Examples:
"The original pick carries bigger odds, so this is a less aggressive option."
"This keeps the pick but avoids adding another high-odds selection."
"This alternative is available on SportyBet and gives a different way to approach the game."

Do not make unsupported claims about form, injuries, probability or match outcomes unless such information is supplied.

Return ONLY valid JSON using this structure:

{
  "summary": "short natural sentence",
  "recommendations": [
    {
      "eventId": "string",
      "marketId": "string",
      "specifier": "string or null",
      "outcomeId": "string",
      "reason": "short natural sentence"
    }
  ]
}

Here is the SportyBet data:

${JSON.stringify(aiEvents)}
`;

    let aiRaw;

    try {
      aiRaw = await callGemini(aiPrompt);
    } catch (error) {
      return res.status(200).json({
        success: true,
        profiles: {
          SAFE: {
            summary:
              "I’ve trimmed this down to the less aggressive picks.",
            selections: safeSelections,
            combinedOdds: combinedOdds(safeSelections)
          },

          BALANCED: {
            summary:
              "A middle-ground mix — not too cautious, not too aggressive.",
            selections: balancedSelections,
            combinedOdds: combinedOdds(balancedSelections)
          },

          RISKY: {
            summary:
              "This keeps more of the action, but there’s less room for mistakes.",
            selections: riskySelections,
            combinedOdds: combinedOdds(riskySelections)
          },

          "AI RECOMMENDED": {
            summary:
              "I looked at the available SportyBet markets, but the AI recommendation could not be completed.",
            selections: [],
            combinedOdds: null
          }
        },

        diagnostics: {
          requestedSelections: total,
          uniqueEvents: uniqueEventIds.length,
          eventsWithMarkets: [...eventMarkets.values()].filter(
            x => x.markets.length > 0
          ).length,
          aiRecommendedCount: 0,
          aiExpectedCount: uniqueEventIds.length,
          aiComplete: false,
          aiError: error?.message || String(error)
        }
      });
    }

    /*
      ---------------------------------------------------------
      8. VALIDATE AI RESPONSE
      ---------------------------------------------------------
    */

    const recommendations = Array.isArray(
      aiRaw?.recommendations
    )
      ? aiRaw.recommendations
      : [];

    const verified = [];
    const aiErrors = [];

    const seenEvents = new Set();

    for (const recommendation of recommendations) {
      const eventId = clean(recommendation?.eventId);

      if (!eventId) {
        aiErrors.push("Recommendation missing eventId.");
        continue;
      }

      if (seenEvents.has(eventId)) {
        aiErrors.push(`Duplicate recommendation for ${eventId}.`);
        continue;
      }

      if (!uniqueEventIds.includes(eventId)) {
        aiErrors.push(
          `AI returned an event that was not in the booking: ${eventId}`
        );
        continue;
      }

      const marketList = eventMarkets.get(eventId)?.markets || [];

      const match = marketList.find(row => {
        return (
          same(row.marketId, recommendation.marketId) &&
          same(row.outcomeId, recommendation.outcomeId) &&
          same(row.specifier, recommendation.specifier)
        );
      });

      if (!match) {
        aiErrors.push(
          `Unverified market for ${eventId}: ${JSON.stringify({
            marketId: recommendation.marketId,
            specifier: recommendation.specifier,
            outcomeId: recommendation.outcomeId
          })}`
        );
        continue;
      }

      const original =
        normalized.find(x => x.eventId === eventId) || {};

      verified.push({
        event: original.event,
        market: match.market,
        pick: match.pick,
        odds: match.odds,
        eventId,
        gameId: original.gameId,
        marketId: match.marketId,
        specifier: match.specifier,
        outcomeId: match.outcomeId,
        startTime: original.startTime,
        reason:
          clean(recommendation.reason) ||
          "This alternative is available on SportyBet."
      });

      seenEvents.add(eventId);
    }

    /*
      ---------------------------------------------------------
      9. REQUIRE ONE VERIFIED PICK PER GAME
      ---------------------------------------------------------
    */

    const aiComplete =
      verified.length === uniqueEventIds.length;

    /*
      If Gemini missed a game, DO NOT invent a selection.
      Instead, try to fill the missing event with the lowest-odds
      verified SportyBet market.
    */

    if (!aiComplete) {
      for (const eventId of uniqueEventIds) {
        if (seenEvents.has(eventId)) continue;

        const marketList =
          eventMarkets.get(eventId)?.markets || [];

        if (!marketList.length) {
          aiErrors.push(
            `No SportyBet markets available for ${eventId}.`
          );
          continue;
        }

        /*
          Prefer simple/common markets for the fallback:
          Double Chance
          Over/Under
          Draw No Bet
          1X2
        */

        const preferredNames = [
          "Double Chance",
          "Over/Under",
          "Draw No Bet",
          "1X2"
        ];

        let fallback = null;

        for (const name of preferredNames) {
          const candidates = marketList
            .filter(row => row.market === name)
            .sort((a, b) => a.odds - b.odds);

          if (candidates.length) {
            fallback = candidates[0];
            break;
          }
        }

        if (!fallback) {
          fallback = [...marketList].sort(
            (a, b) => a.odds - b.odds
          )[0];
        }

        const original =
          normalized.find(x => x.eventId === eventId) || {};

        verified.push({
          event: original.event,
          market: fallback.market,
          pick: fallback.pick,
          odds: fallback.odds,
          eventId,
          gameId: original.gameId,
          marketId: fallback.marketId,
          specifier: fallback.specifier,
          outcomeId: fallback.outcomeId,
          startTime: original.startTime,
          reason:
            "This is an available SportyBet market for the game."
        });

        seenEvents.add(eventId);
      }
    }

    /*
      Sort AI selections in the same order as the original booking.
    */

    const orderedAISelections = uniqueEventIds
      .map(eventId =>
        verified.find(x => x.eventId === eventId)
      )
      .filter(Boolean);

    const finalAIComplete =
      orderedAISelections.length === uniqueEventIds.length;

    /*
      ---------------------------------------------------------
      10. RETURN RESULT
      ---------------------------------------------------------
    */

    return res.status(200).json({
      success: true,

      profiles: {
        SAFE: {
          summary:
            "I’ve trimmed this down to the less aggressive picks.",
          selections: safeSelections,
          combinedOdds: combinedOdds(safeSelections)
        },

        BALANCED: {
          summary:
            "A middle-ground mix — not too cautious, not too aggressive.",
          selections: balancedSelections,
          combinedOdds: combinedOdds(balancedSelections)
        },

        RISKY: {
          summary:
            "This keeps more of the action, but there’s less room for mistakes.",
          selections: riskySelections,
          combinedOdds: combinedOdds(riskySelections)
        },

        "AI RECOMMENDED": {
          summary:
            aiRaw?.summary ||
            "I looked at the available SportyBet markets and picked the options that fit the games better.",
          selections: orderedAISelections,
          combinedOdds: combinedOdds(orderedAISelections)
        }
      },

      diagnostics: {
        requestedSelections: total,
        uniqueEvents: uniqueEventIds.length,
        eventsWithMarkets: [...eventMarkets.values()].filter(
          x => x.markets.length > 0
        ).length,
        aiRecommendedCount: orderedAISelections.length,
        aiExpectedCount: uniqueEventIds.length,
        aiComplete: finalAIComplete,
        aiErrors
      }
    });
  } catch (error) {
    console.error("Optimize error:", error);

    return res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
                                               }
