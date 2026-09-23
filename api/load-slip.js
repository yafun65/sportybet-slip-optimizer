export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{4,20}$/.test(code)) {
    return res.status(400).json({
      error: "Please enter a valid SportyBet booking code."
    });
  }

  try {
    const response = await fetch(
      `https://sportybet-api.onrender.com/booking/${encodeURIComponent(code)}`
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error("Load slip error:", error);

    return res.status(500).json({
      error: "Unable to connect to the SportyBet API."
    });
  }
}
