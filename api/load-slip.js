export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const text = req.body?.text;

  if (!text || typeof text !== "string" || text.trim().length < 10) {
    return res.status(400).json({
      error: "Please paste your SportyBet slip details first."
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Gemini API key is not configured."
    });
  }

  const prompt = `
You extract football betting selections from user-provided SportyBet slip text.

Do NOT invent matches, teams, markets, picks, odds, or dates.

Extract ONLY information that is clearly present in the supplied text.

Return JSON only using exactly this structure:

{
  "selections": [
    {
      "event": "",
      "market": "",
      "pick": "",
      "odds": null,
      "date": ""
    }
  ]
}

Rules:
- "event" should contain the two teams if available.
- "market" should describe the betting market.
- "pick" should contain the selected outcome.
- "odds" should be a number if clearly available, otherwise null.
- "date" should be included if clearly available, otherwise "".
- Ignore account information, balance, payment information, promotional text and unrelated content.
- Do not create missing information.
- If no football selections can be identified, return:
  {"selections":[]}

SportyBet slip text:

${text}
`;

  try {
    const result = await callGemini(prompt, apiKey);

    if (!result || !Array.isArray(result.selections)) {
      return res.status(502).json({
        error: "AI could not extract the selections."
      });
    }

    return res.status(200).json(result);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Could not extract the slip. Please try again."
    });
  }
}

async function callGemini(prompt, apiKey) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
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

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "Gemini request failed."
    );
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  return JSON.parse(text);
}
