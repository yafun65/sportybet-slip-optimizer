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
Reduce overall variance where reasonably possible.

BALANCED:
Keep a moderate level of risk.

RISKY:
Allow more ambitious and higher-variance selections.

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
18. The goal is to optimize the slip by reducing or selecting from the original selections, NOT by inventing new SportyBet selections.
19. Return JSON only.
For each profile, provide:
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
    "selections": [
      {
        "event": "",
        "market": "",
        "pick": "",
        "odds": null,
        "eventId": null,
        "marketId": null,
        "specifier": null,
        "outcomeId": null
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
        "odds": null,
        "eventId": null,
        "marketId": null,
        "specifier": null,
        "outcomeId": null
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
        "odds": null,
        "eventId": null,
        "marketId": null,
        "specifier": null,
        "outcomeId": null
      }
    ]
  }
}

SUPPLIED SELECTIONS:

${JSON.stringify(selections)}
`;

  try {
    const result = await callGeminiWithRetry(prompt, apiKey);

    const profiles = ["SAFE", "BALANCED", "RISKY"];

    for (const profile of profiles) {
      if (
        !result?.[profile] ||
        typeof result[profile].summary !== "string" ||
        !Array.isArray(result[profile].selections)
      ) {
        return res.status(502).json({
          error: "AI returned an invalid optimization result."
        });
      }
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error("Gemini error:", error);

    return res.status(500).json({
      error: error.message || "AI optimization failed."
    });
  }
}


async function callGeminiWithRetry(prompt, apiKey) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {

    try {
      return await callGemini(prompt, apiKey);

    } catch (error) {

      console.error(
        `Gemini attempt ${attempt} failed:`,
        error.message
      );

      if (attempt === maxAttempts) {
        throw error;
      }

      const delay =
        attempt === 1
          ? 1500
          : 3000;

      await new Promise(resolve =>
        setTimeout(resolve, delay)
      );
    }
  }
}


async function callGemini(prompt, apiKey) {

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

  const response = await fetch(endpoint, {

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

  });

  const raw = await response.text();

  if (!response.ok) {

    throw new Error(
      `Gemini returned HTTP ${response.status}: ${raw.slice(0, 500)}`
    );

  }

  let data;

  try {

    data = JSON.parse(raw);

  } catch {

    throw new Error(
      "Gemini returned a non-JSON response."
    );

  }

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {

    throw new Error(
      "Gemini returned no usable AI response."
    );

  }

  try {

    return JSON.parse(text);

  } catch {

    throw new Error(
      "Gemini returned invalid JSON."
    );

  }
}
