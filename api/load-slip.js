export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const input = String(req.body?.code || "").trim();

  if (!input) {
    return res.status(400).json({
      error: "Paste a SportyBet sharing code or share link."
    });
  }

  // Accept either:
  // LDC709
  // or https://www.sportybet.com/ng/?shareCode=LDC709
  let code = input;

  try {
    if (input.includes("sportybet.com")) {
      const url = new URL(input);
      code = url.searchParams.get("shareCode") || "";
    }
  } catch {
    return res.status(400).json({
      error: "The SportyBet link is not valid."
    });
  }

  code = code.trim();

  if (!/^[A-Za-z0-9._-]{4,40}$/.test(code)) {
    return res.status(400).json({
      error: "Invalid SportyBet sharing code."
    });
  }

  const shareUrl =
    `https://www.sportybet.com/ng/?shareCode=${encodeURIComponent(code)}`;

  try {
    const response = await fetch(shareUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language":
          "en-US,en;q=0.9"
      }
    });

    const html = await response.text();

    // SportyBet is blocking the server request.
    if (response.status === 403) {
      return res.status(403).json({
        error:
          "SportyBet blocked the server request (HTTP 403). The sharing link is valid, but SportyBet is preventing our server from reading the page."
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        error:
          `SportyBet returned HTTP ${response.status}.`
      });
    }

    if (!html || html.length < 100) {
      return res.status(422).json({
        error:
          "SportyBet returned an empty or unreadable page."
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        error:
          "Gemini API key is not configured."
      });
    }

    const prompt = `
You are extracting football betting selections from a SportyBet
public sharing page.

Return JSON ONLY.

Required format:

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

1. Only extract selections actually present in the supplied page.
2. Do not invent matches.
3. Do not invent odds.
4. Do not add unrelated football matches.
5. If no selections can be identified, return:
   {"selections":[]}

SportyBet share code:
${code}

Page content:
${html.slice(0, 60000)}
`;

    const result =
      await callGemini(prompt, apiKey);

    const selections =
      Array.isArray(result?.selections)
        ? result.selections
        : [];

    if (!selections.length) {
      return res.status(422).json({
        error:
          "The page was reached, but no readable selections were found."
      });
    }

    return res.status(200).json({
      platform: "SportyBet",
      code,
      shareUrl,
      selections
    });

  } catch (error) {

    console.error("LOAD SLIP ERROR:", error);

    return res.status(500).json({
      error:
        "Unable to retrieve the SportyBet slip."
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
