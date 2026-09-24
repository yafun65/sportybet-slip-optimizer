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

    // =========================================================
    // NORMALIZE ORIGINAL SELECTIONS
    // =========================================================

    const originals = selections
      .map((s) => ({
        event:
          s.event ||
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
      .filter(
        (s) =>
          s.eventId &&
          s.gameId
      );

    if (!originals.length) {
      return res.status(400).json({
        success: false,
        error:
          "The selections do not contain valid SportyBet event IDs."
      });
    }

    // =========================================================
    // UNIQUE EVENTS
    // =========================================================

    const uniqueEvents = [];

    for (const selection of originals) {
      if (
        !uniqueEvents.some(
          (event) =>
            event.eventId ===
            selection.eventId
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

    // =========================================================
    // GENERIC FETCH HELPER
    // =========================================================

    async function fetchJSON(
      url,
      options = {},
      timeoutMs = 20000
    ) {
      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () => controller.abort(),
          timeoutMs
        );

      try {
        const response =
          await fetch(
            url,
            {
              ...options,
              signal:
                controller.signal
            }
          );

        const rawText =
          await response.text();

        let data = null;

        try {
          data =
            JSON.parse(
              rawText
            );
        } catch {
          data = null;
        }

        return {
          ok: response.ok,
          status: response.status,
          data,
          rawText
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    // =========================================================
    // LOAD SPORTYBET MARKETS
    // =========================================================

    const eventIds =
      uniqueEvents.map(
        (event) =>
          event.eventId
      );

    let batchData = null;

    try {
      const batchURL =
        `${RENDER_BASE}/event-markets?eventIds=` +
        encodeURIComponent(
          eventIds.join(",")
        );

      const batchResponse =
        await fetchJSON(
          batchURL
        );

      if (
        batchResponse.ok &&
        batchResponse.data
      ) {
        batchData =
          batchResponse.data;
      }
    } catch {
      batchData = null;
    }

    const marketMap =
      new Map();

    let batchResults = [];

    if (
      Array.isArray(
        batchData
      )
    ) {
      batchResults =
        batchData;
    } else if (
      Array.isArray(
        batchData?.results
      )
    ) {
      batchResults =
        batchData.results;
    }

    for (
      const result of batchResults
    ) {
      if (
        result &&
        result.success &&
        result.event?.eventId &&
        Array.isArray(
          result.markets
        )
      ) {
        marketMap.set(
          String(
            result.event.eventId
          ),
          result
        );
      }
    }

    // =========================================================
    // INDIVIDUAL FALLBACK LOOKUP
    // =========================================================

    let individualMarketRequests = 0;

    for (
      const event of uniqueEvents
    ) {
      if (
        marketMap.has(
          event.eventId
        )
      ) {
        continue;
      }

      try {
        individualMarketRequests++;

        const url =
          `${RENDER_BASE}/event-markets/` +
          encodeURIComponent(
            event.eventId
          );

        const response =
          await fetchJSON(
            url
          );

        if (
          response.ok &&
          response.data?.success &&
          Array.isArray(
            response.data?.markets
          )
        ) {
          marketMap.set(
            event.eventId,
            response.data
          );
        }
      } catch {
        // Never invent market data.
      }
    }

    // =========================================================
    // FLATTEN SPORTYBET MARKETS
    // =========================================================

    function flattenMarkets(
      result
    ) {
      const output = [];

      if (
        !result ||
        !Array.isArray(
          result.markets
        )
      ) {
        return output;
      }

      for (
        const market of result.markets
      ) {
        if (
          !market ||
          !Array.isArray(
            market.outcomes
          )
        ) {
          continue;
        }

        const marketId =
          String(
            market.marketId ||
            ""
          );

        if (!marketId) {
          continue;
        }

        const specifier =
          market.specifier === null ||
          market.specifier === undefined
            ? ""
            : String(
                market.specifier
              );

        if (
          market.status !== null &&
          market.status !== undefined &&
          String(
            market.status
          ) === "2"
        ) {
          continue;
        }

        for (
          const outcome of
          market.outcomes
        ) {
          if (!outcome) {
            continue;
          }

          if (
            outcome.isActive ===
            false
          ) {
            continue;
          }

          const outcomeId =
            String(
              outcome.outcomeId ||
              ""
            );

          if (!outcomeId) {
            continue;
          }

          const odds =
            Number(
              outcome.odds
            );

          if (
            !Number.isFinite(
              odds
            ) ||
            odds <= 0
          ) {
            continue;
          }

          output.push({
            eventId:
              String(
                result.event?.eventId ||
                ""
              ),

            gameId:
              String(
                result.event?.gameId ||
                ""
              ),

            event:
              `${result.event?.homeTeamName || ""} vs ` +
              `${result.event?.awayTeamName || ""}`.trim(),

            homeTeamName:
              result.event?.homeTeamName ||
              "",

            awayTeamName:
              result.event?.awayTeamName ||
              "",

            startTime:
              result.event?.startTime ||
              null,

            marketId,

            market:
              market.market ||
              "",

            specifier,

            outcomeId,

            pick:
              outcome.pick ||
              "",

            odds
          });
        }
      }

      return output;
    }

    const optionsByEvent =
      new Map();

    for (
      const event of uniqueEvents
    ) {
      const result =
        marketMap.get(
          event.eventId
        );

      const options =
        flattenMarkets(
          result
        );

      if (
        options.length
      ) {
        optionsByEvent.set(
          event.eventId,
          options
        );
      }
    }

    // =========================================================
    // SELECTION COMPARISON
    // =========================================================

    function sameSelection(
      a,
      b
    ) {
      return (
        String(a.eventId) ===
          String(b.eventId) &&

        String(a.marketId) ===
          String(b.marketId) &&

        String(
          a.specifier || ""
        ) ===
          String(
            b.specifier || ""
          ) &&

        String(a.outcomeId) ===
          String(b.outcomeId)
      );
    }

    // =========================================================
    // VERIFY ORIGINAL PICKS
    // =========================================================

    const verifiedOriginals =
      originals.filter(
        (original) => {
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
        }
      );

    const uniqueVerified = [];

    for (
      const selection of
      verifiedOriginals
    ) {
      if (
        !uniqueVerified.some(
          (existing) =>
            existing.eventId ===
            selection.eventId
        )
      ) {
        uniqueVerified.push(
          selection
        );
      }
    }

    // =========================================================
    // SAFE / BALANCED / RISKY
    // =========================================================

    const sortedByOdds =
      [...uniqueVerified].sort(
        (a, b) =>
          Number(a.odds || 999) -
          Number(b.odds || 999)
      );

    const safeCount =
      Math.max(
        1,
        Math.ceil(
          sortedByOdds.length *
          0.5
        )
      );

    const balancedCount =
      Math.max(
        1,
        Math.ceil(
          sortedByOdds.length *
          0.75
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

    // =========================================================
    // PREPARE AI CANDIDATES
    // =========================================================

    const aiCandidates = [];

    for (
      const event of uniqueEvents
    ) {
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
        candidates =
          options;
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
          .slice(
            0,
            50
          );

      aiCandidates.push({
        eventId:
          event.eventId,

        event:
          event.event,

        original:
          originals.find(
            (o) =>
              o.eventId ===
              event.eventId
          ) || null,

        options:
          candidates
      });
    }

    // =========================================================
    // GEMINI MODEL FALLBACK SYSTEM
    // =========================================================
    //
    // Try models in order.
    //
    // 1. Gemini 3.8 Flash
    // 2. Gemini 3.7 Flash
    // 3. Gemini 3.6 Flash
    // 4. Gemini 3.5 Flash
    // 5. Gemini 3.5 Flash-Lite
    //
    // We do NOT assume every model is available to every key.
    // A 404/403/429/500/503 can cause the next model to try.
    //
    // The successful model is recorded in diagnostics.
    // =========================================================

    const GEMINI_MODELS = [
      "gemini-3.8-flash",
      "gemini-3.7-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite"
    ];

    let aiReturned = [];

    let geminiModelUsed = null;

    let geminiStatus =
      GEMINI_KEY
        ? "API key detected"
        : "Gemini API key missing";

    let geminiError = null;

    const geminiAttempts = [];

    let geminiRawResponse = null;

    // =========================================================
    // AI PROMPT
    // =========================================================

    const prompt = `
You are analyzing a football betting selection list.

There are exactly ${aiCandidates.length} football games.

IMPORTANT:

You MUST return exactly ONE recommendation for EVERY game.

If there are 8 games, return 8 recommendations.

Every recommendation must belong to a different event.

Never combine games.

Never omit a game.

Never invent a market.

Never invent an outcome.

Only select from the exact SportyBet options supplied below.

The exact combination of:

eventId
marketId
specifier
outcomeId

must exist in the supplied SportyBet data.

You MAY replace the user's original selection with another market if that market exists in the supplied SportyBet options.

Prefer understandable mainstream markets.

Avoid Correct Score unless there is no reasonable alternative.

Avoid extremely high odds.

Do not say a selection is guaranteed.

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

    // =========================================================
    // TRY EACH MODEL
    // =========================================================

    if (
      GEMINI_KEY &&
      aiCandidates.length
    ) {
      for (
        const model of
        GEMINI_MODELS
      ) {
        try {
          const geminiURL =
            "https://generativelanguage.googleapis.com/v1beta/models/" +
            `${model}:generateContent`;

          const response =
            await fetchJSON(
              geminiURL,
              {
                method:
                  "POST",

                headers: {
                  "Content-Type":
                    "application/json",

                  "x-goog-api-key":
                    GEMINI_KEY
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
                      responseMimeType:
                        "application/json",

                      maxOutputTokens:
                        4000
                    }
                  })
              },
              30000
            );

          const attempt = {
            model,
            status:
              response.status,
            success:
              response.ok,
            error:
              response.ok
                ? null
                : (
                    response.data
                      ?.error
                      ?.message ||
                    response.rawText ||
                    "Request failed."
                  )
          };

          geminiAttempts.push(
            attempt
          );

          // ---------------------------------------------------
          // MODEL REQUEST FAILED
          // ---------------------------------------------------

          if (!response.ok) {
            continue;
          }

          geminiRawResponse =
            response.data;

          let text =
            response.data
              ?.candidates?.[0]
              ?.content?.parts?.[0]
              ?.text ||
            "";

          if (!text) {
            continue;
          }

          // Remove Markdown JSON fences.
          text =
            text
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

          let parsed = null;

          try {
            parsed =
              JSON.parse(
                text
              );
          } catch {
            geminiAttempts[
              geminiAttempts.length - 1
            ].error =
              "Model returned invalid JSON.";

            continue;
          }

          if (
            !Array.isArray(
              parsed?.recommendations
            )
          ) {
            geminiAttempts[
              geminiAttempts.length - 1
            ].error =
              "Model returned no recommendations array.";

            continue;
          }

          // ---------------------------------------------------
          // WE HAVE A VALID MODEL RESPONSE
          // ---------------------------------------------------

          aiReturned =
            parsed.recommendations;

          geminiModelUsed =
            model;

          geminiStatus =
            `HTTP ${response.status} - ${model} succeeded`;

          geminiError =
            null;

          break;

        } catch (
          error
        ) {
          geminiAttempts.push({
            model,
            status:
              "exception",
            success:
              false,
            error:
              String(
                error?.message ||
                error
              )
          });
        }
      }
    } else if (
      !GEMINI_KEY
    ) {
      geminiError =
        "No Gemini API key was found in Vercel environment variables.";
    }

    // =========================================================
    // IF NO MODEL SUCCEEDED
    // =========================================================

    if (
      !geminiModelUsed &&
      GEMINI_KEY
    ) {
      const failedModels =
        geminiAttempts
          .map(
            (attempt) =>
              `${attempt.model}: ${attempt.status}`
          )
          .join("; ");

      geminiStatus =
        "All Gemini models failed";

      geminiError =
        failedModels ||
        "No Gemini model returned a usable response.";
    }

    // =========================================================
    // VALIDATE GEMINI PICKS AGAINST SPORTYBET
    // =========================================================

    const aiValidated = [];

    for (
      const recommendation of
      aiReturned
    ) {
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
            String(
              option.marketId
            ) ===
              String(
                recommendation.marketId ||
                ""
              ) &&

            String(
              option.specifier ||
              ""
            ) ===
              String(
                recommendation.specifier ||
                ""
              ) &&

            String(
              option.outcomeId
            ) ===
              String(
                recommendation.outcomeId ||
                ""
              )
        );

      // Reject anything not found exactly
      // in SportyBet's actual market data.
      if (!exact) {
        continue;
      }

      // Only one recommendation per game.
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

    // =========================================================
    // ONE FINAL SELECTION PER GAME
    // =========================================================

    const aiFinalSelections = [];

    for (
      const event of uniqueEvents
    ) {
      const options =
        optionsByEvent.get(
          event.eventId
        ) || [];

      if (!options.length) {
        continue;
      }

      // Use validated AI recommendation first.
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

      // =======================================================
      // REAL SPORTYBET FALLBACK
      // =======================================================

      const original =
        originals.find(
          (selection) =>
            selection.eventId ===
            event.eventId
        );

      const preferred =
        options
          .filter(
            (option) =>
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
              option.odds >=
                1.05 &&
              option.odds <=
                2.5
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
                option.odds >=
                1.01
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

    // =========================================================
    // PROFILES
    // =========================================================

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

    // =========================================================
    // DIAGNOSTICS
    // =========================================================

    const diagnostics = {
      receivedSelections:
        originals.length,

      requestedEvents:
        uniqueEvents.length,

      batchEventsReturned:
        batchResults.filter(
          (r) =>
            r?.success
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

      // Gemini information
      geminiApiKeyDetected:
        Boolean(
          GEMINI_KEY
        ),

      geminiModelUsed,

      geminiStatus,

      geminiError,

      geminiModelsTried:
        geminiAttempts.map(
          (attempt) => ({
            model:
              attempt.model,

            status:
              attempt.status,

            success:
              attempt.success,

            error:
              attempt.error
          })
        ),

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

    // Short Gemini response preview
    if (
      geminiRawResponse
    ) {
      diagnostics.geminiResponsePreview =
        JSON.stringify(
          geminiRawResponse
        ).slice(
          0,
          1500
        );
    }

    // =========================================================
    // RESPONSE
    // =========================================================

    return res.status(
      200
    ).json({
      success: true,
      profiles,
      diagnostics
    });

  } catch (
    error
  ) {
    console.error(
      "OPTIMIZE ERROR:",
      error
    );

    return res.status(
      500
    ).json({
      success: false,

      error:
        "Optimizer failed.",

      details:
        String(
          error?.message ||
          error
        )
    });
  }
}
