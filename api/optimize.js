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

Analyze ONLY the selections supplied below.

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

IMPORTANT RULES:

1. Never guarantee a win.
2. Never say a selection is certain.
3. Never invent a match or event.
4. Only use the supplied events.
5. Keep every recommendation tied to a supplied event.
6. If you change a market or pick, it must be a realistic alternative for that same event.
7. Keep the number of selections reasonable.
8. Provide a short explanation for each profile.
9. Return JSON only.
10. This can contain football, rugby, or other sports. Analyze the supplied sport rather than assuming it is football.

Use exactly this JSON structure:

{
  "SAFE": {
    "summary": "",
    "selections": [
      {
        "event": "",
        "market": "",
        "pick": "",
        "odds": null
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
        "odds": null
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
        "odds": null
      }
    ]
  }
}

SUPPLIED SELECTIONS:

${JSON.stringify(selections)}
`;

  try {
    const result = await callGemini(prompt, apiKey);

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

  console.log("Gemini HTTP status:", response.status);
  console.log("Gemini response:", raw);

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
