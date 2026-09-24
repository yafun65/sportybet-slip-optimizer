export default async function handler(req, res) {
  // ------------------------------------------------------------
  // SPORTYBET SLIP OPTIMIZER
  // AI RECOMMENDED = ONE GAME AT A TIME
  // ------------------------------------------------------------

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not configured."
    });
  }

  const originalSelections = Array.isArray(req.body?.selections)
    ? req.body.selections
    : [];

  if (!originalSelections.length) {
    return res.status(400).json({
      error: "No selections were provided."
    });
  }

  // ------------------------------------------------------------
  // HELPERS
  // ------------------------------------------------------------

  function cleanString(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function normalize(value) {
    return cleanString(value)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function sameValue(a, b) {
    if (a === null || a === undefined) a = "";
    if (b === null || b === undefined) b = "";

    return normalize(a) === normalize(b);
  }

  function escapeForPrompt(value) {
    return cleanString(value).replace(/\r?\n/g, " ");
  }

  function extractJson(text) {
    if (!text) return null;

    let cleaned = String(text).trim();

    // Remove markdown code fences.
    cleaned = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    // First attempt: entire response is JSON.
    try {
      return JSON.parse(cleaned);
    } catch (_) {}

    // Second attempt: find first JSON object.
    const objectStart = cleaned.indexOf("{");
    const objectEnd = cleaned.lastIndexOf("}");

    if (objectStart !== -1 && objectEnd > objectStart) {
      const possibleObject = cleaned.slice(
        objectStart,
        objectEnd + 1
      );

      try {
        return JSON.parse(possibleObject);
      } catch (_) {}
    }

    // Third attempt: find JSON array.
    const arrayStart = cleaned.indexOf("[");
    const arrayEnd = cleaned.lastIndexOf("]");

    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      const possibleArray = cleaned.slice(
        arrayStart,
        arrayEnd + 1
      );

      try {
        return JSON.parse(possibleArray);
      } catch (_) {}
    }

    return null;
  }

  async function callGemini(prompt) {
  /*
    Gemini model fallback strategy.

    We retry temporary 503/429 errors before moving
    to another model. This is important because a 503
    usually means temporary service overload.
  */

  const models = [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite"
  ];

  const retryDelays = [
    1000,
    2500,
    5000
  ];

  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {

      // Wait before retrying.
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            retryDelays[attempt - 1]
          )
        );
      }

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
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
                responseMimeType: "application/json"
              }
            })
          }
        );

        const rawText = await response.text();

        // ----------------------------------------------------
        // SUCCESS
        // ----------------------------------------------------

        if (response.ok) {
          let data;

          try {
            data = JSON.parse(rawText);
          } catch (_) {
            lastError = new Error(
              `Gemini ${model} returned invalid API JSON.`
            );
            continue;
          }

          const text =
            data?.candidates?.[0]?.content?.parts
              ?.map((part) => part?.text || "")
              .join("") || "";

          if (!text) {
            lastError = new Error(
              `Gemini ${model} returned an empty response.`
            );
            continue;
          }

          const parsed = extractJson(text);

          if (!parsed) {
            lastError = new Error(
              `Gemini ${model} returned JSON that could not be parsed.`
            );
            continue;
          }

          return parsed;
        }

        // ----------------------------------------------------
        // TEMPORARY ERRORS
        // ----------------------------------------------------

        if (
          response.status === 503 ||
          response.status === 429 ||
          response.status === 500 ||
          response.status === 502 ||
          response.status === 504
        ) {
          lastError = new Error(
            `Gemini ${model} returned HTTP ${response.status}: ${rawText.slice(
              0,
              500
            )}`
          );

          console.warn(
            `Gemini ${model} temporary error ${response.status}. ` +
            `Retry ${attempt + 1}/${retryDelays.length}`
          );

          // Try this SAME model again.
          continue;
        }

        // ----------------------------------------------------
        // NON-RETRYABLE ERROR
        // ----------------------------------------------------

        lastError = new Error(
          `Gemini ${model} returned HTTP ${response.status}: ${rawText.slice(
            0,
            500
          )}`
        );

        // Don't waste time retrying a permanent error.
        break;

      } catch (error) {
        lastError = error;

        /*
          Network errors can also be temporary, so retry
          the same model.
        */

        console.warn(
          `Gemini ${model} request failed:`,
          error?.message || error
        );
      }
    }
  }

  throw lastError || new Error(
    "All Gemini models failed."
  );
  }
        const rawText = await response.text();

        if (!response.ok) {
          lastError = new Error(
            `Gemini ${model} returned ${response.status}: ${rawText.slice(
              0,
              500
            )}`
          );
          continue;
        }

        let data;

        try {
          data = JSON.parse(rawText);
        } catch (_) {
          lastError = new Error(
            `Gemini ${model} returned invalid JSON.`
          );
          continue;
        }

        const text =
          data?.candidates?.[0]?.content?.parts
            ?.map((part) => part?.text || "")
            .join("") || "";

        if (!text) {
          lastError = new Error(
            `Gemini ${model} returned an empty response.`
          );
          continue;
        }

        const parsed = extractJson(text);

        if (!parsed) {
          lastError = new Error(
            `Gemini ${model} returned JSON that could not be parsed.`
          );
          continue;
        }

        return parsed;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error("Gemini request failed.");
  }

  // ------------------------------------------------------------
  // FETCH VERIFIED SPORTYBET MARKETS
  // ------------------------------------------------------------

  async function fetchVerifiedMarkets(eventId) {
    const url =
      `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(
        eventId
      )}`;

    const response = await fetch(url);

    const rawText = await response.text();

    let data;

    try {
      data = JSON.parse(rawText);
    } catch (_) {
      throw new Error(
        `SportyBet market service returned invalid JSON for ${eventId}.`
      );
    }

    if (!response.ok) {
      throw new Error(
        data?.error ||
          `Unable to verify SportyBet markets for ${eventId}.`
      );
    }

    return data;
  }

  // ------------------------------------------------------------
  // NORMALIZE VERIFIED MARKET DATA
  // ------------------------------------------------------------

  function extractMarketSelections(eventData) {
    const result = [];

    if (!eventData) {
      return result;
    }

    /*
      The Render API may return one of several wrappers.

      We intentionally support:
      - data.markets
      - markets
      - event.markets
      - data.event.markets
    */

    const markets =
      eventData?.markets ||
      eventData?.data?.markets ||
      eventData?.event?.markets ||
      eventData?.data?.event?.markets ||
      [];

    if (!Array.isArray(markets)) {
      return result;
    }

    for (const market of markets) {
      if (!market) continue;

      const marketId = cleanString(
        market.marketId ??
          market.id ??
          market.market_id
      );

      const marketName = cleanString(
        market.market ??
          market.marketName ??
          market.name ??
          market.market_name
      );

      const specifier =
        market.specifier === undefined ||
        market.specifier === null
          ? ""
          : cleanString(market.specifier);

      const outcomes =
        market.outcomes ||
        market.outcome ||
        [];

      if (!Array.isArray(outcomes)) {
        continue;
      }

      for (const outcome of outcomes) {
        if (!outcome) continue;

        const outcomeId = cleanString(
          outcome.outcomeId ??
            outcome.id ??
            outcome.outcome_id
        );

        const pick = cleanString(
          outcome.pick ??
            outcome.name ??
            outcome.outcome ??
            outcome.label ??
            outcome.desc
        );

        const oddsValue =
          outcome.odds ??
          outcome.price ??
          outcome.decimalOdds;

        const odds =
          oddsValue === undefined ||
          oddsValue === null
            ? ""
            : String(oddsValue);

        if (!marketId || !outcomeId) {
          continue;
        }

        result.push({
          market: marketName,
          marketId,
          specifier,
          pick,
          odds,
          outcomeId
        });
      }
    }

    return result;
  }

  // ------------------------------------------------------------
  // FIND EXACT VERIFIED SELECTION
  // ------------------------------------------------------------

  function findVerifiedSelection(
    recommendation,
    verifiedEvent
  ) {
    if (!recommendation || !verifiedEvent) {
      return null;
    }

    const markets = verifiedEvent.marketSelections || [];

    const recommendationMarketId = cleanString(
      recommendation.marketId
    );

    const recommendationOutcomeId = cleanString(
      recommendation.outcomeId
    );

    const recommendationSpecifier =
      recommendation.specifier === null ||
      recommendation.specifier === undefined
        ? ""
        : cleanString(recommendation.specifier);

    // Primary validation:
    // marketId + outcomeId + specifier
    let match = markets.find((selection) => {
      return (
        sameValue(
          selection.marketId,
          recommendationMarketId
        ) &&
        sameValue(
          selection.outcomeId,
          recommendationOutcomeId
        ) &&
        sameValue(
          selection.specifier,
          recommendationSpecifier
        )
      );
    });

    // Secondary validation:
    // If specifier formatting differs slightly, still require
    // exact marketId + outcomeId.
    if (!match) {
      match = markets.find((selection) => {
        return (
          sameValue(
            selection.marketId,
            recommendationMarketId
          ) &&
          sameValue(
            selection.outcomeId,
            recommendationOutcomeId
          )
        );
      });
    }

    return match || null;
  }

  // ------------------------------------------------------------
  // VALIDATE ORIGINAL SELECTION AGAINST SPORTYBET
  // ------------------------------------------------------------

  function findOriginalInVerifiedMarkets(
    original,
    verifiedEvent
  ) {
    if (!original || !verifiedEvent) {
      return null;
    }

    const markets = verifiedEvent.marketSelections || [];

    return (
      markets.find((selection) => {
        return (
          sameValue(
            selection.marketId,
            original.marketId
          ) &&
          sameValue(
            selection.outcomeId,
            original.outcomeId
          ) &&
          sameValue(
            selection.specifier,
            original.specifier
          )
        );
      }) ||
      markets.find((selection) => {
        return (
          sameValue(
            selection.marketId,
            original.marketId
          ) &&
          sameValue(
            selection.outcomeId,
            original.outcomeId
          )
        );
      }) ||
      null
    );
  }

  // ------------------------------------------------------------
  // BUILD PROFILE DATA
  // ------------------------------------------------------------

  function buildOriginalSelection(original) {
    return {
      event: original.event,
      market: original.market,
      pick: original.pick,
      odds: original.odds,
      eventId: original.eventId,
      gameId: original.gameId,
      marketId: original.marketId,
      specifier:
        original.specifier === undefined ||
        original.specifier === null
          ? ""
          : original.specifier,
      outcomeId: original.outcomeId,
      startTime: original.startTime
    };
  }

  // ------------------------------------------------------------
  // SAFE / BALANCED / RISKY
  // ------------------------------------------------------------

  async function generateThreeProfiles(
    selections
  ) {
    const prompt = `
You are helping organize a SportyBet football betting ticket.

You have the user's ORIGINAL selections below.

Create exactly three profiles:

1. SAFE
2. BALANCED
3. RISKY

IMPORTANT RULES:

- SAFE, BALANCED and RISKY may ONLY use selections already present in the ORIGINAL selections.
- Do not invent new games.
- Do not invent new markets.
- Do not invent new outcomes.
- Do not change eventId.
- Do not create alternative markets.
- You may remove selections.
- You may reorder selections.
- SAFE should generally keep fewer and less aggressive original selections.
- BALANCED should keep a middle-ground number of original selections.
- RISKY should keep more of the original selections.
- These names describe the style of the ticket only. They are NOT guarantees.
- Every selection must come directly from the supplied original list.

STYLE:

Make all summaries and reasons sound natural and human, like a knowledgeable football fan explaining the ticket to another fan.

DO NOT use robotic or corporate phrases such as:
- "optimize stability"
- "lower variance profile"
- "selection profile"
- "relative variance"
- "this profile focuses on"
- "this selection has a lower variance"

Prefer short, conversational wording.

Examples:

SAFE:
"I've trimmed this down to the less aggressive picks."

BALANCED:
"A middle-ground mix — not too cautious, not too aggressive."

RISKY:
"This keeps more of the action, but there's less room for mistakes."

For reasons, use short natural explanations based ONLY on the supplied information.

Do not claim team form, injuries, probability, or match outcomes unless such information is supplied.

Return ONLY valid JSON in exactly this structure:

{
  "SAFE": {
    "summary": "",
    "selections": [
      {
        "event": "",
        "market": "",
        "pick": "",
        "odds": "",
        "eventId": "",
        "gameId": "",
        "marketId": "",
        "specifier": "",
        "outcomeId": "",
        "startTime": "",
        "reason": ""
      }
    ]
  },
  "BALANCED": {
    "summary": "",
    "selections": [
      {
        "event": "",
        "market": "",
        "pick": "",
        "odds": "",
        "eventId": "",
        "gameId": "",
        "marketId": "",
        "specifier": "",
        "outcomeId": "",
        "startTime": "",
        "reason": ""
      }
    ]
  },
  "RISKY": {
    "summary": "",
    "selections": [
      {
        "event": "",
        "market": "",
        "pick": "",
        "odds": "",
        "eventId": "",
        "gameId": "",
        "marketId": "",
        "specifier": "",
        "outcomeId": "",
        "startTime": "",
        "reason": ""
      }
    ]
  }
}

ORIGINAL SELECTIONS:

${JSON.stringify(selections, null, 2)}
`;

    const result = await callGemini(prompt);

    if (!result || typeof result !== "object") {
      throw new Error(
        "Gemini returned an invalid profile response."
      );
    }

    return result;
  }

  // ------------------------------------------------------------
  // ONE-GAME-AT-A-TIME AI RECOMMENDATION
  // ------------------------------------------------------------

  async function generateOneAIRecommendation(
    verifiedEvent,
    originalSelection
  ) {
    const markets = verifiedEvent.marketSelections || [];

    if (!markets.length) {
      throw new Error(
        `No verified SportyBet markets were available for ${verifiedEvent.event}.`
      );
    }

    /*
      CRITICAL:

      This function receives EXACTLY ONE GAME.

      Gemini is never asked to generate recommendations
      for multiple games at once.

      One call = one game = one recommendation.
    */

    const prompt = `
You are selecting ONE SportyBet recommendation for ONE football game.

THIS IS ONE GAME ONLY.

You MUST return exactly ONE selection.

Do NOT return:
- an array
- multiple selections
- recommendations for other games
- a general ticket
- multiple alternatives

Your job is to choose ONE market/outcome for this exact game.

GAME:

${escapeForPrompt(verifiedEvent.event)}

EVENT ID:

${escapeForPrompt(verifiedEvent.eventId)}

USER'S ORIGINAL SELECTION FOR THIS GAME:

${JSON.stringify(originalSelection, null, 2)}

VERIFIED SPORTYBET MARKETS FOR THIS GAME:

${JSON.stringify(markets, null, 2)}

RULES:

1. Return exactly ONE recommendation.
2. The recommendation MUST belong to this exact event.
3. You may keep the original selection.
4. You may choose a different market if it appears in the VERIFIED SPORTYBET MARKETS.
5. You MUST NOT invent a market.
6. You MUST NOT invent an outcome.
7. You MUST NOT invent marketId.
8. You MUST NOT invent outcomeId.
9. You MUST NOT invent a specifier.
10. Copy marketId, outcomeId, specifier, market name, pick and odds from the verified data.
11. The recommendation must be independently verifiable from the supplied market list.
12. Give one short natural reason.
13. Do not claim certainty.
14. Do not claim a team will win.
15. Do not invent form, injuries, statistics or probabilities.

STYLE:

Sound like a knowledgeable football fan explaining the choice to another fan.

Avoid robotic phrases such as:
- "optimize stability"
- "lower variance profile"
- "selection profile"
- "relative variance"
- "this profile focuses on"

Keep the reason to ONE short sentence.

Return ONLY this JSON object:

{
  "event": "",
  "market": "",
  "pick": "",
  "odds": "",
  "eventId": "",
  "marketId": "",
  "specifier": "",
  "outcomeId": "",
  "reason": ""
}
`;

    let lastError = null;

    // Try twice for this individual game.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const recommendation = await callGemini(prompt);

        if (
          !recommendation ||
          Array.isArray(recommendation) ||
          typeof recommendation !== "object"
        ) {
          throw new Error(
            "AI did not return exactly one recommendation."
          );
        }

        const verified =
          findVerifiedSelection(
            recommendation,
            verifiedEvent
          );

        if (!verified) {
          throw new Error(
            `AI recommendation for "${verifiedEvent.event}" could not be matched to a verified SportyBet market.`
          );
        }

        /*
          The recommendation has now been proven to exist
          in SportyBet's verified market list.

          We deliberately overwrite the market/pick/odds/IDs
          with the verified values instead of trusting Gemini.
        */

        return {
          event: verifiedEvent.event,
          market: verified.market,
          pick: verified.pick,
          odds: verified.odds,
          eventId: verifiedEvent.eventId,
          gameId:
            verifiedEvent.gameId ||
            originalSelection?.gameId ||
            "",
          marketId: verified.marketId,
          specifier: verified.specifier,
          outcomeId: verified.outcomeId,
          startTime:
            verifiedEvent.startTime ||
            originalSelection?.startTime ||
            "",
          reason:
            cleanString(recommendation.reason) ||
            "This option is available and verified on SportyBet."
        };
      } catch (error) {
        lastError = error;

        // Small retry delay.
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 350)
          );
        }
      }
    }

    throw lastError || new Error(
      `Unable to generate a verified recommendation for ${verifiedEvent.event}.`
    );
  }

  // ------------------------------------------------------------
  // MAIN PROCESS
  // ------------------------------------------------------------

  try {
    // ----------------------------------------------------------
    // STEP 1:
    // Clean and validate original selections.
    // ----------------------------------------------------------

    const cleanedSelections = originalSelections
      .filter((selection) => selection)
      .map((selection) => ({
        ...selection,
        event: cleanString(selection.event),
        eventId: cleanString(selection.eventId),
        gameId: cleanString(selection.gameId),
        market: cleanString(selection.market),
        pick: cleanString(selection.pick),
        odds: selection.odds,
        marketId: cleanString(selection.marketId),
        specifier:
          selection.specifier === null ||
          selection.specifier === undefined
            ? ""
            : cleanString(selection.specifier),
        outcomeId: cleanString(selection.outcomeId)
      }));

    if (!cleanedSelections.length) {
      return res.status(400).json({
        error: "No valid selections were found."
      });
    }

    // ----------------------------------------------------------
    // STEP 2:
    // Create one unique event for every game.
    // ----------------------------------------------------------

    const eventMap = new Map();

    for (const selection of cleanedSelections) {
      if (!selection.eventId) {
        continue;
      }

      if (!eventMap.has(selection.eventId)) {
        eventMap.set(selection.eventId, {
          eventId: selection.eventId,
          event: selection.event,
          gameId: selection.gameId,
          startTime: selection.startTime,
          originalSelection: selection,
          marketSelections: []
        });
      }
    }

    const events = Array.from(eventMap.values());

    if (!events.length) {
      return res.status(400).json({
        error:
          "The booking does not contain usable SportyBet event IDs."
      });
    }

    // ----------------------------------------------------------
    // STEP 3:
    // Verify every game's actual SportyBet markets.
    // ----------------------------------------------------------

    const verifiedEvents = [];
    const verificationErrors = [];

    /*
      Sequential processing is intentional.

      This makes it clear that every event is handled
      independently and avoids one failed request taking
      down the entire process.
    */

    for (const event of events) {
      try {
        const marketData =
          await fetchVerifiedMarkets(event.eventId);

        const marketSelections =
          extractMarketSelections(marketData);

        if (!marketSelections.length) {
          throw new Error(
            "SportyBet returned no usable markets."
          );
        }

        verifiedEvents.push({
          ...event,
          marketSelections
        });
      } catch (error) {
        verificationErrors.push({
          eventId: event.eventId,
          event: event.event,
          error:
            error?.message ||
            "Unable to verify this game's markets."
        });
      }
    }

    /*
      Never fabricate a recommendation for an unverified game.
    */

    if (!verifiedEvents.length) {
      return res.status(502).json({
        error:
          "SportyBet markets could not be verified for any of the games.",
        details: verificationErrors
      });
    }

    // ----------------------------------------------------------
    // STEP 4:
    // Generate SAFE / BALANCED / RISKY.
    // ----------------------------------------------------------

    let threeProfiles;

    try {
      threeProfiles =
        await generateThreeProfiles(
          cleanedSelections
        );
    } catch (error) {
      console.error(
        "Three-profile generation failed:",
        error
      );

      // Deterministic fallback using original selections.
      threeProfiles = {
        SAFE: {
          summary:
            "I've trimmed this down to a smaller set of the original picks.",
          selections: cleanedSelections.slice(
            0,
            Math.max(1, Math.ceil(cleanedSelections.length / 2))
          )
        },

        BALANCED: {
          summary:
            "A middle-ground mix using the original selections.",
          selections: [...cleanedSelections]
        },

        RISKY: {
          summary:
            "This keeps more of the original action on the ticket.",
          selections: [...cleanedSelections]
        }
      };
    }

    // ----------------------------------------------------------
    // STEP 5:
    // Force SAFE/BALANCED/RISKY to use ORIGINAL selections only.
    // ----------------------------------------------------------

    function validateOriginalProfile(profile) {
      const input =
        Array.isArray(profile?.selections)
          ? profile.selections
          : [];

      const valid = [];

      for (const recommendation of input) {
        const original = cleanedSelections.find(
          (selection) =>
            sameValue(
              selection.eventId,
              recommendation.eventId
            ) &&
            sameValue(
              selection.marketId,
              recommendation.marketId
            ) &&
            sameValue(
              selection.outcomeId,
              recommendation.outcomeId
            ) &&
            sameValue(
              selection.specifier,
              recommendation.specifier
            )
        );

        if (original) {
          valid.push({
            ...buildOriginalSelection(original),
            reason:
              cleanString(
                recommendation.reason
              ) ||
              "This keeps the original selection."
          });
        }
      }

      return valid;
    }

    const safeSelections =
      validateOriginalProfile(
        threeProfiles.SAFE
      );

    const balancedSelections =
      validateOriginalProfile(
        threeProfiles.BALANCED
      );

    const riskySelections =
      validateOriginalProfile(
        threeProfiles.RISKY
      );

    // ----------------------------------------------------------
    // STEP 6:
    // AI RECOMMENDED — ONE GAME AT A TIME.
    // ----------------------------------------------------------

    const aiRecommendedSelections = [];
    const aiRecommendationErrors = [];

    /*
      THIS IS THE KEY PART.

      We loop through EVERY VERIFIED GAME.

      For each game:
        Game 1 -> Gemini -> validate -> save
        Game 2 -> Gemini -> validate -> save
        Game 3 -> Gemini -> validate -> save
        Game 4 -> Gemini -> validate -> save

      Gemini never receives all four games together.
    */

    for (const verifiedEvent of verifiedEvents) {
      try {
        const recommendation =
          await generateOneAIRecommendation(
            verifiedEvent,
            verifiedEvent.originalSelection
          );

        /*
          Final defensive check:
          make absolutely sure this recommendation belongs
          to this exact event.
        */

        if (
          !sameValue(
            recommendation.eventId,
            verifiedEvent.eventId
          )
        ) {
          throw new Error(
            `AI returned the wrong event for ${verifiedEvent.event}.`
          );
        }

        aiRecommendedSelections.push(
          recommendation
        );
      } catch (error) {
        console.error(
          `AI recommendation failed for ${verifiedEvent.event}:`,
          error
        );

        aiRecommendationErrors.push({
          eventId: verifiedEvent.eventId,
          event: verifiedEvent.event,
          error:
            error?.message ||
            "Unable to create a verified recommendation."
        });
      }
    }

    // ----------------------------------------------------------
    // STEP 7:
    // DO NOT silently pretend all games were recommended.
    // ----------------------------------------------------------

    const expectedAIRecommendations =
      verifiedEvents.length;

    const actualAIRecommendations =
      aiRecommendedSelections.length;

    /*
      If even one game failed, return a clear error rather
      than displaying a misleading AI Recommended ticket.
    */

    if (
      actualAIRecommendations !==
      expectedAIRecommendations
    ) {
      return res.status(502).json({
        error:
          `AI RECOMMENDED could only verify ${actualAIRecommendations} of ${expectedAIRecommendations} games.`,
        details: {
          verifiedGames: expectedAIRecommendations,
          aiRecommendations:
            actualAIRecommendations,
          verificationErrors,
          aiRecommendationErrors
        }
      });
    }

    // ----------------------------------------------------------
    // STEP 8:
    // Final one-per-event safety check.
    // ----------------------------------------------------------

    const uniqueRecommendedEvents =
      new Set(
        aiRecommendedSelections.map(
          (selection) => selection.eventId
        )
      );

    if (
      uniqueRecommendedEvents.size !==
      expectedAIRecommendations
    ) {
      return res.status(502).json({
        error:
          "AI RECOMMENDED failed the one-selection-per-game validation."
      });
    }

    // ----------------------------------------------------------
    // STEP 9:
    // Calculate combined odds.
    // ----------------------------------------------------------

    function calculateCombinedOdds(selections) {
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

    // ----------------------------------------------------------
    // STEP 10:
    // Natural summaries.
    // ----------------------------------------------------------

    const safeSummary =
      cleanString(
        threeProfiles?.SAFE?.summary
      ) ||
      "I've trimmed this down to a smaller set of the original picks.";

    const balancedSummary =
      cleanString(
        threeProfiles?.BALANCED?.summary
      ) ||
      "A middle-ground mix using the original selections.";

    const riskySummary =
      cleanString(
        threeProfiles?.RISKY?.summary
      ) ||
      "This keeps more of the original action on the ticket.";

    const aiSummary =
      `I checked the available SportyBet markets and picked one option for each of the ${aiRecommendedSelections.length} verified games.`;

    // ----------------------------------------------------------
    // STEP 11:
    // Return final result.
    // ----------------------------------------------------------

    return res.status(200).json({
      success: true,

      totalGames: events.length,

      verifiedGames: verifiedEvents.length,

      profiles: {
        SAFE: {
          summary: safeSummary,
          selections: safeSelections,
          count: safeSelections.length,
          combinedOdds:
            calculateCombinedOdds(
              safeSelections
            )
        },

        BALANCED: {
          summary: balancedSummary,
          selections: balancedSelections,
          count: balancedSelections.length,
          combinedOdds:
            calculateCombinedOdds(
              balancedSelections
            )
        },

        RISKY: {
          summary: riskySummary,
          selections: riskySelections,
          count: riskySelections.length,
          combinedOdds:
            calculateCombinedOdds(
              riskySelections
            )
        },

        "AI RECOMMENDED": {
          summary: aiSummary,

          /*
            This array is guaranteed by the checks above
            to contain EXACTLY ONE recommendation for every
            verified game.
          */
          selections: aiRecommendedSelections,

          count:
            aiRecommendedSelections.length,

          combinedOdds:
            calculateCombinedOdds(
              aiRecommendedSelections
            ),

          verified: true,

          verifiedGames:
            aiRecommendedSelections.length,

          expectedGames:
            expectedAIRecommendations
        }
      },

      verification: {
        requestedGames: events.length,
        verifiedGames: verifiedEvents.length,
        verificationErrors
      }
    });
  } catch (error) {
    console.error(
      "Optimize endpoint error:",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "Unable to optimize the selections."
    });
  }
}
