export const maxDuration = 60;

const RENDER_API = "https://sportybet-api.onrender.com";

const clean = (v) =>
  v === null || v === undefined ? null : String(v).trim();

const same = (a, b) => clean(a) === clean(b);

function flattenMarkets(result) {
  const rows = [];

  if (!Array.isArray(result?.markets)) return rows;

  for (const market of result.markets) {
    if (!Array.isArray(market?.outcomes)) continue;

    for (const outcome of market.outcomes) {
      if (!outcome) continue;

      const odds = Number(outcome.odds);

      if (!Number.isFinite(odds) || odds <= 0) continue;

      rows.push({
        marketId: clean(market.marketId),
        market: clean(market.market),
        specifier: clean(market.specifier),
        outcomeId: clean(outcome.outcomeId),
        pick: clean(outcome.pick),
        odds
      });
    }
  }

  return rows;
}

function combinedOdds(selections) {
  if (!Array.isArray(selections) || !selections.length) {
    return null;
  }

  let total = 1;

  for (const selection of selections) {
    const odds = Number(selection.odds);

    if (!Number.isFinite(odds) || odds <= 0) {
      return null;
    }

    total *= odds;
  }

  return Number(total.toFixed(2));
}

function selectOriginal(selections, count, mode) {
  if (mode === "RISKY") {
    return selections.slice(0, count);
  }

  return [...selections]
    .sort((a, b) => Number(a.odds) - Number(b.odds))
    .slice(0, count);
}

async function askGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("GEMINI_API_KEY is missing.");
  }

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
      encodeURIComponent(key),
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
          temperature: 0.15,
          responseMimeType: "application/json"
        }
      })
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Gemini error ${response.status}: ${text.slice(0, 500)}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Gemini returned invalid JSON.");
  }

  const output = data?.candidates?.[0]?.content?.parts
    ?.map((p) => p.text || "")
    .join("")
    .trim();

  if (!output) {
    throw new Error("Gemini returned an empty response.");
  }

  try {
    return JSON.parse(output);
  } catch {
    throw new Error(
      "Gemini JSON could not be parsed: " + output.slice(0, 500)
    );
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "POST only"
    });
  }

  try {
    /*
    ============================================================
    1. RECEIVE ORIGINAL SPORTYBET SELECTIONS
    ============================================================
    */

    const selections = Array.isArray(req.body?.selections)
      ? req.body.selections
      : [];

    if (!selections.length) {
      return res.status(400).json({
        success: false,
        error: "No selections received."
      });
    }

    const original = selections
      .map((x) => ({
        event: clean(x.event),
        market: clean(x.market),
        pick: clean(x.pick),
        odds: Number(x.odds),
        eventId: clean(x.eventId),
        gameId: clean(x.gameId),
        marketId: clean(x.marketId),
        specifier:
          x.specifier === null ||
          x.specifier === undefined ||
          x.specifier === ""
            ? null
            : clean(x.specifier),
        outcomeId: clean(x.outcomeId),
        startTime: x.startTime
      }))
      .filter((x) => x.eventId);

    if (!original.length) {
      return res.status(400).json({
        success: false,
        error: "No valid event IDs found."
      });
    }

    /*
    ============================================================
    2. UNIQUE EVENTS
    ============================================================
    */

    const eventIds = [...new Set(original.map((x) => x.eventId))];

    /*
    ============================================================
    3. ONE BATCH REQUEST TO RENDER
    ============================================================
    */

    const query = eventIds
      .map((id) => encodeURIComponent(id))
      .join(",");

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 30000);

    let response;

    try {
      response = await fetch(
        `${RENDER_API}/event-markets?eventIds=${query}`,
        {
          method: "GET",
          signal: controller.signal
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const text = await response.text();

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        error: `SportyBet market service returned ${response.status}.`,
        details: text.slice(0, 500)
      });
    }

    let batch;

    try {
      batch = JSON.parse(text);
    } catch {
      return res.status(502).json({
        success: false,
        error: "Render returned invalid JSON."
      });
    }

    /*
    ============================================================
    4. CREATE EVENT MARKET MAP
    ============================================================
    */

    const marketMap = new Map();

    const results = Array.isArray(batch?.results)
      ? batch.results
      : [];

    for (const result of results) {
      const eventId = clean(result?.eventId);

      if (!eventId) continue;

      marketMap.set(eventId, {
        event: result.event || null,
        markets: flattenMarkets(result)
      });
    }

    /*
    ============================================================
    5. SAFE / BALANCED / RISKY
    ============================================================
    */

    const total = original.length;

    const safeCount =
      total <= 2
        ? total
        : Math.ceil(total / 2);

    const balancedCount =
      total <= 2
        ? total
        : Math.ceil(total * 0.75);

    const riskyCount = total;

    const safe = selectOriginal(
      original,
      safeCount,
      "SAFE"
    );

    const balanced = selectOriginal(
      original,
      balancedCount,
      "BALANCED"
    );

    const risky = selectOriginal(
      original,
      riskyCount,
      "RISKY"
    );

    /*
    ============================================================
    6. PREPARE DATA FOR GEMINI
    ============================================================
    */

    const aiInput = eventIds.map((eventId) => {
      const originalSelection =
        original.find((x) => x.eventId === eventId);

      const marketInfo = marketMap.get(eventId);

      return {
        eventId,

        event:
          marketInfo?.event || {
            eventId,
            homeTeamName: "",
            awayTeamName: ""
          },

        originalSelection,

        availableMarkets:
          marketInfo?.markets || []
      };
    });

    /*
    ============================================================
    7. ASK GEMINI
    ============================================================
    */

    const prompt = `
You are selecting alternative SportyBet markets.

There are ${eventIds.length} UNIQUE football games.

YOUR MOST IMPORTANT RULE:

Return EXACTLY ONE recommendation for EACH eventId.

If there are 4 eventIds, return 4 recommendations.
If there are 8 eventIds, return 8 recommendations.

Do NOT combine games.
Do NOT return one recommendation for the whole ticket.
Do NOT skip a game.

You may select any available SportyBet market supplied for that event.

STRICT RULES:

1. eventId MUST come from the supplied data.
2. marketId MUST come from the supplied data.
3. specifier MUST exactly match the supplied data.
4. outcomeId MUST come from the supplied data.
5. Never invent odds.
6. Never invent markets.
7. Never invent outcome IDs.
8. Use only the supplied markets.
9. Each eventId must appear exactly once.
10. Prefer simple/common markets where reasonable.
11. Do not claim that a selection is guaranteed to win.
12. Do not invent team form, injuries or statistics.

Return ONLY JSON:

{
  "summary": "one short natural sentence",
  "recommendations": [
    {
      "eventId": "string",
      "marketId": "string",
      "specifier": "string or null",
      "outcomeId": "string",
      "reason": "one short natural sentence"
    }
  ]
}

STYLE:

Sound like a knowledgeable football fan explaining the ticket.

Avoid robotic wording such as:
"optimize stability"
"lower variance profile"
"selection profile"
"relative variance"

Keep reasons short and natural.

Here is the real SportyBet market data:

${JSON.stringify(aiInput)}
`;

    let ai;

    try {
      ai = await askGemini(prompt);
    } catch (error) {
      /*
      Gemini failed, but SAFE/BALANCED/RISKY should still work.
      */

      return res.status(200).json({
        success: true,

        profiles: {
          SAFE: {
            summary:
              "I’ve trimmed this down to the less aggressive picks.",
            selections: safe,
            combinedOdds: combinedOdds(safe)
          },

          BALANCED: {
            summary:
              "A middle-ground mix — not too cautious, not too aggressive.",
            selections: balanced,
            combinedOdds: combinedOdds(balanced)
          },

          RISKY: {
            summary:
              "This keeps more of the action, but there’s less room for mistakes.",
            selections: risky,
            combinedOdds: combinedOdds(risky)
          },

          "AI RECOMMENDED": {
            summary:
              "The AI recommendation could not be completed this time.",
            selections: [],
            combinedOdds: null
          }
        },

        diagnostics: {
          requestedSelections: total,
          uniqueEvents: eventIds.length,
          eventsWithMarkets: eventIds.filter(
            (id) =>
              (marketMap.get(id)?.markets || []).length > 0
          ).length,
          aiRecommendedCount: 0,
          aiExpectedCount: eventIds.length,
          aiComplete: false,
          aiError: error?.message || String(error)
        }
      });
    }

    /*
    ============================================================
    8. VALIDATE GEMINI PICKS
    ============================================================
    */

    const recommendations = Array.isArray(
      ai?.recommendations
    )
      ? ai.recommendations
      : [];

    const verified = [];
    const errors = [];
    const usedEvents = new Set();

    for (const rec of recommendations) {
      const eventId = clean(rec?.eventId);

      if (!eventId) {
        errors.push("Missing eventId.");
        continue;
      }

      if (!eventIds.includes(eventId)) {
        errors.push(
          `Unknown eventId: ${eventId}`
        );
        continue;
      }

      if (usedEvents.has(eventId)) {
        errors.push(
          `Duplicate eventId: ${eventId}`
        );
        continue;
      }

      const available =
        marketMap.get(eventId)?.markets || [];

      /*
      EXACT validation against SportyBet.
      */

      const match = available.find(
        (market) =>
          same(market.marketId, rec.marketId) &&
          same(market.specifier, rec.specifier) &&
          same(market.outcomeId, rec.outcomeId)
      );

      if (!match) {
        errors.push(
          `Unverified recommendation for ${eventId}`
        );
        continue;
      }

      const originalSelection =
        original.find(
          (x) => x.eventId === eventId
        );

      verified.push({
        event: originalSelection?.event || "",
        market: match.market,
        pick: match.pick,
        odds: match.odds,

        eventId,
        gameId: originalSelection?.gameId || "",
        marketId: match.marketId,
        specifier: match.specifier,
        outcomeId: match.outcomeId,
        startTime: originalSelection?.startTime,

        reason:
          clean(rec.reason) ||
          "This is an available SportyBet market for the game."
      });

      usedEvents.add(eventId);
    }

    /*
    ============================================================
    9. FILL ONLY MISSING EVENTS USING REAL MARKETS
    ============================================================
    */

    for (const eventId of eventIds) {
      if (usedEvents.has(eventId)) continue;

      const available =
        marketMap.get(eventId)?.markets || [];

      if (!available.length) {
        errors.push(
          `No markets available for ${eventId}`
        );
        continue;
      }

      const preferredMarkets = [
        "Double Chance",
        "Over/Under",
        "Draw No Bet",
        "1X2"
      ];

      let fallback = null;

      for (const marketName of preferredMarkets) {
        const candidates = available
          .filter(
            (x) => x.market === marketName
          )
          .sort((a, b) => a.odds - b.odds);

        if (candidates.length) {
          fallback = candidates[0];
          break;
        }
      }

      if (!fallback) {
        fallback = [...available].sort(
          (a, b) => a.odds - b.odds
        )[0];
      }

      const originalSelection =
        original.find(
          (x) => x.eventId === eventId
        );

      verified.push({
        event: originalSelection?.event || "",
        market: fallback.market,
        pick: fallback.pick,
        odds: fallback.odds,

        eventId,
        gameId: originalSelection?.gameId || "",
        marketId: fallback.marketId,
        specifier: fallback.specifier,
        outcomeId: fallback.outcomeId,
        startTime: originalSelection?.startTime,

        reason:
          "This is a verified market currently available on SportyBet."
      });

      usedEvents.add(eventId);
    }

    /*
    ============================================================
    10. PUT AI PICKS IN ORIGINAL GAME ORDER
    ============================================================
    */

    const aiSelections = eventIds
      .map((eventId) =>
        verified.find(
          (x) => x.eventId === eventId
        )
      )
      .filter(Boolean);

    const aiComplete =
      aiSelections.length === eventIds.length;

    /*
    ============================================================
    11. FINAL RESPONSE
    ============================================================
    */

    return res.status(200).json({
      success: true,

      profiles: {
        SAFE: {
          summary:
            "I’ve trimmed this down to the less aggressive picks.",
          selections: safe,
          combinedOdds: combinedOdds(safe)
        },

        BALANCED: {
          summary:
            "A middle-ground mix — not too cautious, not too aggressive.",
          selections: balanced,
          combinedOdds: combinedOdds(balanced)
        },

        RISKY: {
          summary:
            "This keeps more of the action, but there’s less room for mistakes.",
          selections: risky,
          combinedOdds: combinedOdds(risky)
        },

        "AI RECOMMENDED": {
          summary:
            ai?.summary ||
            "I looked at the available SportyBet markets and picked the options that fit the games better.",
          selections: aiSelections,
          combinedOdds: combinedOdds(aiSelections)
        }
      },

      diagnostics: {
        requestedSelections: total,
        uniqueEvents: eventIds.length,
        eventsWithMarkets: eventIds.filter(
          (id) =>
            (marketMap.get(id)?.markets || []).length > 0
        ).length,
        aiRecommendedCount: aiSelections.length,
        aiExpectedCount: eventIds.length,
        aiComplete,
        aiErrors: errors
      }
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
          }
