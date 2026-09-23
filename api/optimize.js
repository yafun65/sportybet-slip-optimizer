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

IMPORTANT RULES:

1. Never guarantee a win.
2. Never say a selection is certain.
3. Never invent a match or event.
4. Only use the supplied events.
5. Keep every recommendation tied to a supplied event.
6. If changing a market or pick, it must be realistic for that same event.
7. Do not assume the sport is football.
8. Analyze the actual sport supplied.
9. Return JSON only.

Use exactly this structure:

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

      // Wait progressively longer before retrying.
      const delay =
        attempt === 1
          ? 1500
          : attempt === 2
            ? 3000
            : 6000;

      await new Promise(resolve =>
        setTimeout(resolve, delay)
      );
    }
  }
}


async function callGemini(prompt, apiKey) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=" +
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

  console.log(
    "Gemini HTTP status:",
    response.status
  );

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
