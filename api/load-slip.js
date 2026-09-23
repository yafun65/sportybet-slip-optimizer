export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();

  if (!code) {
    return res.status(400).json({
      error: "Booking code is required."
    });
  }

  const url =
    `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Current-Country": "NG"
      }
    });

    const raw = await response.text();

    return res.status(200).json({
      debug: true,
      code,
      httpStatus: response.status,
      contentType: response.headers.get("content-type"),
      responseLength: raw.length,
      responseStart: raw.substring(0, 5000)
    });

  } catch (error) {
    return res.status(500).json({
      debug: true,
      error: error.message
    });
  }
}
