export default async function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const selections = req.body?.selections;

  if (
    !Array.isArray(selections) ||
    selections.length === 0 ||
    selections.length > 100
  ) {
    return res.status(400).json({
      error: "Invalid selections."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Gemini API key is not configured."
    });
  }

  // =====================================================
  // FETCH REAL SPORTYBET MARKETS
  // =====================================================

  const eventIds = [
    ...new Set(
      selections
        .map(selection => String(selection?.eventId || "").trim())
        .filter(Boolean)
    )
  ];

  const marketResults = [];

  for (const eventId of eventIds) {

    try {

      const response = await fetch(
        `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(eventId)}`
      );

      const data = await response.json();

      if (!response.ok) {

        marketResults.push({
          eventId,
          success: false,
          error:
            data?.error ||
            "Unable to retrieve markets."
        });

        continue;
      }

      marketResults.push({
        eventId,
        success: true,
        data
      });

    } catch (error) {

      console.error(
        `Market lookup failed for ${eventId}:`,
        error
      );

      marketResults.push({
        eventId,
        success: false,
        error:
          "Unable to connect to the SportyBet market service."
      });

    }

  }


  // =====================================================
  // PREPARE VERIFIED MARKET DATA FOR GEMINI
  // =====================================================

  const verifiedEvents = [];

  for (const result of marketResults) {

    if (!result.success) {
      continue;
    }

    const eventData = result.data;

    const markets = [];

    for (
      const market
      of Array.isArray(eventData.markets)
        ? eventData.markets
        : []
    ) {

      const outcomes = [];

      for (
        const outcome
        of Array.isArray(market.outcomes)
          ? market.outcomes
          : []
      ) {

        if (outcome.isActive === false) {
          continue;
        }

        outcomes.push({

          outcomeId:
            outcome.outcomeId,

          pick:
            outcome.pick,

          odds:
            outcome.odds

        });

      }

      if (outcomes.length === 0) {
        continue;
      }

      markets.push({

        marketId:
          market.marketId,

        market:
          market.market,

        specifier:
          market.specifier,

        outcomes

      });

    }

    verifiedEvents.push({

      eventId:
        eventData.event?.eventId ||
        result.eventId,

      gameId:
        eventData.event?.gameId ||
        null,

      event:
        `${eventData.event?.homeTeamName || ""} vs ${eventData.event?.awayTeamName || ""}`,

      homeTeamName:
        eventData.event?.homeTeamName ||
        null,

      awayTeamName:
        eventData.event?.awayTeamName ||
        null,

      startTime:
        eventData.event?.startTime ||
        null,

      markets

    });

  }


  // =====================================================
  // GEMINI PROMPT
  // =====================================================

  const prompt = `
You are a neutral sports betting selection optimizer.

You have TWO types of data:

1. ORIGINAL SELECTIONS
These are the selections already contained in the user's SportyBet booking.

2. VERIFIED SPORTYBET MARKETS
These are markets and outcomes retrieved directly from SportyBet for the same events.

Create exactly FOUR profiles:

SAFE
BALANCED
RISKY
AI RECOMMENDED


=====================================================
SAFE
=====================================================

Reduce overall variance by selecting fewer and/or relatively lower-variance selections from the ORIGINAL SELECTIONS.

You may remove selections.

You may reorder selections.

You may NOT create new selections.


=====================================================
BALANCED
=====================================================

Create a moderate profile using the ORIGINAL SELECTIONS.

You may remove selections.

You may reorder selections.

You may NOT create new selections.


=====================================================
RISKY
=====================================================

Keep more of the ORIGINAL SELECTIONS and allow higher overall variance.

You may remove selections.

You may reorder selections.

You may NOT create new selections.


=====================================================
AI RECOMMENDED
=====================================================

This profile is different.

For each event, analyze the VERIFIED SPORTYBET MARKETS.

You may recommend:

A. The original selection, OR

B. A different market/outcome that actually exists in the VERIFIED SPORTYBET MARKETS.

Example:

Original:
Arsenal Win

If the VERIFIED SPORTYBET MARKETS contain:

Over 1.5
marketId = 18
specifier = total=1.5
outcomeId = 12

then you may recommend:

Over 1.5

But ONLY if that exact market and outcome are present in the VERIFIED SPORTYBET MARKETS.

Do NOT invent markets.

Do NOT invent outcomes.

Do NOT invent market IDs.

Do NOT invent outcome IDs.

Do NOT invent specifiers.

Every AI RECOMMENDED selection MUST be copied exactly from the VERIFIED SPORTYBET MARKETS.


=====================================================
IMPORTANT RULES
=====================================================

1. Never guarantee a win.

2. Never claim a selection is certain.

3. Never use phrases such as:
"guaranteed"
"sure win"
"banker"
"certain"
"100%"
"will win"

4. Do not predict with certainty.

5. SAFE, BALANCED and RISKY may ONLY contain selections from ORIGINAL SELECTIONS.

6. AI RECOMMENDED may contain selections from VERIFIED SPORTYBET MARKETS.

7. Every AI RECOMMENDED selection MUST have a matching:
eventId
marketId
specifier
outcomeId
odds

in the VERIFIED SPORTYBET MARKETS.

8. Preserve the exact SportyBet identifiers.

9. Do not alter odds.

10. Do not create an event.

11. Do not create a market.

12. Do not create an outcome.

13. If an event has no VERIFIED SPORTYBET MARKETS, do not invent a recommendation for that event.

14. AI RECOMMENDED does not have to contain every event.

15. Prefer a smaller number of selections when the available alternatives provide a clearer lower-variance profile.

16. Give one short neutral reason for every selection.

17. Keep each reason to ONE sentence.

18. The reason should describe relative variance, market characteristics, odds, or why the selection fits the profile.

19. Return JSON only.

=====================================================
OUTPUT FORMAT
=====================================================

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
  },

  "AI RECOMMENDED": {
    "summary": "",
    "selections": []
  }
}

=====================================================
SELECTION FORMAT
=====================================================

Every selection must contain:

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

=====================================================
ORIGINAL SELECTIONS
=====================================================

${JSON.stringify(selections)}

=====================================================
VERIFIED SPORTYBET MARKETS
=====================================================

${JSON.stringify(verifiedEvents)}

=====================================================

Remember:

SAFE, BALANCED and RISKY = ORIGINAL SELECTIONS ONLY.

AI RECOMMENDED = VERIFIED SPORTYBET MARKETS ONLY.

Return JSON only.
`;


  // =====================================================
  // CALL GEMINI
  // =====================================================

  try {

    const result =
      await callGeminiWithFallback(
        prompt,
        apiKey
      );


    // =====================================================
    // VALIDATE STANDARD PROFILES
    // =====================================================

    const originalProfiles = [
      "SAFE",
      "BALANCED",
      "RISKY"
    ];

    for (
      const profile
      of originalProfiles
    ) {

      if (
        !result?.[profile] ||
        typeof result[profile].summary !== "string" ||
        !Array.isArray(result[profile].selections)
      ) {

        return res.status(502).json({
          error:
            `AI returned an invalid ${profile} profile.`
        });

      }


      for (
        const optimized
        of result[profile].selections
      ) {

        const original =
          selections.find(
            item =>
              String(item.eventId) ===
                String(optimized.eventId) &&
              String(item.marketId) ===
                String(optimized.marketId) &&
              String(item.outcomeId) ===
                String(optimized.outcomeId)
          );


        if (!original) {

          return res.status(502).json({
            error:
              `AI returned a selection that was not in the original slip for ${profile}.`
          });

        }


        if (
          String(optimized.specifier || "") !==
          String(original.specifier || "")
        ) {

          return res.status(502).json({
            error:
              `AI changed the selection specifier for ${profile}.`
          });

        }


        if (
          String(optimized.odds || "") !==
          String(original.odds || "")
        ) {

          return res.status(502).json({
            error:
              `AI changed the selection odds for ${profile}.`
          });

        }


        if (
          typeof optimized.reason !== "string" ||
          optimized.reason.trim().length === 0
        ) {

          return res.status(502).json({
            error:
              `AI did not provide a reason for a selection in ${profile}.`
          });

        }

      }

    }


    // =====================================================
    // VALIDATE AI RECOMMENDED
    // =====================================================

    if (
      !result?.["AI RECOMMENDED"] ||
      typeof result["AI RECOMMENDED"].summary !== "string" ||
      !Array.isArray(
        result["AI RECOMMENDED"].selections
      )
    ) {

      return res.status(502).json({
        error:
          "AI returned an invalid AI RECOMMENDED profile."
      });

    }


    const recommendedSelections =
      result["AI RECOMMENDED"].selections;


    for (
      const recommended
      of recommendedSelections
    ) {

      if (
        typeof recommended.reason !== "string" ||
        recommended.reason.trim().length === 0
      ) {

        return res.status(502).json({
          error:
            "AI RECOMMENDED contains a selection without a reason."
        });

      }


      const event =
        verifiedEvents.find(
          item =>
            String(item.eventId) ===
            String(recommended.eventId)
        );


      if (!event) {

        return res.status(502).json({
          error:
            `AI RECOMMENDED used an event that was not verified by SportyBet: ${recommended.eventId}`
        });

      }


      let verifiedSelection =
        null;


      for (
        const market
        of event.markets
      ) {

        if (
          String(market.marketId) !==
          String(recommended.marketId)
        ) {
          continue;
        }


        if (
          String(market.specifier || "") !==
          String(recommended.specifier || "")
        ) {
          continue;
        }


        const outcome =
          market.outcomes.find(
            item =>
              String(item.outcomeId) ===
              String(recommended.outcomeId)
          );


        if (outcome) {

          verifiedSelection = {

            event:
              event.event,

            market:
              market.market,

            pick:
              outcome.pick,

            odds:
              outcome.odds,

            eventId:
              event.eventId,

            marketId:
              market.marketId,

            specifier:
              market.specifier,

            outcomeId:
              outcome.outcomeId

          };

          break;

        }

      }


      if (!verifiedSelection) {

        return res.status(502).json({
          error:
            `AI RECOMMENDED invented or changed a SportyBet selection for ${recommended.event || recommended.eventId}.`
        });

      }


      // Force the verified SportyBet data into
      // the final response.

      recommended.event =
        verifiedSelection.event;

      recommended.market =
        verifiedSelection.market;

      recommended.pick =
        verifiedSelection.pick;

      recommended.odds =
        verifiedSelection.odds;

      recommended.eventId =
        verifiedSelection.eventId;

      recommended.marketId =
        verifiedSelection.marketId;

      recommended.specifier =
        verifiedSelection.specifier;

      recommended.outcomeId =
        verifiedSelection.outcomeId;

    }


    // =====================================================
    // RETURN FINAL RESULT
    // =====================================================

    return res.status(200).json(result);

  } catch (error) {

    console.error(
      "Gemini optimization error:",
      error
    );

    return res.status(500).json({

      error:
        error.message ||
        "AI optimization failed."

    });

  }

}


// =====================================================
// GEMINI FALLBACK SYSTEM
// =====================================================

async function callGeminiWithFallback(
  prompt,
  apiKey
) {

  const models = [
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite"
  ];

  let lastError = null;


  for (
    const model
    of models
  ) {

    console.log(
      `Trying Gemini model: ${model}`
    );


    try {

      return await callGemini(
        prompt,
        apiKey,
        model
      );

    } catch (error) {

      lastError = error;

      console.error(
        `${model} failed:`,
        error.message
      );


      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1500
          )
      );

    }

  }


  throw (
    lastError ||
    new Error(
      "All Gemini models failed."
    )
  );

}


// =====================================================
// GEMINI REQUEST
// =====================================================

async function callGemini(
  prompt,
  apiKey,
  model
) {

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;


  const response =
    await fetch(
      endpoint,
      {

        method:
          "POST",

        headers:
          {
            "Content-Type":
              "application/json"
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
                "application/json"

            }

          })

      }
    );


  const raw =
    await response.text();


  if (!response.ok) {

    throw new Error(
      `Gemini ${model} returned HTTP ${response.status}: ${raw.slice(0, 500)}`
    );

  }


  let data;


  try {

    data =
      JSON.parse(raw);

  } catch {

    throw new Error(
      `Gemini ${model} returned a non-JSON response.`
    );

  }


  const text =
    data?.candidates?.[0]
      ?.content
      ?.parts?.[0]
      ?.text;


  if (!text) {

    throw new Error(
      `Gemini ${model} returned no usable AI response.`
    );

  }


  try {

    return JSON.parse(text);

  } catch {

    throw new Error(
      `Gemini ${model} returned invalid JSON.`
    );

  }

}
