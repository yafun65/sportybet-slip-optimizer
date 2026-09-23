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

Analyze ONLY the supplied SportyBet selections.

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

IMPORTANT:

1. Never guarantee a win.
2. Never say a selection is certain.
3. Never invent a match.
4. Never invent a market.
5. Never invent a pick.
6. Only use selections supplied by the user.
7. You may remove selections from the original slip.
8. You may reorder selections.
9. You may choose which original selections belong in SAFE, BALANCED and RISKY.
10. DO NOT create a new market.
11. DO NOT create a new pick.
12. DO NOT change the outcome.
13. Every returned selection MUST come directly from the supplied selections.
14. Every returned selection MUST preserve its original eventId.
15. Every returned selection MUST preserve its original marketId.
16. Every returned selection MUST preserve its original specifier.
17. Every returned selection MUST preserve its original outcomeId.
18. Every returned selection MUST preserve its original odds.
19. Every returned selection MUST preserve its original event text.
20. Every returned selection MUST preserve its original market text.
21. Every returned selection MUST preserve its original pick text.
22. The goal is to optimize the slip by selecting, reducing or reordering the supplied selections.
23. Do not change any SportyBet selection identifiers.
24. Do not create selections that are not present in the supplied data.
25. Give a short explanation for why each selected original selection was included in that profile.
26. The explanation must be neutral and must NOT claim that the selection will win.
27. Keep each explanation to ONE short sentence.
28. The explanation should describe the selection's relative variance, odds, market characteristics, or why it fits that profile.
29. Do not use phrases such as "guaranteed", "sure win", "banker", "certain", "will win", or "100%".
30. Return JSON only.

For each profile provide:

- summary
- selections

For every selection provide:

- event
- market
- pick
- odds
- eventId
- marketId
- specifier
- outcomeId
- reason

Use exactly this structure:

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
        "marketId": "",
        "specifier": "",
        "outcomeId": "",
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
        "marketId": "",
        "specifier": "",
        "outcomeId": "",
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
        "marketId": "",
        "specifier": "",
        "outcomeId": "",
        "reason": ""
      }
    ]
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

    const profiles = [
      "SAFE",
      "BALANCED",
      "RISKY"
    ];

    for (const profile of profiles) {

      if (
        !result?.[profile] ||
        typeof result[profile].summary !== "string" ||
        !Array.isArray(result[profile].selections)
      ) {

        return res.status(502).json({
          error:
            "AI returned an invalid optimization result."
        });

      }

      for (
        const optimized
        of result[profile].selections
      ) {

        /*
         * Find the exact original selection.
         *
         * We validate using the SportyBet identifiers
         * rather than relying on the text.
         */

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

        /*
         * Make sure the AI did not change the
         * SportyBet identifiers or odds.
         */

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

        /*
         * Require a reason for every selection.
         */

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

    /*
     * Return the validated AI result.
     */

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

      /*
       * Small delay before trying the next model.
       */

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
