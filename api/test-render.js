export default async function handler(req, res) {
  try {
    const eventId = "sr:match:68932720";

    const response = await fetch(
      `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(eventId)}`
    );

    const data = await response.json();

    return res.status(200).json({
      success: true,
      renderStatus: response.status,
      renderOk: response.ok,
      marketCount: Array.isArray(data?.markets)
        ? data.markets.length
        : 0,
      firstMarket: data?.markets?.[0] || null
    });

  } catch (error) {
    return res.status(200).json({
      success: false,
      error: error?.message || String(error)
    });
  }
}

Deploy it, then open:

"Test Vercel → Render connection" (https://reference-url-citation.invalid/0)

Send me the result

We're looking for something like:

{
  "success": true,
  "renderStatus": 200,
  "renderOk": true,
  "marketCount": 41,
  "firstMarket": {
    "marketId": "1",
    "market": "1X2"
  }
}

If we get that, we've isolated the problem to the optimizer/Gemini stage, and I'll fix that part next.
