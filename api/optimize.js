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


  const prompt = `
You are a neutral sports betting-slip optimizer.

Analyze ONLY the supplied selections.

Create exactly three profiles:

SAFE
BALANCED
RISKY

SAFE:
Reduce overall variance by selecting fewer or less volatile selections from the supplied slip.

BALANCED:
Keep a moderate number of selections and moderate variance.

RISKY:
Keep more selections and allow higher overall variance.

IMPORTANT FOR SPORTYBET BOOKING:

1. Never guarantee a win.
2. Never say a selection is certain.
3. Never invent a match.
4. Only use events supplied by the user.
5. You may remove selections from the original slip.
6. You may reorder the remaining selections.
7. You may choose which original selections belong in SAFE, BALANCED and RISKY.
8. DO NOT create a new market.
9. DO NOT create a new pick.
10. DO NOT change the outcome.
11. Every returned selection MUST come directly from the supplied selections.
12. Every returned selection MUST preserve its original eventId.
13. Every returned selection MUST preserve its original marketId.
14. Every returned selection MUST preserve its original specifier.
15. Every returned selection MUST preserve its original outcomeId.
16. Every returned selection MUST preserve its original odds.
17. Every returned selection MUST preserve its original event, market and pick text.
18. The goal is to optimize the slip by selecting/reducing the supplied selections, NOT by inventing new SportyBet selections.
19. Return JSON only.

For each profile provide:

- summary
- selections
- event
- market
- pick
- odds
- eventId
- marketId
- specifier
- outcomeId

Use exactly this structure:

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

SUPPLIED SELECTIONS:

${JSON.stringify(selections)}
`;


  try {

    const result =
      await callGeminiWithFallback(
        prompt,
        apiKey
      );


    const profiles =
      ["SAFE", "BALANCED", "RISKY"];


    for (const profile of profiles) {

      if (
        !result?.[profile] ||
        typeof result[profile].summary !== "string" ||
        !Array.isArray(
          result[profile].selections
        )
      ) {

        return res.status(502).json({
          error:
            "AI returned an invalid optimization result."
        });

      }


      // Make absolutely sure every AI selection
      // came from the original supplied selections.

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

      }

    }


    return res.status(200).json(result);


  } catch (error) {

    console.error(
      "Gemini error:",
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


  for (const model of models) {

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


      // Wait briefly before trying
      // the next model.

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1500
          )
      );

    }

  }


  throw lastError ||
    new Error(
      "All Gemini models failed."
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
