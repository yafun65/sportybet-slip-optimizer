export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const code = String(req.body?.code || "").trim();

  if (!/^[A-Za-z0-9._-]{4,40}$/.test(code)) {
    return res.status(400).json({
      error: "Invalid SportyBet sharing code."
    });
  }

  const url =
    `https://www.sportybet.com/ng/?shareCode=${encodeURIComponent(code)}`;

  try {
    const page = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      },
      redirect: "follow"
    });

    const html = await page.text();

    if (!page.ok) {
      return res.status(502).json({
        error: `SportyBet returned HTTP ${page.status}.`
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error: "Gemini API key is not configured."
      });
    }

    const prompt = `
Extract football betting selections from this publicly accessible SportyBet share page.

Return JSON only in this format:

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

1. Do not invent selections.
2. Only use information actually present in the page.
3. If selections cannot be found, return:
   {"selections":[]}

Page content:

${html.slice(0, 60000)}
`;

    const aiResult =
      await callGemini(prompt, apiKey);

    const selections =
      Array.isArray(aiResult?.selections)
        ? aiResult.selections
        : [];

    if (!selections.length) {
      return res.status(422).json({
        error:
          "The SportyBet share page could not be read. SportyBet may require JavaScript or may have changed its page format."
      });
    }

    return res.status(200).json({
      platform: "SportyBet",
      code,
      selections
    });

  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error:
        "Unable to load the SportyBet slip right now."
    });
  }
}


async function callGemini(prompt, apiKey) {

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);

  const response =
    await fetch(endpoint, {

      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
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
          responseMimeType:
            "application/json"
        }

      })

    });


  const data =
    await response.json();


  if (!response.ok) {

    throw new Error(
      data?.error?.message ||
      "Gemini request failed."
    );

  }


  const text =
    data?.candidates?.[0]
      ?.content
      ?.parts?.[0]
      ?.text || "{}";


  return JSON.parse(text);
}
