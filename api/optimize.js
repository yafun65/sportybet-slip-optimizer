export default async function handler(req, res) {
  /*
   * ============================================================
   * SPORTYBET SELECTION OPTIMIZER
   *
   * AI RECOMMENDED rules:
   *
   * 1. Find every unique game/event in the booking.
   * 2. Load the real SportyBet markets for EVERY game.
   * 3. Ask Gemini to choose ONE market/outcome for EACH game.
   * 4. Verify every AI choice against the real SportyBet markets.
   * 5. Never invent event IDs, market IDs, outcome IDs or odds.
   * 6. Return one verified selection per unique game whenever
   *    SportyBet provides usable markets.
   *
   * SAFE / BALANCED / RISKY:
   * - Use only the user's original selections.
   * - AI can remove/reorder original selections.
   * - AI cannot invent new selections for these profiles.
   *
   * ============================================================
   */


  /* ============================================================
     BASIC REQUEST CHECKS
     ============================================================ */

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed."
    });
  }


  const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY;


  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      success: false,
      error:
        "GEMINI_API_KEY is not configured in Vercel."
    });
  }


  const inputSelections =
    Array.isArray(req.body?.selections)
      ? req.body.selections
      : [];


  if (!inputSelections.length) {
    return res.status(400).json({
      success: false,
      error:
        "No selections were supplied."
    });
  }


  /* ============================================================
     HELPERS
     ============================================================ */

  function clean(value) {
    if (value === undefined || value === null) {
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


  function numberValue(value) {
    const n = Number(value);

    return Number.isFinite(n)
      ? n
      : null;
  }


  function uniqueBy(array, keyFunction) {
    const seen = new Set();

    return array.filter(item => {
      const key = keyFunction(item);

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    });
  }


  function combinedOdds(selections) {
    if (!Array.isArray(selections) || !selections.length) {
      return null;
    }

    let total = 1;
    let valid = 0;

    for (const selection of selections) {
      const odds = Number(selection?.odds);

      if (
        Number.isFinite(odds) &&
        odds > 0
      ) {
        total *= odds;
        valid++;
      }
    }

    if (!valid) {
      return null;
    }

    return Number(total.toFixed(2));
  }


  function formatOdds(value) {
    const n = Number(value);

    if (
      !Number.isFinite(n) ||
      n <= 0
    ) {
      return null;
    }

    return Number(n.toFixed(2));
  }


  function getEventName(selection) {
    return (
      clean(selection?.event) ||
      clean(selection?.eventName) ||
      clean(selection?.match) ||
      "Unknown game"
    );
  }


  function getEventId(selection) {
    return (
      clean(selection?.eventId) ||
      clean(selection?.eventID) ||
      clean(selection?.id)
    );
  }


  /* ============================================================
     VALIDATE INPUT SELECTIONS
     ============================================================ */

  const selections = inputSelections
    .map(selection => ({
      event:
        getEventName(selection),

      eventId:
        getEventId(selection),

      gameId:
        clean(selection?.gameId),

      market:
        clean(selection?.market) ||
        clean(selection?.marketName),

      pick:
        clean(selection?.pick) ||
        clean(selection?.outcome) ||
        clean(selection?.outcomeName),

      odds:
        formatOdds(
          selection?.odds ??
          selection?.odd ??
          selection?.price
        ),

      marketId:
        clean(selection?.marketId),

      specifier:
        selection?.specifier ??
        null,

      outcomeId:
        clean(selection?.outcomeId)
    }))
    .filter(selection =>
      selection.eventId
    );


  if (!selections.length) {
    return res.status(400).json({
      success: false,
      error:
        "The booking selections do not contain valid SportyBet event IDs."
    });
  }


  /* ============================================================
     FIND UNIQUE GAMES
     ============================================================ */

  const events = uniqueBy(
    selections,
    selection => selection.eventId
  );


  /*
   * This is the critical number.
   *
   * If the booking has 4 unique event IDs:
   * totalGames = 4
   *
   * AI RECOMMENDED should attempt 4 recommendations.
   */

  const totalGames = events.length;


  /* ============================================================
     FETCH WITH TIMEOUT
     ============================================================ */

  async function fetchWithTimeout(
    url,
    options = {},
    timeoutMs = 15000
  ) {

    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        timeoutMs
      );


    try {

      const response =
        await fetch(url, {
          ...options,
          signal:
            controller.signal
        });

      return response;

    } finally {

      clearTimeout(timer);
    }
  }


  /* ============================================================
     SPORTYBET MARKET FETCH
     ============================================================ */

  async function getMarkets(eventId) {

    const url =
      `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(eventId)}`;


    try {

      const response =
        await fetchWithTimeout(
          url,
          {},
          18000
        );


      const raw =
        await response.text();


      let data;


      try {

        data =
          JSON.parse(raw);

      } catch (error) {

        throw new Error(
          "SportyBet market service returned invalid JSON."
        );
      }


      if (!response.ok) {

        throw new Error(
          data?.error ||
          `Market service returned HTTP ${response.status}.`
        );
      }


      const markets =
        extractMarkets(data);


      if (!markets.length) {

        throw new Error(
          "No usable SportyBet markets were found for this game."
        );
      }


      return {
        success: true,
        eventId,
        markets
      };


    } catch (error) {

      return {
        success: false,
        eventId,
        markets: [],
        error:
          error?.message ||
          "Unable to load SportyBet markets."
      };
    }
  }


  /* ============================================================
     EXTRACT SPORTYBET MARKETS
     ============================================================ */

  function extractMarkets(data) {

    /*
     * SportyBet/Render responses can have slightly different
     * nesting depending on the endpoint response.
     */

    const candidates = [];


    function collect(value, depth = 0) {

      if (
        value === null ||
        value === undefined ||
        depth > 8
      ) {
        return;
      }


      if (Array.isArray(value)) {

        for (const item of value) {
          collect(item, depth + 1);
        }

        return;
      }


      if (
        typeof value !== "object"
      ) {
        return;
      }


      /*
       * Detect an object that looks like a market.
       */

      const hasMarketId =
        value.marketId !== undefined ||
        value.id !== undefined;


      const hasOutcomes =
        Array.isArray(value.outcomes) ||
        Array.isArray(value.selections) ||
        Array.isArray(value.picks);


      if (
        hasMarketId &&
        hasOutcomes
      ) {
        candidates.push(value);
      }


      for (const key of Object.keys(value)) {

        const child =
          value[key];

        if (
          child &&
          typeof child === "object"
        ) {
          collect(child, depth + 1);
        }
      }
    }


    collect(data);


    /*
     * Also explicitly inspect common containers.
     */

    const directContainers = [
      data?.markets,
      data?.data?.markets,
      data?.event?.markets,
      data?.data?.event?.markets,
      data?.data?.data?.markets
    ];


    for (
      const container
      of directContainers
    ) {

      if (Array.isArray(container)) {

        candidates.push(
          ...container
        );
      }
    }


    const uniqueMarketObjects =
      uniqueBy(
        candidates,
        market => {

          return [
            clean(
              market?.marketId ??
              market?.id
            ),

            clean(
              market?.specifier
            )
          ].join("|");

        }
      );


    const flattened = [];


    for (
      const market
      of uniqueMarketObjects
    ) {

      const marketId =
        clean(
          market?.marketId ??
          market?.id
        );


      if (!marketId) {
        continue;
      }


      const marketName =
        clean(
          market?.marketName ??
          market?.name ??
          market?.market ??
          market?.desc ??
          `Market ${marketId}`
        );


      const specifier =
        market?.specifier ??
        market?.specifiers ??
        null;


      const outcomes =
        Array.isArray(
          market?.outcomes
        )
          ? market.outcomes
          : Array.isArray(
              market?.selections
            )
            ? market.selections
            : Array.isArray(
                market?.picks
              )
              ? market.picks
              : [];


      for (
        const outcome
        of outcomes
      ) {

        if (
          !outcome ||
          typeof outcome !== "object"
        ) {
          continue;
        }


        const outcomeId =
          clean(
            outcome?.outcomeId ??
            outcome?.id ??
            outcome?.selectionId ??
            outcome?.key
          );


        if (!outcomeId) {
          continue;
        }


        const pick =
          clean(
            outcome?.pick ??
            outcome?.name ??
            outcome?.label ??
            outcome?.desc ??
            outcome?.value ??
            outcome?.title
          );


        const odds =
          numberValue(
            outcome?.odds ??
            outcome?.odd ??
            outcome?.price
          );


        if (!pick) {
          continue;
        }


        flattened.push({

          market:
            marketName,

          marketId:
            marketId,

          specifier:
            specifier,

          pick:
            pick,

          odds:
            formatOdds(odds),

          outcomeId:
            outcomeId
        });
      }
    }


    /*
     * Remove exact duplicates.
     */

    return uniqueBy(
      flattened,
      item => [

        item.marketId,

        clean(item.specifier),

        item.outcomeId

      ].join("|")
    );
  }


  /* ============================================================
     GEMINI API
     ============================================================ */

  async function callGeminiStructured(
    prompt,
    schema
  ) {

    const models = [
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite"
    ];


    let lastError = null;


    for (
      const model
      of models
    ) {

      for (
        let attempt = 1;
        attempt <= 2;
        attempt++
      ) {

        try {

          const url =
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;


          const response =
            await fetchWithTimeout(
              url,
              {
                method: "POST",

                headers: {
                  "Content-Type":
                    "application/json",

                  "x-goog-api-key":
                    GEMINI_API_KEY
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

                    responseMimeType:
                      "application/json",

                    responseSchema:
                      schema,

                    temperature:
                      0.2,

                    maxOutputTokens:
                      1000
                  }

                })
              },
              20000
            );


          const raw =
            await response.text();


          let data;


          try {

            data =
              JSON.parse(raw);

          } catch (error) {

            throw new Error(
              `Gemini returned invalid JSON: ${raw.slice(0, 300)}`
            );
          }


          if (!response.ok) {

            const errorMessage =
              data?.error?.message ||
              `Gemini HTTP ${response.status}.`;


            /*
             * Retry temporary errors.
             */

            if (
              [429, 500, 502, 503, 504]
                .includes(response.status) &&
              attempt < 2
            ) {

              await sleep(
                700 * attempt
              );

              lastError =
                new Error(
                  errorMessage
                );

              continue;
            }


            throw new Error(
              errorMessage
            );
          }


          const text =
            data?.candidates?.[0]
              ?.content
              ?.parts
              ?.map(part => part?.text || "")
              .join("")
              .trim();


          if (!text) {

            throw new Error(
              "Gemini returned an empty response."
            );
          }


          let parsed;


          try {

            parsed =
              JSON.parse(text);

          } catch (error) {

            throw new Error(
              "Gemini returned malformed structured JSON."
            );
          }


          return parsed;


        } catch (error) {

          lastError =
            error;


          if (attempt < 2) {

            await sleep(
              700 * attempt
            );

            continue;
          }
        }
      }
    }


    throw (
      lastError ||
      new Error(
        "Gemini request failed."
      )
    );
  }


  function sleep(ms) {
    return new Promise(
      resolve =>
        setTimeout(
          resolve,
          ms
        )
    );
  }


  /* ============================================================
     AI RECOMMENDED SCHEMA
     ============================================================ */

  const recommendationSchema = {

    type: "object",

    properties: {

      marketId: {
        type: "string"
      },

      specifier: {
        type: [
          "string",
          "null"
        ]
      },

      outcomeId: {
        type: "string"
      },

      reason: {
        type: "string"
      }

    },

    required: [
      "marketId",
      "outcomeId",
      "reason"
    ],

    additionalProperties: false
  };


  /* ============================================================
     RECOMMEND ONE GAME
     ============================================================ */

  async function recommendOneGame(
    event,
    originalSelection,
    markets
  ) {

    const eventId =
      event.eventId;


    /*
     * Only give Gemini actual SportyBet markets.
     */

    const marketData =
      markets.map(
        (market, index) => ({

          number:
            index + 1,

          marketId:
            market.marketId,

          market:
            market.market,

          specifier:
            market.specifier,

          pick:
            market.pick,

          odds:
            market.odds,

          outcomeId:
            market.outcomeId

        })
      );


    const prompt = `
You are helping organize a football betting selection ticket.

IMPORTANT:
You are NOT allowed to invent markets, outcomes, IDs or odds.

You are choosing ONE selection for ONE specific football game.

GAME:
${getEventName(event)}

EVENT ID:
${eventId}

ORIGINAL SELECTION:
Market: ${originalSelection?.market || "Unknown"}
Pick: ${originalSelection?.pick || "Unknown"}
Odds: ${originalSelection?.odds ?? "Unknown"}

REAL SPORTYBET MARKETS AVAILABLE FOR THIS GAME:
${JSON.stringify(marketData)}

TASK:

Choose EXACTLY ONE selection from the REAL SPORTYBET MARKET LIST above.

The recommendation must belong to this exact event.

Prefer a sensible alternative market when one is available.

If the original selection is the most suitable verified option, it is acceptable to choose the original market.

DO NOT:
- invent a market
- invent an outcome
- invent an outcomeId
- invent a marketId
- invent odds
- use a market from another game
- return more than one selection
- return zero selections

You MUST return exactly one object.

Use the exact marketId and outcomeId from the supplied SportyBet data.

For the reason:
- use natural football language
- keep it to one short sentence
- do not claim certainty
- do not invent team form, injuries or statistics
- do not use phrases like "optimize stability", "lower variance profile", or "selection profile"

Return ONLY the JSON object required by the schema.
`;


    try {

      const ai =
        await callGeminiStructured(
          prompt,
          recommendationSchema
        );


      /*
       * Find the exact real market/outcome.
       */

      const verified =
        markets.find(
          market =>

            same(
              market.marketId,
              ai?.marketId
            ) &&

            same(
              market.outcomeId,
              ai?.outcomeId
            ) &&

            (
              ai?.specifier === undefined ||
              ai?.specifier === null ||
              same(
                market.specifier,
                ai.specifier
              )
            )
        );


      if (!verified) {

        /*
         * Second verification attempt:
         * Some markets may have a null/empty specifier.
         */

        const fallbackVerified =
          markets.find(
            market =>

              same(
                market.marketId,
                ai?.marketId
              ) &&

              same(
                market.outcomeId,
                ai?.outcomeId
              )
          );


        if (!fallbackVerified) {

          throw new Error(
            "Gemini selected a market/outcome that was not found in the verified SportyBet markets."
          );
        }


        return {

          event:
            getEventName(event),

          eventId:
            eventId,

          market:
            fallbackVerified.market,

          marketId:
            fallbackVerified.marketId,

          specifier:
            fallbackVerified.specifier,

          pick:
            fallbackVerified.pick,

          odds:
            fallbackVerified.odds,

          outcomeId:
            fallbackVerified.outcomeId,

          reason:
            clean(ai?.reason) ||
            "This verified SportyBet option gives a different way to approach the game."

        };
      }


      return {

        event:
          getEventName(event),

        eventId:
          eventId,

        market:
          verified.market,

        marketId:
          verified.marketId,

        specifier:
          verified.specifier,

        pick:
          verified.pick,

        odds:
          verified.odds,

        outcomeId:
          verified.outcomeId,

        reason:
          clean(ai?.reason) ||
          "This verified SportyBet option gives a different way to approach the game."

      };


    } catch (error) {

      /*
       * IMPORTANT FALLBACK:
       *
       * If AI fails, use the ORIGINAL selection ONLY IF
       * that exact original selection exists in the real
       * SportyBet market list.
       *
       * This means the AI RECOMMENDED profile still has
       * one selection for this game without inventing data.
       */

      const verifiedOriginal =
        markets.find(
          market =>

            same(
              market.marketId,
              originalSelection?.marketId
            ) &&

            same(
              market.outcomeId,
              originalSelection?.outcomeId
            ) &&

            (
              !originalSelection?.specifier ||
              same(
                market.specifier,
                originalSelection.specifier
              )
            )
        );


      if (verifiedOriginal) {

        return {

          event:
            getEventName(event),

          eventId:
            eventId,

          market:
            verifiedOriginal.market,

          marketId:
            verifiedOriginal.marketId,

          specifier:
            verifiedOriginal.specifier,

          pick:
            verifiedOriginal.pick,

          odds:
            verifiedOriginal.odds,

          outcomeId:
            verifiedOriginal.outcomeId,

          reason:
            "The original pick was used because no verified alternative could be confirmed."

        };
      }


      return {

        event:
          getEventName(event),

        eventId:
          eventId,

        error:
          error?.message ||
          "No verified recommendation could be created for this game."

      };
    }
  }


  /* ============================================================
     LOAD ALL GAME MARKETS IN PARALLEL
     ============================================================ */

  const marketResults =
    await Promise.all(
      events.map(event =>
        getMarkets(event.eventId)
      )
    );


  const marketMap =
    new Map();


  const verificationErrors = [];


  for (
    const result
    of marketResults
  ) {

    if (
      result.success &&
      result.markets.length
    ) {

      marketMap.set(
        result.eventId,
        result.markets
      );

    } else {

      verificationErrors.push({

        eventId:
          result.eventId,

        error:
          result.error ||
          "No verified markets found."

      });
    }
  }


  /*
   * Only games with verified SportyBet markets can be
   * used for AI recommendations.
   */

  const verifiedEvents =
    events.filter(event =>
      marketMap.has(
        event.eventId
      )
    );


  /* ============================================================
     ORIGINAL PROFILE VALIDATION
     ============================================================ */

  function validateOriginalProfile(
    profileSelections
  ) {

    const originalKeys =
      new Set(
        selections.map(selection =>
          [
            selection.eventId,
            selection.marketId,
            clean(selection.specifier),
            selection.outcomeId
          ].join("|")
        )
      );


    return profileSelections.filter(
      selection => {

        const key =
          [
            selection.eventId,
            selection.marketId,
            clean(selection.specifier),
            selection.outcomeId
          ].join("|");


        return originalKeys.has(key);
      }
    );
  }


  /* ============================================================
     SAFE / BALANCED / RISKY AI
     ============================================================ */

  const profileSchema = {

    type: "object",

    properties: {

      SAFE: {

        type: "array",

        items: {
          type: "integer"
        }
      },

      BALANCED: {

        type: "array",

        items: {
          type: "integer"
        }
      },

      RISKY: {

        type: "array",

        items: {
          type: "integer"
        }
      },

      safeSummary: {
        type: "string"
      },

      balancedSummary: {
        type: "string"
      },

      riskySummary: {
        type: "string"
      }

    },

    required: [
      "SAFE",
      "BALANCED",
      "RISKY",
      "safeSummary",
      "balancedSummary",
      "riskySummary"
    ],

    additionalProperties: false
  };


  async function generateProfiles() {

    const numberedSelections =
      selections.map(
        (selection, index) => ({

          index,

          event:
            selection.event,

          eventId:
            selection.eventId,

          market:
            selection.market,

          pick:
            selection.pick,

          odds:
            selection.odds,

          marketId:
            selection.marketId,

          specifier:
            selection.specifier,

          outcomeId:
            selection.outcomeId

        })
      );


    const prompt = `
You are helping organize a football betting ticket.

The user has supplied these ORIGINAL SportyBet selections:

${JSON.stringify(numberedSelections)}

Create three profiles:

SAFE:
Remove some of the more aggressive original selections.
Use ONLY the original selections.

BALANCED:
Create a middle-ground ticket using ONLY the original selections.

RISKY:
Keep more of the original selections.
Use ONLY the original selections.

IMPORTANT:
- You may remove selections.
- You may reorder selections.
- You may NOT invent selections.
- You may NOT change a market.
- You may NOT change a pick.
- You may NOT change odds.
- You may NOT create new IDs.
- Every returned number must correspond to an original selection index.
- Do not duplicate an index.

The profiles should be useful as different ticket-building approaches, not guarantees of winning.

STYLE:

Make the summaries sound natural and human, like a knowledgeable football fan explaining the ticket.

Do NOT use robotic or corporate phrases such as:
"optimize stability"
"lower variance profile"
"selection profile"
"relative variance"
"this profile focuses on"

Prefer:

SAFE:
"I've trimmed this down to the less aggressive picks."

BALANCED:
"A middle-ground mix — not too cautious, not too aggressive."

RISKY:
"This keeps more of the action, but there's less room for mistakes."

Keep each summary to one short sentence.

Return ONLY the JSON required by the schema.
`;


    const ai =
      await callGeminiStructured(
        prompt,
        profileSchema
      );


    function indexesToSelections(
      indexes
    ) {

      if (!Array.isArray(indexes)) {
        return [];
      }


      const validIndexes =
        uniqueBy(
          indexes,
          index => Number(index)
        )
          .map(index => Number(index))
          .filter(index =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < selections.length
          );


      return validIndexes.map(
        index => ({
          ...selections[index]
        })
      );
    }


    const safe =
      validateOriginalProfile(
        indexesToSelections(
          ai.SAFE
        )
      );


    const balanced =
      validateOriginalProfile(
        indexesToSelections(
          ai.BALANCED
        )
      );


    const risky =
      validateOriginalProfile(
        indexesToSelections(
          ai.RISKY
        )
      );


    /*
     * If AI accidentally returns an empty profile,
     * use sensible original-selection fallbacks.
     */

    const safeFinal =
      safe.length
        ? safe
        : selections.slice(
            0,
            Math.max(
              1,
              Math.ceil(
                selections.length / 2
              )
            )
          );


    const balancedFinal =
      balanced.length
        ? balanced
        : selections.slice();


    const riskyFinal =
      risky.length
        ? risky
        : selections.slice();


    return {

      SAFE: {

        selections:
          safeFinal,

        summary:
          clean(
            ai.safeSummary
          ) ||
          "I've trimmed this down to the less aggressive picks."

      },


      BALANCED: {

        selections:
          balancedFinal,

        summary:
          clean(
            ai.balancedSummary
          ) ||
          "A middle-ground mix — not too cautious, not too aggressive."

      },


      RISKY: {

        selections:
          riskyFinal,

        summary:
          clean(
            ai.riskySummary
          ) ||
          "This keeps more of the action, but there's less room for mistakes."

      }

    };
  }


  /* ============================================================
     GENERATE SAFE / BALANCED / RISKY
     ============================================================ */

  let profiles;


  try {

    profiles =
      await generateProfiles();

  } catch (error) {

    console.error(
      "Profile generation error:",
      error
    );


    /*
     * The original selections are still valid,
     * so provide deterministic fallbacks.
     */

    profiles = {

      SAFE: {

        selections:
          selections.slice(
            0,
            Math.max(
              1,
              Math.ceil(
                selections.length / 2
              )
            )
          ),

        summary:
          "I've trimmed this down to fewer original picks."

      },


      BALANCED: {

        selections:
          selections.slice(),

        summary:
          "A middle-ground mix using the original picks."

      },


      RISKY: {

        selections:
          selections.slice(),

        summary:
          "This keeps more of the original action."

      }

    };
  }


  /* ============================================================
     AI RECOMMENDED
     ============================================================ */

  /*
   * CRITICAL:
   *
   * Every verified game gets its OWN AI request.
   *
   * Promise.all means all games are processed in parallel.
   */

  const recommendationResults =
    await Promise.all(

      verifiedEvents.map(
        async event => {

          const originalSelection =
            selections.find(
              selection =>
                selection.eventId ===
                event.eventId
            );


          const markets =
            marketMap.get(
              event.eventId
            ) || [];


          if (
            !originalSelection ||
            !markets.length
          ) {

            return {

              event:
                getEventName(event),

              eventId:
                event.eventId,

              error:
                "No usable original selection or SportyBet markets were found."

            };
          }


          return recommendOneGame(
            event,
            originalSelection,
            markets
          );
        }
      )
    );


  /* ============================================================
     BUILD AI RECOMMENDED
     ============================================================ */

  const aiRecommended =
    recommendationResults.filter(
      result =>
        result &&
        !result.error &&
        result.eventId &&
        result.marketId &&
        result.outcomeId
    );


  /*
   * Remove duplicate events.
   *
   * There must never be two AI recommendations
   * for the same game.
   */

  const uniqueAIRecommended =
    uniqueBy(
      aiRecommended,
      selection =>
        selection.eventId
    );


  /* ============================================================
     AI ERRORS
     ============================================================ */

  const aiErrors =
    recommendationResults
      .filter(
        result =>
          result?.error
      )
      .map(
        result => ({
          event:
            result.event,

          eventId:
            result.eventId,

          error:
            result.error
        })
      );


  /* ============================================================
     FINAL AI GAME COUNT CHECK
     ============================================================ */

  /*
   * This is the hard rule:
   *
   * AI RECOMMENDED should have one selection
   * for every unique game whose real SportyBet
   * markets were successfully verified.
   */

  const expectedAISelections =
    verifiedEvents.length;


  const actualAISelections =
    uniqueAIRecommended.length;


  const aiComplete =
    actualAISelections ===
    expectedAISelections;


  /*
   * If a game failed, DO NOT invent a pick just to
   * make the count look correct.
   */


  let aiSummary;


  if (aiComplete) {

    aiSummary =
      "I looked at the available SportyBet markets and picked one verified option for each game.";

  } else {

    aiSummary =
      `Verified recommendations were created for ${actualAISelections} of ${expectedAISelections} games.`;

  }


  /* ============================================================
     FINAL RESPONSE
     ============================================================ */

  const response = {

    success: true,


    totalGames:
      totalGames,


    verifiedGames:
      verifiedEvents.length,


    profiles: {

      SAFE: {

        selections:
          profiles.SAFE.selections,

        combinedOdds:
          combinedOdds(
            profiles.SAFE.selections
          ),

        summary:
          profiles.SAFE.summary

      },


      BALANCED: {

        selections:
          profiles.BALANCED.selections,

        combinedOdds:
          combinedOdds(
            profiles.BALANCED.selections
          ),

        summary:
          profiles.BALANCED.summary

      },


      RISKY: {

        selections:
          profiles.RISKY.selections,

        combinedOdds:
          combinedOdds(
            profiles.RISKY.selections
          ),

        summary:
          profiles.RISKY.summary

      },


      "AI RECOMMENDED": {

        selections:
          uniqueAIRecommended,

        combinedOdds:
          combinedOdds(
            uniqueAIRecommended
          ),

        summary:
          aiSummary

      }

    },


    verification: {

      totalGames:
        totalGames,

      verifiedGames:
        verifiedEvents.length,

      aiExpected:
        expectedAISelections,

      aiCreated:
        actualAISelections,

      aiComplete:
        aiComplete,

      errors:
        verificationErrors,

      aiErrors:
        aiErrors

    }

  };


  return res.status(200).json(
    response
  );
}
