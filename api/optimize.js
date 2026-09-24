export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  try {
    const selections = Array.isArray(req.body?.selections)
      ? req.body.selections
      : [];

    if (!selections.length) {
      return res.status(400).json({
        success: false,
        error: "No selections received."
      });
    }

    const RENDER_BASE =
      process.env.RENDER_API_URL ||
      "https://sportybet-api.onrender.com";

    const GEMINI_KEY =
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;

    /*
      ---------------------------------------------------------
      1. NORMALIZE THE ORIGINAL SELECTIONS
      ---------------------------------------------------------
    */

    const originals = selections
      .map((s) => ({
        event: s.event || `${s.homeTeamName || ""} vs ${s.awayTeamName || ""}`.trim(),
        eventId: String(s.eventId || ""),
        gameId: String(s.gameId || ""),
        marketId: String(s.marketId || ""),
        specifier:
          s.specifier === null || s.specifier === undefined
            ? ""
            : String(s.specifier),
        outcomeId: String(s.outcomeId || ""),
        market: s.market || "",
        pick: s.pick || "",
        odds: Number(s.odds || 0),
        startTime: s.startTime || null
      }))
      .filter((s) => s.eventId && s.gameId);

    if (!originals.length) {
      return res.status(400).json({
        success: false,
        error: "The selections do not contain valid SportyBet event IDs."
      });
    }

    /*
      ---------------------------------------------------------
      2. UNIQUE EVENTS
      ---------------------------------------------------------
      We deliberately use every unique event from the booking.
    */

    const uniqueEvents = [];

    for (const selection of originals) {
      if (!uniqueEvents.some((e) => e.eventId === selection.eventId)) {
        uniqueEvents.push({
          eventId: selection.eventId,
          gameId: selection.gameId,
          event: selection.event,
          startTime: selection.startTime
        });
      }
    }

    /*
      ---------------------------------------------------------
      3. FETCH SPORTYBET MARKETS
      ---------------------------------------------------------
      Try the batch endpoint first.
      If an event is missing, try the individual endpoint.
    */

    async function fetchJSON(url, options = {}) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      try {
        const response = await fetch(url, {
          ...options,
          signal: controller.signal
        });

        const text = await response.text();

        let data = null;

        try {
          data = JSON.parse(text);
        } catch {
          data = null;
        }

        return {
          ok: response.ok,
          status: response.status,
          data
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    const eventIds = uniqueEvents.map((e) => e.eventId);

    let batchData = null;

    try {
      const batchURL =
        `${RENDER_BASE}/event-markets?eventIds=` +
        encodeURIComponent(eventIds.join(","));

      const batchResponse = await fetchJSON(batchURL);

      if (batchResponse.ok && batchResponse.data) {
        batchData = batchResponse.data;
      }
    } catch (error) {
      batchData = null;
    }

    const marketMap = new Map();

    /*
      Accept both:

      {
        results: [...]
      }

      and

      [...]
    */

    let batchResults = [];

    if (Array.isArray(batchData)) {
      batchResults = batchData;
    } else if (Array.isArray(batchData?.results)) {
      batchResults = batchData.results;
    }

    for (const result of batchResults) {
      if (
        result &&
        result.success &&
        result.event?.eventId &&
        Array.isArray(result.markets)
      ) {
        marketMap.set(String(result.event.eventId), result);
      }
    }

    /*
      Individual lookup for anything missing from batch.
    */

    let individualMarketRequests = 0;

    for (const event of uniqueEvents) {
      if (marketMap.has(event.eventId)) continue;

      try {
        individualMarketRequests++;

        const url =
          `${RENDER_BASE}/event-markets/` +
          encodeURIComponent(event.eventId);

        const response = await fetchJSON(url);

        if (
          response.ok &&
          response.data?.success &&
          Array.isArray(response.data?.markets)
        ) {
          marketMap.set(event.eventId, response.data);
        }
      } catch {
        // Keep the event unresolved rather than inventing data.
      }
    }

    /*
      ---------------------------------------------------------
      4. FLATTEN MARKETS INTO VALID SPORTYBET OPTIONS
      ---------------------------------------------------------
    */

    function flattenMarkets(result) {
      const output = [];

      if (!result || !Array.isArray(result.markets)) {
        return output;
      }

      for (const market of result.markets) {
        if (!market || !Array.isArray(market.outcomes)) continue;

        const marketId = String(market.marketId || "");

        if (!marketId) continue;

        const specifier =
          market.specifier === null ||
          market.specifier === undefined
            ? ""
            : String(market.specifier);

        /*
          Ignore explicitly inactive/suspended markets.
        */

        if (
          market.status !== null &&
          market.status !== undefined &&
          String(market.status) === "2"
        ) {
          continue;
        }

        for (const outcome of market.outcomes) {
          if (!outcome) continue;

          if (outcome.isActive === false) continue;

          const outcomeId = String(outcome.outcomeId || "");

          if (!outcomeId) continue;

          const odds = Number(outcome.odds);

          if (!Number.isFinite(odds) || odds <= 0) continue;

          output.push({
            eventId: String(result.event?.eventId || ""),
            gameId: String(result.event?.gameId || ""),
            event:
              `${result.event?.homeTeamName || ""} vs ` +
              `${result.event?.awayTeamName || ""}`.trim(),
            homeTeamName: result.event?.homeTeamName || "",
            awayTeamName: result.event?.awayTeamName || "",
            startTime: result.event?.startTime || null,
            marketId,
            market: market.market || "",
            specifier,
            outcomeId,
            pick: outcome.pick || "",
            odds
          });
        }
      }

      return output;
    }

    const optionsByEvent = new Map();

    for (const event of uniqueEvents) {
      const result = marketMap.get(event.eventId);

      const options = flattenMarkets(result);

      if (options.length) {
        optionsByEvent.set(event.eventId, options);
      }
    }

    /*
      ---------------------------------------------------------
      5. VERIFY ORIGINAL SELECTIONS
      ---------------------------------------------------------
    */

    function sameSelection(a, b) {
      return (
        String(a.eventId) === String(b.eventId) &&
        String(a.marketId) === String(b.marketId) &&
        String(a.specifier || "") === String(b.specifier || "") &&
        String(a.outcomeId) === String(b.outcomeId)
      );
    }

    const verifiedOriginals = originals.filter((original) => {
      const options = optionsByEvent.get(original.eventId) || [];

      return options.some((option) => sameSelection(original, option));
    });

    /*
      ---------------------------------------------------------
      6. NATURAL PROFILE BUILDING
      ---------------------------------------------------------
    */

    const uniqueVerified = [];

    for (const selection of verifiedOriginals) {
      if (
        !uniqueVerified.some(
          (existing) => existing.eventId === selection.eventId
        )
      ) {
        uniqueVerified.push(selection);
      }
    }

    /*
      SAFE:
      Keep approximately the lower half of the verified originals.
    */

    const sortedByOdds = [...uniqueVerified].sort(
      (a, b) => Number(a.odds || 999) - Number(b.odds || 999)
    );

    const safeCount = Math.max(
      1,
      Math.ceil(sortedByOdds.length * 0.5)
    );

    const balancedCount = Math.max(
      1,
      Math.ceil(sortedByOdds.length * 0.75)
    );

    const safeSelections = sortedByOdds.slice(0, safeCount);

    const balancedSelections = sortedByOdds.slice(
      0,
      balancedCount
    );

    const riskySelections = [...uniqueVerified];

    /*
      ---------------------------------------------------------
      7. AI RECOMMENDED
      ---------------------------------------------------------
      IMPORTANT:
      ONE selection PER UNIQUE EVENT.

      The AI is only allowed to choose from real SportyBet
      options returned by the backend.
    */

    const aiCandidates = [];

    for (const event of uniqueEvents) {
      const options = optionsByEvent.get(event.eventId) || [];

      if (!options.length) continue;

      /*
        Give the AI a sensible subset instead of thousands of
        correct-score/handicap combinations.

        We keep common markets that are easier to understand.
      */

      const preferredMarkets = new Set([
        "1X2",
        "1X2 - 2UP",
        "Over/Under",
        "Double Chance",
        "GG/NG",
        "Draw No Bet",
        "Asian Handicap",
        "Over/Under & GG/NG"
      ]);

      let candidates = options.filter((option) =>
        preferredMarkets.has(option.market)
      );

      /*
        If filtering removed everything, use the actual markets.
      */

      if (!candidates.length) {
        candidates = options;
      }

      /*
        Do not allow extreme correct-score style odds to dominate
        the AI input.
      */

      candidates = candidates
        .filter((option) => option.odds <= 8)
        .sort((a, b) => a.odds - b.odds)
        .slice(0, 35);

      aiCandidates.push({
        eventId: event.eventId,
        event: event.event,
        original:
          originals.find((o) => o.eventId === event.eventId) || null,
        options: candidates
      });
    }

    /*
      ---------------------------------------------------------
      8. ASK GEMINI
      ---------------------------------------------------------
    */

    let aiReturned = [];

    if (GEMINI_KEY && aiCandidates.length) {
      const prompt = `
You are helping analyze a football betting selection list.

IMPORTANT RULES:

1. There are ${uniqueEvents.length} unique football games.
2. You MUST return exactly ONE recommendation for EVERY game that has
   available SportyBet options in the supplied data.
3. NEVER combine games.
4. NEVER return one recommendation for the whole booking.
5. NEVER invent a market.
6. NEVER invent an outcome.
7. Only select an option whose exact eventId, marketId, specifier,
   and outcomeId appear in the supplied SportyBet options.
8. You may choose an alternative market to the user's original selection.
9. Prefer understandable mainstream markets.
10. Do not use Correct Score unless there is no reasonable alternative.
11. Avoid extremely high odds.
12. This is not a guarantee of winning. Do not use certainty language.

STYLE:

Make summaries and reasons sound natural and human, like a knowledgeable
football fan explaining the ticket to another fan.

Do not use robotic phrases such as:
- optimize stability
- lower variance profile
- selection profile
- relative variance
- this profile focuses on
- this selection has a lower variance

Keep reasons to one short sentence.

Return JSON only.

Required format:

{
  "recommendations": [
    {
      "eventId": "...",
      "marketId": "...",
      "specifier": "...",
      "outcomeId": "...",
      "reason": "..."
    }
  ]
}

SPORTYBET DATA:

${JSON.stringify(aiCandidates)}
`;

      try {
        const geminiURL =
          "https://generativelanguage.googleapis.com/v1beta/models/" +
          "gemini-2.5-flash:generateContent?key=" +
          encodeURIComponent(GEMINI_KEY);

        const geminiResponse = await fetchJSON(geminiURL, {
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
        });

        const text =
          geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
          "";

        if (text) {
          try {
            const parsed = JSON.parse(text);

            if (Array.isArray(parsed?.recommendations)) {
              aiReturned = parsed.recommendations;
            }
          } catch {
            aiReturned = [];
          }
        }
      } catch {
        aiReturned = [];
      }
    }

    /*
      ---------------------------------------------------------
      9. VALIDATE AI OUTPUT
      ---------------------------------------------------------
      No AI selection reaches the user unless it exists in the
      actual SportyBet market data.
    */

    const aiValidated = [];

    for (const recommendation of aiReturned) {
      if (!recommendation) continue;

      const eventId = String(recommendation.eventId || "");

      const options = optionsByEvent.get(eventId) || [];

      const exact = options.find(
        (option) =>
          String(option.marketId) ===
            String(recommendation.marketId || "") &&
          String(option.specifier || "") ===
            String(recommendation.specifier || "") &&
          String(option.outcomeId) ===
            String(recommendation.outcomeId || "")
      );

      if (!exact) continue;

      if (
        aiValidated.some(
          (existing) => existing.eventId === exact.eventId
        )
      ) {
        continue;
      }

      aiValidated.push({
        ...exact,
        reason:
          typeof recommendation.reason === "string" &&
          recommendation.reason.trim()
            ? recommendation.reason.trim()
            : "This is a verified SportyBet option available for this game."
      });
    }

    /*
      ---------------------------------------------------------
      10. DETERMINISTIC FALLBACK
      ---------------------------------------------------------
      If Gemini fails or omits a game, select a REAL SportyBet
      option for that event.

      This guarantees coverage without fabricating anything.
    */

    const aiFinalSelections = [];

    for (const event of uniqueEvents) {
      const options = optionsByEvent.get(event.eventId) || [];

      if (!options.length) continue;

      /*
        First use Gemini's validated recommendation.
      */

      const aiPick = aiValidated.find(
        (selection) => selection.eventId === event.eventId
      );

      if (aiPick) {
        aiFinalSelections.push(aiPick);
        continue;
      }

      /*
        Otherwise prefer a sensible mainstream market.

        We deliberately avoid blindly copying the original first.
      */

      const original = originals.find(
        (selection) => selection.eventId === event.eventId
      );

      const preferred = options
        .filter((option) =>
          [
            "Double Chance",
            "Over/Under",
            "GG/NG",
            "Draw No Bet",
            "1X2"
          ].includes(option.market)
        )
        .filter((option) => option.odds >= 1.05 && option.odds <= 2.5)
        .sort((a, b) => a.odds - b.odds);

      let fallback = preferred[0];

      /*
        If possible, choose a different verified market from the
        original selection.
      */

      if (original) {
        const different = preferred.find(
          (option) => !sameSelection(option, original)
        );

        if (different) {
          fallback = different;
        }
      }

      /*
        Final fallback: any valid active SportyBet option.
      */

      if (!fallback) {
        fallback = [...options]
          .filter((option) => option.odds >= 1.01)
          .sort((a, b) => a.odds - b.odds)[0];
      }

      if (!fallback) continue;

      aiFinalSelections.push({
        ...fallback,
        reason:
          original &&
          sameSelection(fallback, original)
            ? "This is the verified SportyBet option from your original selection."
            : "This alternative is available on SportyBet and gives a different way to approach the game."
      });
    }

    /*
      ---------------------------------------------------------
      11. HUMAN-FRIENDLY SUMMARIES
      ---------------------------------------------------------
    */

    const profiles = {
      SAFE: {
        summary: "I’ve trimmed this down to the less aggressive picks.",
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
          "I looked at the available SportyBet markets and picked one option for each game.",
        selections: aiFinalSelections
      }
    };

    /*
      ---------------------------------------------------------
      12. FINAL DIAGNOSTICS
      ---------------------------------------------------------
    */

    const diagnostics = {
      receivedSelections: originals.length,
      requestedEvents: uniqueEvents.length,
      batchEventsReturned: batchResults.filter(
        (r) => r?.success
      ).length,
      individualMarketRequests,
      usableEvents: optionsByEvent.size,
      verifiedOriginals: verifiedOriginals.length,
      aiReturned: aiReturned.length,
      aiValidated: aiValidated.length,
      aiFinalSelections: aiFinalSelections.length,

      requestedEventIds: uniqueEvents.map(
        (event) => event.eventId
      ),

      finalAIEventIds: aiFinalSelections.map(
        (selection) => selection.eventId
      ),

      missingMarketEventIds: uniqueEvents
        .filter((event) => !optionsByEvent.has(event.eventId))
        .map((event) => event.eventId),

      aiCoverageComplete:
        aiFinalSelections.length === uniqueEvents.length
    };

    /*
      ---------------------------------------------------------
      13. RETURN
      ---------------------------------------------------------
    */

    return res.status(200).json({
      success: true,
      profiles,
      diagnostics
    });
  } catch (error) {
    console.error("OPTIMIZE ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Optimizer failed.",
      details:
        process.env.NODE_ENV === "development"
          ? String(error?.message || error)
          : undefined
    });
  }
}
