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

  // --------------------------------------------------
  // 1. GET UNIQUE EVENTS
  // --------------------------------------------------

  const eventIds = [
    ...new Set(
      selections
        .map(selection =>
          String(selection?.eventId || "").trim()
        )
        .filter(Boolean)
    )
  ];

  // --------------------------------------------------
  // 2. GET VERIFIED SPORTYBET MARKETS
  // --------------------------------------------------

  const marketResults = [];

  for (const eventId of eventIds) {

    try {

      const response = await fetch(
        `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(eventId)}`
      );

      const raw = await response.text();

      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        data = {
          error:
            "SportyBet market service returned an invalid response."
        };
      }

      if (!response.ok) {

        marketResults.push({
          eventId,
          success: false,
          error:
            data?.error ||
            "Unable to retrieve SportyBet markets."
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

  // --------------------------------------------------
  // 3. BUILD VERIFIED EVENTS
  // --------------------------------------------------

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

    if (markets.length === 0) {
      continue;
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

  // --------------------------------------------------
  // 4. STOP IF NOTHING COULD BE VERIFIED
  // --------------------------------------------------

  if (verifiedEvents.length === 0) {

    return res.status(502).json({
      error:
        "SportyBet markets could not be verified for the games in this booking.",
      verifiedGames: 0,
      totalGames: eventIds.length
    });

  }

  // --------------------------------------------------
  // 5. AI PROMPT
  // --------------------------------------------------

  const prompt = `
You are a neutral football betting selection optimizer.

You have TWO types of data:

1. ORIGINAL SELECTIONS
These are the selections already contained in the user's SportyBet booking.

2. VERIFIED SPORTYBET MARKETS
These are markets and outcomes retrieved directly from SportyBet.

Create exactly FOUR profiles:

SAFE
BALANCED
RISKY
AI RECOMMENDED

SAFE:
Reduce overall variance by selecting fewer and/or relatively lower-variance selections from the ORIGINAL SELECTIONS.

You may remove selections.
You may reorder selections.
You may NOT create new selections.

BALANCED:
Create a moderate profile using the ORIGINAL SELECTIONS.

You may remove selections.
You may reorder selections.
You may NOT create new selections.

RISKY:
Keep more of the ORIGINAL SELECTIONS and allow higher overall variance.

You may remove selections.
You may reorder selections.
You may NOT create new selections.

AI RECOMMENDED:
This profile is different.

You MUST provide exactly ONE recommendation for EVERY VERIFIED SPORTYBET EVENT.

If the user has 4 games and all 4 games have verified markets, AI RECOMMENDED MUST contain 4 selections.

If the user has 8 games and all 8 games have verified markets, AI RECOMMENDED MUST contain 8 selections.

There must never be more than ONE AI RECOMMENDED selection for the same event.

For each verified event, choose either:

A. The original selection

OR

B. A different market/outcome that actually exists in the VERIFIED SPORTYBET MARKETS.

You may change the market.

You may change the pick.

You may NOT invent SportyBet data.

Every AI RECOMMENDED selection MUST exactly match a real verified SportyBet market and outcome.

IMPORTANT RULES:

1. Never guarantee a win.
2. Never claim a selection is certain.
3. Never use:
"guaranteed"
"sure win"
"banker"
"certain"
"100%"
"will win"

4. SAFE, BALANCED and RISKY may ONLY contain selections from ORIGINAL SELECTIONS.

5. AI RECOMMENDED may contain selections from VERIFIED SPORTYBET MARKETS.

6. Every AI RECOMMENDED selection MUST have a matching:
eventId
marketId
specifier
outcomeId
odds

7. Preserve exact SportyBet identifiers.

8. Do not alter odds.

9. Do not create an event.

10. Do not create a market.

11. Do not create an outcome.

12. Do not invent a specifier.

13. Never recommend an event that is not present in VERIFIED SPORTYBET MARKETS.

14. Never create more than one recommendation for the same event.

15. Give ONE short reason for every selection.

16. Keep each reason to ONE sentence.

17. Do not make unsupported claims about form, injuries, probability, head-to-head records or expected results unless that information is actually provided.

WRITING STYLE:

Make summaries and reasons sound natural and conversational, like a knowledgeable football fan explaining the ticket to another fan.

Do NOT sound robotic or corporate.

Avoid phrases such as:

"optimize stability"
"lower variance profile"
"selection profile"
"relative variance"
"this profile focuses on"
"this selection has a lower variance"

Prefer natural wording.

Examples:

SAFE:
"I’ve trimmed this down to the less aggressive picks."

BALANCED:
"A middle-ground mix — not too cautious, not too aggressive."

RISKY:
"This keeps more of the action, but there’s less room for mistakes."

AI RECOMMENDED:
"I checked the available SportyBet markets and picked an option for each game."

These are examples of tone only.

Do not repeat the same reason for every selection.

Make each reason specific to the actual market and odds where possible.

OUTPUT FORMAT:

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

SELECTION FORMAT:

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

ORIGINAL SELECTIONS:
${JSON.stringify(selections)}

VERIFIED SPORTYBET MARKETS:
${JSON.stringify(verifiedEvents)}

FINAL RULE:

SAFE, BALANCED and RISKY = ORIGINAL SELECTIONS ONLY.

AI RECOMMENDED = EXACTLY ONE VERIFIED SPORTYBET SELECTION PER VERIFIED GAME.

Return JSON only.
`;

  // --------------------------------------------------
  // 6. CALL GEMINI
  // --------------------------------------------------

  try {

    const result =
      await callGeminiWithFallback(
        prompt,
        apiKey
      );

    // --------------------------------------------------
    // 7. VALIDATE ORIGINAL PROFILES
    // --------------------------------------------------

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
              `AI returned a selection that was not in the original booking for ${profile}.`
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

    // --------------------------------------------------
    // 8. VALIDATE AI RECOMMENDED PROFILE
    // --------------------------------------------------

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

    // AI must return one selection for every verified event.

    if (
      recommendedSelections.length !==
      verifiedEvents.length
    ) {

      return res.status(502).json({
        error:
          `AI RECOMMENDED must contain exactly one recommendation for each verified game. Expected ${verifiedEvents.length}, but AI returned ${recommendedSelections.length}.`
      });

    }

    const recommendedEventIds =
      recommendedSelections.map(
        selection =>
          String(selection?.eventId || "")
      );

    const uniqueRecommendedEventIds =
      new Set(recommendedEventIds);

    // No duplicate games.

    if (
      uniqueRecommendedEventIds.size !==
      recommendedSelections.length
    ) {

      return res.status(502).json({
        error:
          "AI RECOMMENDED contains more than one selection for the same game."
      });

    }

    // Every verified game must have one recommendation.

    for (const event of verifiedEvents) {

      const eventId =
        String(event.eventId);

      if (
        !uniqueRecommendedEventIds.has(eventId)
      ) {

        return res.status(502).json({
          error:
            `AI RECOMMENDED is missing a recommendation for ${event.event}.`
        });

      }

    }

    // --------------------------------------------------
    // 9. VERIFY EVERY AI RECOMMENDED SELECTION
    // --------------------------------------------------

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

      // Replace AI-generated display data with
      // the actual verified SportyBet data.

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

    // --------------------------------------------------
    // 10. RETURN SUCCESS
    // --------------------------------------------------

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

// ======================================================
// GEMINI FALLBACK
// ======================================================

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

// ======================================================
// GEMINI REQUEST
// ======================================================

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
