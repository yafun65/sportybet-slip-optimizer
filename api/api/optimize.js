export default async function handler(req, res) {

  if (req.method !== "POST") {

    return res.status(405).json({
      error: "Method not allowed"
    });

  }


  const selections =
    req.body?.selections;


  if (
    !Array.isArray(selections) ||
    selections.length === 0 ||
    selections.length > 100
  ) {

    return res.status(400).json({
      error: "Invalid selections."
    });

  }


  const apiKey =
    process.env.GEMINI_API_KEY;


  if (!apiKey) {

    return res.status(500).json({
      error:
        "Gemini API key is not configured."
    });

  }


  const prompt = `

You are a neutral football betting-slip optimizer.

Analyze ONLY the supplied selections.

Produce exactly three profiles:

SAFE
BALANCED
RISKY

SAFE:
Reduce overall variance where reasonably possible.

BALANCED:
Keep a moderate level of risk.

RISKY:
Allow more ambitious or higher-variance selections.

IMPORTANT RULES:

1. Do not guarantee winning.
2. Do not claim any selection is certain.
3. Do not invent unrelated football matches.
4. Only use the supplied events.
5. If changing a selection, briefly explain the reasoning in the summary.
6. Keep the output realistic.
7. Return JSON only.

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

Here are the supplied selections:

${JSON.stringify(selections)}

`;


  try {

    const result =
      await callGemini(
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
        !Array.isArray(
          result[profile].selections
        )
      ) {

        return res.status(502).json({
          error:
            "AI returned an invalid optimization result."
        });

      }

    }


    return res.status(200).json(result);


  } catch (error) {

    console.error(error);

    return res.status(500).json({
      error:
        "AI optimization failed. Please try again."
    });

  }

}


async function callGemini(
  prompt,
  apiKey
) {

  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(apiKey);


  const response =
    await fetch(
      endpoint,
      {

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

      }
    );


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
