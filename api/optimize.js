export const maxDuration = 60;

const RENDER_BASE =
  "https://sportybet-api.onrender.com";


// ==========================================================
// MAIN HANDLER
// ==========================================================

export default async function handler(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({
      success: false,
      error: "POST required"
    });

  }


  try {

    const selections =
      Array.isArray(req.body?.selections)
        ? req.body.selections
        : [];


    if (!selections.length) {

      return res.status(400).json({
        success: false,
        error: "No selections were received."
      });

    }


    // ------------------------------------------------------
    // REMOVE DUPLICATE EVENTS
    // ------------------------------------------------------

    const uniqueSelections =
      [];

    const seenEvents =
      new Set();


    for (const selection of selections) {

      const eventId =
        String(
          selection?.eventId || ""
        );


      if (
        !eventId ||
        seenEvents.has(eventId)
      ) {

        continue;

      }


      seenEvents.add(eventId);

      uniqueSelections.push(
        selection
      );

    }


    if (!uniqueSelections.length) {

      return res.status(400).json({
        success: false,
        error: "No valid event IDs were received."
      });

    }


    // ------------------------------------------------------
    // FETCH REAL SPORTYBET MARKETS
    // ------------------------------------------------------

    const eventIds =
      uniqueSelections
        .map(
          selection =>
            String(
              selection.eventId
            )
        );


    const query =
      eventIds
        .map(
          id =>
            encodeURIComponent(id)
        )
        .join(",");


    const marketsURL =
      `${RENDER_BASE}/event-markets?eventIds=${query}`;


    const marketsResponse =
      await fetch(
        marketsURL
      );


    const marketsText =
      await marketsResponse.text();


    let marketsData;


    try {

      marketsData =
        JSON.parse(
          marketsText
        );

    } catch {

      throw new Error(
        "SportyBet market service returned invalid JSON."
      );

    }


    if (
      !marketsResponse.ok ||
      !Array.isArray(
        marketsData?.results
      )
    ) {

      throw new Error(
        marketsData?.error ||
        "Could not retrieve SportyBet markets."
      );

    }


    // ------------------------------------------------------
    // CREATE MARKET MAP
    // ------------------------------------------------------

    const marketMap =
      new Map();


    for (
      const result
      of marketsData.results
    ) {

      if (
        result?.success !== false &&
        result?.eventId
      ) {

        marketMap.set(
          String(
            result.eventId
          ),
          result
        );

      }

    }


    // ------------------------------------------------------
    // BUILD VERIFIED ORIGINAL SELECTIONS
    // ------------------------------------------------------

    const verifiedOriginal =
      [];


    for (
      const selection
      of uniqueSelections
    ) {

      const eventId =
        String(
          selection.eventId
        );


      const eventData =
        marketMap.get(
          eventId
        );


      if (
        !eventData ||
        !Array.isArray(
          eventData.markets
        )
      ) {

        continue;

      }


      const originalMarket =
        eventData.markets.find(
          market =>
            String(
              market.marketId
            ) ===
              String(
                selection.marketId
              ) &&
            String(
              market.specifier ?? ""
            ) ===
              String(
                selection.specifier ?? ""
              )
        );


      if (!originalMarket) {

        continue;

      }


      const originalOutcome =
        originalMarket.outcomes?.find(
          outcome =>
            String(
              outcome.outcomeId
            ) ===
              String(
                selection.outcomeId
              )
        );


      if (!originalOutcome) {

        continue;

      }


      verifiedOriginal.push({

        ...selection,

        odds:
          Number(
            originalOutcome.odds
          ),

        marketId:
          String(
            originalMarket.marketId
          ),

        specifier:
          originalMarket.specifier ??
          null,

        outcomeId:
          String(
            originalOutcome.outcomeId
          )

      });

    }


    if (!verifiedOriginal.length) {

      return res.status(400).json({
        success: false,
        error:
          "None of the original selections could be verified against SportyBet markets."
      });

    }


    // ------------------------------------------------------
    // SAFE / BALANCED / RISKY
    // ------------------------------------------------------

    /*
     * Lower odds are treated as less aggressive for
     * profile construction only.
     *
     * This does NOT mean they are guaranteed.
     */

    const sorted =
      [...verifiedOriginal]
        .sort(
          (a, b) =>
            Number(a.odds || 999) -
            Number(b.odds || 999)
        );


    const total =
      sorted.length;


    const safeCount =
      Math.max(
        1,
        Math.ceil(
          total * 0.5
        )
      );


    const balancedCount =
      Math.max(
        1,
        Math.ceil(
          total * 0.75
        )
      );


    const safeSelections =
      sorted.slice(
        0,
        safeCount
      );


    const balancedSelections =
      sorted.slice(
        0,
        balancedCount
      );


    const riskySelections =
      [...sorted];


    // ------------------------------------------------------
    // AI RECOMMENDED
    // ------------------------------------------------------

    let aiSelections =
      [];


    try {

      aiSelections =
        await createAIRecommendations(
          uniqueSelections,
          marketMap
        );

    } catch (error) {

      console.error(
        "Gemini error:",
        error
      );

    }


    // ------------------------------------------------------
    // ENSURE ONE AI SELECTION PER EVENT
    // ------------------------------------------------------

    aiSelections =
      fillMissingAISelections(
        uniqueSelections,
        aiSelections,
        marketMap
      );


    // ------------------------------------------------------
    // RESPONSE
    // ------------------------------------------------------

    return res.status(200).json({

      success: true,

      profiles: {

        SAFE: {

          summary:
            "I’ve trimmed this down to the less aggressive picks.",

          selections:
            safeSelections.map(
              selection =>
                addReason(
                  selection,
                  "The original pick carries smaller odds than the more aggressive selections."
                )
            )

        },


        BALANCED: {

          summary:
            "A middle-ground mix — not too cautious, not too aggressive.",

          selections:
            balancedSelections.map(
              selection =>
                addReason(
                  selection,
                  "This keeps the original pick while leaving out some of the more aggressive selections."
                )
            )

        },


        RISKY: {

          summary:
            "This keeps more of the action, but there’s less room for mistakes.",

          selections:
            riskySelections.map(
              selection =>
                addReason(
                  selection,
                  "The higher number of selections means more picks need to land."
                )
            )

        },


        "AI RECOMMENDED": {

          summary:
            "I looked at the available SportyBet markets and picked the options that fit the games better.",

          selections:
            aiSelections

        }

      }

    });


  } catch (error) {

    console.error(
      "Optimizer error:",
      error
    );


    return res.status(500).json({

      success: false,

      error:
        error?.message ||
        "Optimizer failed."

    });

  }

}


// ==========================================================
// GEMINI
// ==========================================================

async function createAIRecommendations(
  originalSelections,
  marketMap
) {

  const apiKey =
    process.env.GEMINI_API_KEY;


  if (!apiKey) {

    throw new Error(
      "GEMINI_API_KEY is not configured."
    );

  }


  // --------------------------------------------------------
  // CREATE A SMALL, CLEAN MARKET LIST
  // --------------------------------------------------------

  const events =
    originalSelections.map(
      selection => {

        const eventData =
          marketMap.get(
            String(
              selection.eventId
            )
          );


        const availableMarkets =
          [];


        for (
          const market
          of (
            eventData?.markets ||
            []
          )
        ) {

          if (
            !Array.isArray(
              market.outcomes
            )
          ) {

            continue;

          }


          for (
            const outcome
            of market.outcomes
          ) {

            if (
              outcome?.isActive === false
            ) {

              continue;

            }


            availableMarkets.push({

              marketId:
                String(
                  market.marketId
                ),

              market:
                market.market,

              specifier:
                market.specifier ??
                null,

              outcomeId:
                String(
                  outcome.outcomeId
                ),

              pick:
                outcome.pick,

              odds:
                Number(
                  outcome.odds
                )

            });

          }

        }


        return {

          eventId:
            String(
              selection.eventId
            ),

          event:
            selection.event,

          originalMarket:
            selection.market,

          originalPick:
            selection.pick,

          originalOdds:
            Number(
              selection.odds
            ),

          availableMarkets

        };

      }
    );


  // --------------------------------------------------------
  // LIMIT PROMPT SIZE
  // --------------------------------------------------------

  const compactEvents =
    events.map(
      event => ({

        eventId:
          event.eventId,

        event:
          event.event,

        original:
          {
            market:
              event.originalMarket,

            pick:
              event.originalPick,

            odds:
              event.originalOdds
          },

        markets:
          event.availableMarkets.slice(
            0,
            80
          )

      })
    );


  const prompt = `

You are helping analyze a football betting selection list.

Your job is NOT to predict guaranteed winners.

For EVERY event below, choose exactly ONE available SportyBet market/outcome.

There must be exactly ONE recommendation for every unique event.

IMPORTANT:
- Only choose a market and outcome that appears in the supplied availableMarkets list.
- Never invent marketId.
- Never invent outcomeId.
- Never invent specifier.
- Never create a market that is not supplied.
- Keep the recommendation tied to the same eventId.
- Prefer straightforward markets over complicated ones when several reasonable options are available.
- The goal is to give a different, practical way to approach each game.
- Do not make claims about form, injuries, probability or match outcome because those facts were not supplied.

Return JSON only.

Required format:

{
  "recommendations": [
    {
      "eventId": "exact event ID",
      "marketId": "exact market ID",
      "specifier": null,
      "outcomeId": "exact outcome ID",
      "reason": "One short natural sentence explaining the alternative."
    }
  ]
}

STYLE:

Make the reasons sound natural and human, like a knowledgeable football fan explaining the ticket to another fan.

Do not use robotic or corporate phrases such as:
- optimize stability
- lower variance profile
- selection profile
- relative variance
- this profile focuses on
- this selection has a lower variance

Prefer short conversational reasons.

DATA:

${JSON.stringify(
  compactEvents
)}

`;


  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(
      apiKey
    );


  const response =
    await fetch(
      endpoint,
      {

        method: "POST",

        headers: {
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

              temperature:
                0.2,

              responseMimeType:
                "application/json"

            }

          })

      }
    );


  const text =
    await response.text();


  if (!response.ok) {

    throw new Error(
      "Gemini request failed: " +
      text.slice(
        0,
        500
      )
    );

  }


  let data;


  try {

    data =
      JSON.parse(
        text
      );

  } catch {

    throw new Error(
      "Gemini returned invalid JSON."
    );

  }


  const generatedText =
    data
      ?.candidates?.[0]
      ?.content
      ?.parts?.[0]
      ?.text;


  if (!generatedText) {

    throw new Error(
      "Gemini returned no recommendation text."
    );

  }


  let parsed;


  try {

    parsed =
      JSON.parse(
        generatedText
      );

  } catch {

    throw new Error(
      "Gemini recommendation was not valid JSON."
    );

  }


  if (
    !Array.isArray(
      parsed?.recommendations
    )
  ) {

    throw new Error(
      "Gemini returned no recommendations."
    );

  }


  // --------------------------------------------------------
  // VALIDATE EVERY GEMINI PICK
  // --------------------------------------------------------

  const validated =
    [];


  for (
    const recommendation
    of parsed.recommendations
  ) {

    const eventId =
      String(
        recommendation?.eventId ||
        ""
      );


    const eventData =
      marketMap.get(
        eventId
      );


    if (!eventData) {
      continue;
    }


    const market =
      eventData.markets?.find(
        item =>
          String(
            item.marketId
          ) ===
            String(
              recommendation.marketId
            ) &&
          String(
            item.specifier ?? ""
          ) ===
            String(
              recommendation.specifier ?? ""
            )
      );


    if (!market) {
      continue;
    }


    const outcome =
      market.outcomes?.find(
        item =>
          String(
            item.outcomeId
          ) ===
            String(
              recommendation.outcomeId
            )
      );


    if (!outcome) {
      continue;
    }


    if (
      outcome.isActive === false
    ) {
      continue;
    }


    const original =
      originalSelections.find(
        selection =>
          String(
            selection.eventId
          ) === eventId
      );


    validated.push({

      event:
        original?.event ||
        `${eventData.event?.homeTeamName || ""} vs ${eventData.event?.awayTeamName || ""}`,

      market:
        market.market,

      pick:
        outcome.pick,

      odds:
        Number(
          outcome.odds
        ),

      eventId,

      gameId:
        String(
          original?.gameId ||
          eventData.event?.gameId ||
          ""
        ),

      marketId:
        String(
          market.marketId
        ),

      specifier:
        market.specifier ??
        null,

      outcomeId:
        String(
          outcome.outcomeId
        ),

      reason:
        recommendation.reason ||
        "This alternative is available on SportyBet and gives a different way to approach the game."

    });

  }


  return validated;

}


// ==========================================================
// FILL MISSING AI EVENTS
// ==========================================================

function fillMissingAISelections(
  originalSelections,
  aiSelections,
  marketMap
) {

  const result =
    [];


  const alreadyUsed =
    new Set();


  // Keep validated AI picks first.

  for (
    const selection
    of aiSelections
  ) {

    const eventId =
      String(
        selection.eventId
      );


    if (
      alreadyUsed.has(
        eventId
      )
    ) {

      continue;

    }


    alreadyUsed.add(
      eventId
    );

    result.push(
      selection
    );

  }


  // Fill every missing event with its
  // original verified SportyBet selection.

  for (
    const original
    of originalSelections
  ) {

    const eventId =
      String(
        original.eventId
      );


    if (
      alreadyUsed.has(
        eventId
      )
    ) {

      continue;

    }


    const eventData =
      marketMap.get(
        eventId
      );


    if (!eventData) {
      continue;
    }


    const market =
      eventData.markets?.find(
        item =>
          String(
            item.marketId
          ) ===
            String(
              original.marketId
            ) &&
          String(
            item.specifier ?? ""
          ) ===
            String(
              original.specifier ?? ""
            )
      );


    if (!market) {
      continue;
    }


    const outcome =
      market.outcomes?.find(
        item =>
          String(
            item.outcomeId
          ) ===
            String(
              original.outcomeId
            )
      );


    if (!outcome) {
      continue;
    }


    result.push({

      ...original,

      odds:
        Number(
          outcome.odds
        ),

      marketId:
        String(
          market.marketId
        ),

      specifier:
        market.specifier ??
        null,

      outcomeId:
        String(
          outcome.outcomeId
        ),

      reason:
        "The original SportyBet selection was kept because it could be verified for this game."

    });


    alreadyUsed.add(
      eventId
    );

  }


  return result;

}


// ==========================================================
// ADD REASON
// ==========================================================

function addReason(
  selection,
  reason
) {

  return {

    ...selection,

    reason

  };

      }
