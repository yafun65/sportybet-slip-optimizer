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
      process.env.GOOGLE_API_KEY ||
      "";

    const originals = selections
      .map((s) => ({
        event: s.event ||
          `${s.homeTeamName || ""} vs ${s.awayTeamName || ""}`.trim(),

        eventId: String(s.eventId || ""),
        gameId: String(s.gameId || ""),
        marketId: String(s.marketId || ""),

        specifier:
          s.specifier === null ||
          s.specifier === undefined
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

    // ---------------------------------------------------------
    // UNIQUE EVENTS
    // ---------------------------------------------------------

    const uniqueEvents = [];

    for (const selection of originals) {
      if (
        !uniqueEvents.some(
          (event) => event.eventId === selection.eventId
        )
      ) {
        uniqueEvents.push({
          eventId: selection.eventId,
          gameId: selection.gameId,
          event: selection.event,
          startTime: selection.startTime
        });
      }
    }

    // ---------------------------------------------------------
    // FETCH JSON HELPER
    // ---------------------------------------------------------

    async function fetchJSON(url, options = {}) {
      const controller = new AbortController();

      const timeout = setTimeout(() => {
        controller.abort();
      }, 20000);

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
          data,
          rawText: text
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    // ---------------------------------------------------------
    // LOAD SPORTYBET MARKETS
    // ---------------------------------------------------------

    const eventIds = uniqueEvents.map(
      (event) => event.eventId
    );

    let batchData = null;

    try {
      const batchURL =
        `${RENDER_BASE}/event-markets?eventIds=` +
        encodeURIComponent(eventIds.join(","));

      const batchResponse = await fetchJSON(batchURL);

      if (batchResponse.ok && batchResponse.data) {
        batchData = batchResponse.data;
      }
    } catch {
      batchData = null;
    }

    const marketMap = new Map();

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
        marketMap.set(
          String(result.event.eventId),
          result
        );
      }
    }

    // ---------------------------------------------------------
    // FALLBACK: INDIVIDUAL EVENT LOOKUP
    // ---------------------------------------------------------

    let individualMarketRequests = 0;

    for (const event of uniqueEvents) {
      if (marketMap.has(event.eventId)) {
        continue;
      }

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
          marketMap.set(
            event.eventId,
            response.data
          );
        }
      } catch {
        // Do not invent missing market data.
      }
    }

    // ---------------------------------------------------------
    // FLATTEN SPORTYBET MARKETS
    // ---------------------------------------------------------

    function flattenMarkets(result) {
      const output = [];

      if (
        !result ||
        !Array.isArray(result.markets)
      ) {
        return output;
      }

      for (const market of result.markets) {
        if (
          !market ||
          !Array.isArray(market.outcomes)
        ) {
          continue;
        }

        const marketId = String(
          market.marketId || ""
        );

        if (!marketId) {
          continue;
        }

        const specifier =
          market.specifier === null ||
          market.specifier === undefined
            ? ""
            : String(market.specifier);

        if (
          market.status !== null &&
          market.status !== undefined &&
          String(market.status) === "2"
        ) {
          continue;
        }

        for (const outcome of market.outcomes) {
          if (!outcome) {
            continue;
          }

          if (outcome.isActive === false) {
            continue;
          }

          const outcomeId = String(
            outcome.outcomeId || ""
          );

          if (!outcomeId) {
            continue;
          }

          const odds = Number(outcome.odds);

          if (
            !Number.isFinite(odds) ||
            odds <= 0
          ) {
            continue;
          }

          output.push({
            eventId:
              String(result.event?.eventId || ""),

            gameId:
              String(result.event?.gameId || ""),

            event:
              `${result.event?.homeTeamName || ""} vs ` +
              `${result.event?.awayTeamName || ""}`.trim(),

            homeTeamName:
              result.event?.homeTeamName || "",

            awayTeamName:
              result.event?.awayTeamName || "",

            startTime:
              result.event?.startTime || null,

            marketId,
            market:
              market.market || "",

            specifier,

            outcomeId,

            pick:
              outcome.pick || "",

            odds
          });
        }
      }

      return output;
    }

    const optionsByEvent = new Map();

    for (const event of uniqueEvents) {
      const result =
        marketMap.get(event.eventId);

      const options =
        flattenMarkets(result);

      if (options.length) {
        optionsByEvent.set(
          event.eventId,
          options
        );
      }
    }

    // ---------------------------------------------------------
    // VERIFY ORIGINAL SELECTIONS
    // ---------------------------------------------------------

    function sameSelection(a, b) {
      return (
        String(a.eventId) ===
          String(b.eventId) &&

        String(a.marketId) ===
          String(b.marketId) &&

        String(a.specifier || "") ===
          String(b.specifier || "") &&

        String(a.outcomeId) ===
          String(b.outcomeId)
      );
    }

    const verifiedOriginals =
      originals.filter((original) => {
        const options =
          optionsByEvent.get(
            original.eventId
          ) || [];

        return options.some(
          (option) =>
            sameSelection(
              original,
              option
            )
        );
      });

    const uniqueVerified = [];

    for (const selection of verifiedOriginals) {
      if (
        !uniqueVerified.some(
          (existing) =>
            existing.eventId ===
            selection.eventId
        )
      ) {
        uniqueVerified.push(selection);
      }
    }

    // ---------------------------------------------------------
    // SAFE / BALANCED / RISKY
    // ---------------------------------------------------------

    const sortedByOdds =
      [...uniqueVerified].sort(
        (a, b) =>
          Number(a.odds || 999) -
          Number(b.odds || 999)
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
      [...uniqueVerified];

    // ---------------------------------------------------------
    // BUILD AI CANDIDATES
    // ---------------------------------------------------------

    const aiCandidates = [];

    for (const event of uniqueEvents) {
      const options =
        optionsByEvent.get(
          event.eventId
        ) || [];

      if (!options.length) {
        continue;
      }

      const preferredMarkets =
        new Set([
          "1X2",
          "1X2 - 2UP",
          "Over/Under",
          "Double Chance",
          "GG/NG",
          "Draw No Bet",
          "Asian Handicap",
          "Over/Under & GG/NG"
        ]);

      let candidates =
        options.filter(
          (option) =>
            preferredMarkets.has(
              option.market
            )
        );

      if (!candidates.length) {
        candidates = options;
      }

      candidates =
        candidates
          .filter(
            (option) =>
              option.odds >= 1.01 &&
              option.odds <= 8
          )
          .sort(
            (a, b) =>
              a.odds - b.odds
          )
          .slice(0, 50);

      aiCandidates.push({
        eventId: event.eventId,
        event: event.event,

        original:
          originals.find(
            (o) =>
              o.eventId ===
              event.eventId
          ) || null,

        options: candidates
      });
    }

    // ---------------------------------------------------------
    // GEMINI
    // ---------------------------------------------------------

    let aiReturned = [];

    let geminiStatus =
      GEMINI_KEY
        ? "API key detected"
        : "GEMINI_API_KEY / GOOGLE_API_KEY missing";

    let geminiError = null;

    let geminiRawResponse = null;

    if (
      GEMINI_KEY &&
      aiCandidates.length
    ) {
      const prompt = `
You are analyzing a football betting selection list.

There are exactly ${aiCandidates.length} football games.

IMPORTANT:

Return EXACTLY ONE recommendation for EVERY game.

Each recommendation MUST belong to a different event.

Never combine games.

Never omit a game.

Never invent a market.

Never invent an outcome.

Only choose from the SportyBet options supplied below.

The exact combination of:

eventId
marketId
specifier
outcomeId

must exist in the supplied data.

You MAY change the user's original selection to another available SportyBet market.

Prefer simple mainstream markets.

Avoid Correct Score unless there is no reasonable alternative.

Avoid extremely high odds.

This is not a guarantee of winning.

Do not use certainty language.

REASON STYLE:

Write one short natural sentence.

Sound like a knowledgeable football fan explaining the choice.

Do NOT use robotic phrases such as:

"optimize stability"
"lower variance profile"
"selection profile"
"relative variance"
"this profile focuses on"
"this selection has a lower variance"

Return JSON only.

Required format:

{
  "recommendations": [
    {
      "eventId": "EXACT EVENT ID",
      "marketId": "EXACT MARKET ID",
      "specifier": "EXACT SPECIFIER",
      "outcomeId": "EXACT OUTCOME ID",
      "reason": "Short natural reason"
    }
  ]
}

SPORTYBET OPTIONS:

${JSON.stringify(aiCandidates)}
`;

      try {
        const geminiURL =
          "https://generativelanguage.googleapis.com/v1beta/models/" +
          "gemini-2.5-flash:generateContent?key=" +
          encodeURIComponent(
            GEMINI_KEY
          );

        const geminiResponse =
          await fetchJSON(
            geminiURL,
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

        geminiStatus =
          `HTTP ${geminiResponse.status}`;

        geminiRawResponse =
          geminiResponse.data;

        if (!geminiResponse.ok) {
          geminiError =
            geminiResponse.data?.error?.message ||
            geminiResponse.rawText ||
            "Gemini request failed.";
        } else {
          let text =
            geminiResponse
              .data
              ?.candidates?.[0]
              ?.content
              ?.parts?.[0]
              ?.text ||
            "";

          if (!text) {
            geminiError =
              "Gemini returned an empty response.";
          } else {
            // Remove accidental markdown fences.
            text = text
              .replace(/^```json\s*/i, "")
              .replace(/^```\s*/i, "")
              .replace(/\s*```$/i, "")
              .trim();

            try {
              const parsed =
                JSON.parse(text);

              if (
                Array.isArray(
                  parsed?.recommendations
                )
              ) {
                aiReturned =
                  parsed.recommendations;

                geminiStatus =
                  `HTTP ${geminiResponse.status} - JSON parsed successfully`;
              } else {
                geminiError =
                  "Gemini responded, but no recommendations array was returned.";
              }
            } catch (parseError) {
              geminiError =
                "Gemini returned invalid JSON.";

              geminiRawResponse = {
                response:
                  geminiResponse.data,
                parseError:
                  String(
                    parseError?.message ||
                    parseError
                  )
              };
            }
          }
        }
      } catch (error) {
        geminiStatus =
          "Gemini request exception";

        geminiError =
          String(
            error?.message ||
            error
          );
      }
    } else if (!GEMINI_KEY) {
      geminiError =
        "No Gemini API key was found in Vercel environment variables.";
    }

    // ---------------------------------------------------------
    // VALIDATE GEMINI PICKS AGAINST SPORTYBET
    // ---------------------------------------------------------

    const aiValidated = [];

    for (const recommendation of aiReturned) {
      if (!recommendation) {
        continue;
      }

      const eventId =
        String(
          recommendation.eventId ||
          ""
        );

      const options =
        optionsByEvent.get(
          eventId
        ) || [];

      const exact =
        options.find(
          (option) =>
            String(option.marketId) ===
              String(
                recommendation.marketId ||
                ""
              ) &&

            String(
              option.specifier || ""
            ) ===
              String(
                recommendation.specifier ||
                ""
              ) &&

            String(option.outcomeId) ===
              String(
                recommendation.outcomeId ||
                ""
              )
        );

      if (!exact) {
        continue;
      }

      if (
        aiValidated.some(
          (existing) =>
            existing.eventId ===
            exact.eventId
        )
      ) {
        continue;
      }

      aiValidated.push({
        ...exact,

        reason:
          typeof recommendation.reason ===
            "string" &&
          recommendation.reason.trim()
            ? recommendation.reason.trim()
            : "This option is available on SportyBet for this game."
      });
    }

    // ---------------------------------------------------------
    // ENSURE ONE AI SELECTION PER GAME
    // ---------------------------------------------------------

    const aiFinalSelections = [];

    for (const event of uniqueEvents) {
      const options =
        optionsByEvent.get(
          event.eventId
        ) || [];

      if (!options.length) {
        continue;
      }

      const aiPick =
        aiValidated.find(
          (selection) =>
            selection.eventId ===
            event.eventId
        );

      if (aiPick) {
        aiFinalSelections.push(
          aiPick
        );

        continue;
      }

      // -------------------------------------------------------
      // SAFE REAL-DATA FALLBACK
      // -------------------------------------------------------

      const original =
        originals.find(
          (selection) =>
            selection.eventId ===
            event.eventId
        );

      const preferred =
        options
          .filter((option) =>
            [
              "Double Chance",
              "Over/Under",
              "GG/NG",
              "Draw No Bet",
              "1X2"
            ].includes(
              option.market
            )
          )
          .filter(
            (option) =>
              option.odds >= 1.05 &&
              option.odds <= 2.5
          )
          .sort(
            (a, b) =>
              a.odds - b.odds
          );

      let fallback =
        preferred[0];

      if (original) {
        const different =
          preferred.find(
            (option) =>
              !sameSelection(
                option,
                original
              )
          );

        if (different) {
          fallback =
            different;
        }
      }

      if (!fallback) {
        fallback =
          [...options]
            .filter(
              (option) =>
                option.odds >= 1.01
            )
            .sort(
              (a, b) =>
                a.odds - b.odds
            )[0];
      }

      if (!fallback) {
        continue;
      }

      aiFinalSelections.push({
        ...fallback,

        reason:
          original &&
          sameSelection(
            fallback,
            original
          )
            ? "This is the verified SportyBet option from your original selection."
            : "This alternative is available on SportyBet for this game."
      });
    }

    // ---------------------------------------------------------
    // PROFILES
    // ---------------------------------------------------------

    const profiles = {
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
          aiFinalSelections
      }
    };

    // ---------------------------------------------------------
    // DIAGNOSTICS
    // ---------------------------------------------------------

    const diagnostics = {
      receivedSelections:
        originals.length,

      requestedEvents:
        uniqueEvents.length,

      batchEventsReturned:
        batchResults.filter(
          (r) => r?.success
        ).length,

      individualMarketRequests,

      usableEvents:
        optionsByEvent.size,

      verifiedOriginals:
        verifiedOriginals.length,

      aiReturned:
        aiReturned.length,

      aiValidated:
        aiValidated.length,

      aiFinalSelections:
        aiFinalSelections.length,

      aiCoverageComplete:
        aiFinalSelections.length ===
        uniqueEvents.length,

      geminiStatus,

      geminiError,

      geminiApiKeyDetected:
        Boolean(GEMINI_KEY),

      requestedEventIds:
        uniqueEvents.map(
          (event) =>
            event.eventId
        ),

      finalAIEventIds:
        aiFinalSelections.map(
          (selection) =>
            selection.eventId
        ),

      missingMarketEventIds:
        uniqueEvents
          .filter(
            (event) =>
              !optionsByEvent.has(
                event.eventId
              )
          )
          .map(
            (event) =>
              event.eventId
          )
    };

    // Only expose a small diagnostic summary,
    // not the full Gemini response.
    if (geminiRawResponse) {
      diagnostics.geminiResponsePreview =
        JSON.stringify(
          geminiRawResponse
        ).slice(0, 1500);
    }

    return res.status(200).json({
      success: true,
      profiles,
      diagnostics
    });

  } catch (error) {
    console.error(
      "OPTIMIZE ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      error: "Optimizer failed.",
      details:
        String(
          error?.message ||
          error
        )
    });
  }
}
