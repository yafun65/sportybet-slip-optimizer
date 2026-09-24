export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: "GEMINI_API_KEY is not configured."
    });
  }

  const originalSelections = Array.isArray(req.body?.selections)
    ? req.body.selections
    : [];

  if (!originalSelections.length) {
    return res.status(400).json({
      success: false,
      error: "No selections were provided."
    });
  }

  // ============================================================
  // HELPERS
  // ============================================================

  function clean(value) {
    if (value === null || value === undefined) {
      return "";
    }

    return String(value).trim();
  }

  function normalize(value) {
    return clean(value)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function same(a, b) {
    return normalize(a) === normalize(b);
  }

  function extractJson(text) {
    if (!text) {
      return null;
    }

    let value = String(text).trim();

    value = value
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    try {
      return JSON.parse(value);
    } catch (_) {}

    const objectStart = value.indexOf("{");
    const objectEnd = value.lastIndexOf("}");

    if (
      objectStart !== -1 &&
      objectEnd > objectStart
    ) {
      try {
        return JSON.parse(
          value.slice(objectStart, objectEnd + 1)
        );
      } catch (_) {}
    }

    return null;
  }

  // ============================================================
  // GEMINI
  // ============================================================

  async function callGemini(prompt) {
    const models = [
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite"
    ];

    let lastError = null;

    for (const model of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
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
                  temperature: 0.2,
                  responseMimeType: "application/json"
                }
              })
            }
          );

          const raw = await response.text();

          if (!response.ok) {
            lastError = new Error(
              `Gemini ${model} returned HTTP ${response.status}: ${raw.slice(
                0,
                500
              )}`
            );

            /*
              Temporary errors:
              retry the same model once.
            */

            if (
              response.status === 429 ||
              response.status === 500 ||
              response.status === 502 ||
              response.status === 503 ||
              response.status === 504
            ) {
              if (attempt === 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, 1200)
                );

                continue;
              }

              break;
            }

            /*
              Non-temporary error.
              Move to the next model.
            */

            break;
          }

          let data;

          try {
            data = JSON.parse(raw);
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
        } catch (error) {
          lastError = error;

          if (attempt === 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, 800)
            );
          }
        }
      }
    }

    throw lastError || new Error(
      "All Gemini models failed."
    );
  }

  // ============================================================
  // GET VERIFIED SPORTYBET MARKETS
  // ============================================================

  async function getMarkets(eventId) {
    const url =
      `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(
        eventId
      )}`;

    const response = await fetch(url);

    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch (_) {
      throw new Error(
        `SportyBet market API returned invalid JSON for ${eventId}.`
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

  // ============================================================
  // EXTRACT SPORTYBET MARKETS
  // ============================================================

  function extractMarkets(data) {
    const markets =
      data?.markets ||
      data?.data?.markets ||
      data?.event?.markets ||
      data?.data?.event?.markets ||
      [];

    if (!Array.isArray(markets)) {
      return [];
    }

    const output = [];

    for (const market of markets) {
      if (!market) {
        continue;
      }

      const marketId = clean(
        market.marketId ??
        market.id ??
        market.market_id
      );

      const marketName = clean(
        market.market ??
        market.marketName ??
        market.name ??
        market.market_name
      );

      const specifier = clean(
        market.specifier
      );

      const outcomes =
        market.outcomes ||
        market.outcome ||
        [];

      if (!Array.isArray(outcomes)) {
        continue;
      }

      for (const outcome of outcomes) {
        if (!outcome) {
          continue;
        }

        const outcomeId = clean(
          outcome.outcomeId ??
          outcome.id ??
          outcome.outcome_id
        );

        const pick = clean(
          outcome.pick ??
          outcome.name ??
          outcome.outcome ??
          outcome.label ??
          outcome.desc
        );

        const odds = clean(
          outcome.odds ??
          outcome.price ??
          outcome.decimalOdds
        );

        if (!marketId || !outcomeId) {
          continue;
        }

        output.push({
          market: marketName,
          marketId,
          specifier,
          pick,
          odds,
          outcomeId
        });
      }
    }

    return output;
  }

  // ============================================================
  // VERIFY AI RECOMMENDATION
  // ============================================================

  function findVerifiedRecommendation(
    recommendation,
    markets
  ) {
    if (!recommendation) {
      return null;
    }

    const marketId = clean(
      recommendation.marketId
    );

    const outcomeId = clean(
      recommendation.outcomeId
    );

    const specifier = clean(
      recommendation.specifier
    );

    /*
      First check:
      market + outcome + specifier
    */

    let match = markets.find((item) =>
      same(item.marketId, marketId) &&
      same(item.outcomeId, outcomeId) &&
      same(item.specifier, specifier)
    );

    /*
      Second check:
      market + outcome

      This handles harmless differences in how an empty
      specifier is represented.
    */

    if (!match) {
      match = markets.find((item) =>
        same(item.marketId, marketId) &&
        same(item.outcomeId, outcomeId)
      );
    }

    return match || null;
  }

  // ============================================================
  // AI RECOMMENDED
  //
  // IMPORTANT:
  // ONE GAME = ONE GEMINI REQUEST
  // ============================================================

  async function recommendOneGame(
    event,
    originalSelection,
    markets
  ) {
    if (!markets.length) {
      throw new Error(
        `No verified SportyBet markets were available for ${event.event}.`
      );
    }

    const prompt = `
You are selecting ONE SportyBet recommendation for ONE football game.

THIS IS ONE GAME ONLY.

You MUST return exactly ONE JSON OBJECT.

DO NOT:
- return an array
- return multiple selections
- recommend multiple markets
- recommend another game
- create a ticket
- invent any information

GAME:
${clean(event.event)}

EVENT ID:
${clean(event.eventId)}

USER'S ORIGINAL SELECTION:
${JSON.stringify(originalSelection)}

VERIFIED SPORTYBET MARKETS FOR THIS EXACT GAME:
${JSON.stringify(markets)}

RULES:

1. Choose exactly ONE selection.
2. The selection must belong to this exact event.
3. You may keep the original selection.
4. You may choose an alternative market.
5. Any alternative MUST exist in the verified SportyBet markets above.
6. Never invent a marketId.
7. Never invent an outcomeId.
8. Never invent odds.
9. Never invent a market.
10. Never invent an outcome.
11. Copy the marketId, outcomeId, specifier, market name, pick and odds from the verified data.
12. Do not claim certainty.
13. Do not invent team form.
14. Do not invent injuries.
15. Do not invent statistics.
16. Do not invent probabilities.
17. Give ONE short natural reason.

STYLE:

Sound like a knowledgeable football fan explaining the choice to another fan.

Avoid robotic phrases such as:
"optimize stability"
"lower variance profile"
"selection profile"
"relative variance"
"this profile focuses on"

Keep the reason to ONE short sentence.

RETURN ONLY THIS JSON OBJECT:

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

    /*
      Try this individual game twice.
    */

    let lastError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ai = await callGemini(prompt);

        if (
          !ai ||
          Array.isArray(ai) ||
          typeof ai !== "object"
        ) {
          throw new Error(
            `AI did not return exactly one recommendation for ${event.event}.`
          );
        }

        /*
          Make sure Gemini returned THIS event.
        */

        if (
          !same(
            ai.eventId,
            event.eventId
          )
        ) {
          throw new Error(
            `AI returned the wrong event for ${event.event}.`
          );
        }

        /*
          Verify the recommendation against the
          actual SportyBet markets.
        */

        const verified =
          findVerifiedRecommendation(
            ai,
            markets
          );

        if (!verified) {
          throw new Error(
            `AI recommendation for ${event.event} does not match a verified SportyBet market.`
          );
        }

        /*
          IMPORTANT:
          Never trust Gemini's IDs or odds.

          Replace them with the actual verified
          SportyBet values.
        */

        return {
          event: event.event,
          market: verified.market,
          pick: verified.pick,
          odds: verified.odds,

          eventId: event.eventId,

          gameId:
            event.gameId ||
            originalSelection?.gameId ||
            "",

          marketId: verified.marketId,

          specifier:
            verified.specifier,

          outcomeId:
            verified.outcomeId,

          startTime:
            event.startTime ||
            originalSelection?.startTime ||
            "",

          reason:
            clean(ai.reason) ||
            "This option is available and verified on SportyBet."
        };
      } catch (error) {
        lastError = error;

        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500)
          );
        }
      }
    }

    throw lastError || new Error(
      `Unable to generate a verified recommendation for ${event.event}.`
    );
  }

  // ============================================================
  // SAFE / BALANCED / RISKY
  // ============================================================

  async function generateProfiles() {
    const prompt = `
Organize these ORIGINAL SportyBet selections into three profiles:

SAFE
BALANCED
RISKY

IMPORTANT RULES:

- Only use selections from the original list.
- Never invent a new game.
- Never invent a new market.
- Never invent a new outcome.
- Never change eventId.
- Never change marketId.
- Never change outcomeId.
- SAFE should contain a smaller, less aggressive subset.
- BALANCED should be a middle-ground mix.
- RISKY can keep more of the original action.
- These names describe ticket style only. They are NOT guarantees.

Use natural football-fan language.

SAFE example:
"I've trimmed this down to a smaller set of the original picks."

BALANCED example:
"A middle-ground mix — not too cautious, not too aggressive."

RISKY example:
"This keeps more of the original action, but there's less room for mistakes."

Return ONLY valid JSON:

{
  "SAFE": {
    "summary": "",
    "selections": []
  },
  "BALANCED": {
    "summary": "",
    "selections": []
  },
  "RISKY": {
    "summary": "",
    "selections": []
  }
}

ORIGINAL SELECTIONS:

${JSON.stringify(originalSelections)}
`;

    return callGemini(prompt);
  }

  // ============================================================
  // VALIDATE ORIGINAL PROFILES
  // ============================================================

  function validateOriginalProfile(profile) {
    const selections =
      Array.isArray(profile?.selections)
        ? profile.selections
        : [];

    return selections
      .map((candidate) => {
        const original =
          originalSelections.find((item) =>
            same(
              item.eventId,
              candidate.eventId
            ) &&
            same(
              item.marketId,
              candidate.marketId
            ) &&
            same(
              item.outcomeId,
              candidate.outcomeId
            ) &&
            same(
              item.specifier,
              candidate.specifier
            )
          );

        if (!original) {
          return null;
        }

        return {
          ...original,

          reason:
            clean(candidate.reason) ||
            "This keeps the original selection."
        };
      })
      .filter(Boolean);
  }

  // ============================================================
  // COMBINED ODDS
  // ============================================================

  function combinedOdds(selections) {
    if (
      !Array.isArray(selections) ||
      !selections.length
    ) {
      return null;
    }

    let total = 1;

    for (const selection of selections) {
      const odds = Number(
        selection.odds
      );

      if (
        !Number.isFinite(odds) ||
        odds <= 0
      ) {
        return null;
      }

      total *= odds;
    }

    return Number(
      total.toFixed(2)
    );
  }

  // ============================================================
  // MAIN PROCESS
  // ============================================================

  try {
    /*
      ----------------------------------------------------------
      STEP 1
      Find every unique game.
      ----------------------------------------------------------
    */

    const eventMap = new Map();

    for (const selection of originalSelections) {
      const eventId =
        clean(selection?.eventId);

      if (!eventId) {
        continue;
      }

      if (!eventMap.has(eventId)) {
        eventMap.set(eventId, {
          eventId,

          event:
            clean(selection.event),

          gameId:
            clean(selection.gameId),

          startTime:
            selection.startTime,

          originalSelection:
            selection
        });
      }
    }

    const events =
      Array.from(eventMap.values());

    if (!events.length) {
      return res.status(400).json({
        success: false,
        error:
          "No usable SportyBet event IDs were found."
      });
    }

    /*
      ----------------------------------------------------------
      STEP 2
      Verify every game's SportyBet markets.
      ----------------------------------------------------------
    */

    const verifiedEvents = [];
    const verificationErrors = [];

    for (const event of events) {
      try {
        const marketData =
          await getMarkets(
            event.eventId
          );

        const markets =
          extractMarkets(
            marketData
          );

        if (!markets.length) {
          throw new Error(
            "No usable SportyBet markets were returned."
          );
        }

        verifiedEvents.push({
          ...event,
          markets
        });
      } catch (error) {
        console.error(
          `Market verification failed for ${event.event}:`,
          error
        );

        verificationErrors.push({
          eventId:
            event.eventId,

          event:
            event.event,

          error:
            error?.message ||
            "Market verification failed."
        });
      }
    }

    /*
      Do not fabricate anything if no games were verified.
    */

    if (!verifiedEvents.length) {
      return res.status(502).json({
        success: false,

        error:
          "SportyBet markets could not be verified for any game.",

        verificationErrors
      });
    }

    /*
      ----------------------------------------------------------
      STEP 3
      Generate SAFE / BALANCED / RISKY.
      ----------------------------------------------------------
    */

    let profiles;

    try {
      profiles =
        await generateProfiles();
    } catch (error) {
      console.error(
        "Profile generation failed:",
        error
      );

      /*
        Deterministic fallback.
      */

      profiles = {
        SAFE: {
          summary:
            "I've trimmed this down to a smaller set of the original picks.",

          selections:
            originalSelections.slice(
              0,
              Math.max(
                1,
                Math.ceil(
                  originalSelections.length / 2
                )
              )
            )
        },

        BALANCED: {
          summary:
            "A middle-ground mix using the original selections.",

          selections:
            [...originalSelections]
        },

        RISKY: {
          summary:
            "This keeps more of the original action.",

          selections:
            [...originalSelections]
        }
      };
    }

    const safeSelections =
      validateOriginalProfile(
        profiles?.SAFE
      );

    const balancedSelections =
      validateOriginalProfile(
        profiles?.BALANCED
      );

    const riskySelections =
      validateOriginalProfile(
        profiles?.RISKY
      );

    /*
      ----------------------------------------------------------
      STEP 4
      AI RECOMMENDED.

      THIS IS THE IMPORTANT PART.

      Each verified game gets its own AI call.

      Game 1 -> ONE recommendation
      Game 2 -> ONE recommendation
      Game 3 -> ONE recommendation
      Game 4 -> ONE recommendation

      Then the results are combined.
      ----------------------------------------------------------
    */

    const aiRecommended = [];
    const aiErrors = [];

    for (const event of verifiedEvents) {
      try {
        const recommendation =
          await recommendOneGame(
            event,
            event.originalSelection,
            event.markets
          );

        /*
          Final event check.
        */

        if (
          !same(
            recommendation.eventId,
            event.eventId
          )
        ) {
          throw new Error(
            `Recommendation does not belong to ${event.event}.`
          );
        }

        aiRecommended.push(
          recommendation
        );
      } catch (error) {
        console.error(
          `AI recommendation failed for ${event.event}:`,
          error
        );

        aiErrors.push({
          eventId:
            event.eventId,

          event:
            event.event,

          error:
            error?.message ||
            "AI recommendation failed."
        });
      }
    }

    /*
      ----------------------------------------------------------
      STEP 5
      HARD CHECK.

      If we have 4 verified games, AI RECOMMENDED MUST
      contain exactly 4 recommendations.

      If not, return an error instead of showing an
      incomplete/misleading AI ticket.
      ----------------------------------------------------------
    */

    if (
      aiRecommended.length !==
      verifiedEvents.length
    ) {
      return res.status(502).json({
        success: false,

        error:
          `AI RECOMMENDED could only create ${aiRecommended.length} of ${verifiedEvents.length} required game recommendations.`,

        verificationErrors,

        aiErrors
      });
    }

    /*
      Make sure every recommendation belongs to a
      different game.
    */

    const recommendedEventIds =
      new Set(
        aiRecommended.map(
          (item) => item.eventId
        )
      );

    if (
      recommendedEventIds.size !==
      verifiedEvents.length
    ) {
      return res.status(502).json({
        success: false,

        error:
          "AI RECOMMENDED failed the one-game-per-selection validation."
      });
    }

    /*
      ----------------------------------------------------------
      STEP 6
      FINAL RESPONSE.
      ----------------------------------------------------------
    */

    return res.status(200).json({
      success: true,

      totalGames:
        events.length,

      verifiedGames:
        verifiedEvents.length,

      profiles: {
        SAFE: {
          summary:
            clean(
              profiles?.SAFE?.summary
            ) ||
            "I've trimmed this down to a smaller set of the original picks.",

          selections:
            safeSelections,

          count:
            safeSelections.length,

          combinedOdds:
            combinedOdds(
              safeSelections
            )
        },

        BALANCED: {
          summary:
            clean(
              profiles?.BALANCED?.summary
            ) ||
            "A middle-ground mix using the original selections.",

          selections:
            balancedSelections,

          count:
            balancedSelections.length,

          combinedOdds:
            combinedOdds(
              balancedSelections
            )
        },

        RISKY: {
          summary:
            clean(
              profiles?.RISKY?.summary
            ) ||
            "This keeps more of the original action.",

          selections:
            riskySelections,

          count:
            riskySelections.length,

          combinedOdds:
            combinedOdds(
              riskySelections
            )
        },

        "AI RECOMMENDED": {
          summary:
            `I checked the available SportyBet markets and picked one option for each of the ${aiRecommended.length} verified games.`,

          /*
            GUARANTEED by the checks above:
            one recommendation per verified game.
          */

          selections:
            aiRecommended,

          count:
            aiRecommended.length,

          combinedOdds:
            combinedOdds(
              aiRecommended
            ),

          verified:
            true,

          verifiedGames:
            aiRecommended.length,

          expectedGames:
            verifiedEvents.length
        }
      },

      verification: {
        requestedGames:
          events.length,

        verifiedGames:
          verifiedEvents.length,

        verificationErrors
      }
    });

  } catch (error) {
    console.error(
      "Optimize endpoint fatal error:",
      error
    );

    /*
      ALWAYS return JSON.
      This prevents the frontend from getting:
      "Unexpected token 'A'..."
    */

    return res.status(500).json({
      success: false,

      error:
        error?.message ||
        "A server error occurred while optimizing the selections."
    });
  }
}
