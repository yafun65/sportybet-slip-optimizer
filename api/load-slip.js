export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();

  const url =
    `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json, text/plain, */*",
        "Current-Country": "NG",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
      }
    });

    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(200).json({
        DEBUG: true,
        httpStatus: response.status,
        responseType: "NOT_JSON",
        responsePreview: raw.substring(0, 3000)
      });
    }

    return res.status(200).json({
      DEBUG: true,
      httpStatus: response.status,
      topLevelKeys: Object.keys(data || {}),
      dataType: typeof data?.data,
      dataKeys:
        data?.data && typeof data.data === "object"
          ? Object.keys(data.data)
          : [],
      outcomeCount:
        Array.isArray(data?.data?.outcomes)
          ? data.data.outcomes.length
          : null,
      firstOutcome:
        Array.isArray(data?.data?.outcomes) &&
        data.data.outcomes.length > 0
          ? data.data.outcomes[0]
          : null
    });

  } catch (error) {
    return res.status(500).json({
      DEBUG: true,
      error: error.message
    });
  }
}
