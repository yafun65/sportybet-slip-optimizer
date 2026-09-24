export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed"
    });
  }

  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{4,20}$/.test(code)) {
    return res.status(400).json({
      success: false,
      error: "Please enter a valid SportyBet booking code."
    });
  }

  try {
    const response = await fetch(
      `https://sportybet-api.onrender.com/booking/${encodeURIComponent(code)}`
    );

    const raw = await response.text();

    let data;

    try {
      data = JSON.parse(raw);
    } catch (error) {
      console.error("Invalid JSON from SportyBet API:", raw);

      return res.status(502).json({
        success: false,
        error: "The SportyBet API returned an invalid response."
      });
    }

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error:
          data?.error ||
          data?.message ||
          "Unable to load the SportyBet booking."
      });
    }

    /*
     * The SportyBet API already returns the selections
     * directly inside data.selections.
     */

    if (
      !Array.isArray(data?.selections) ||
      data.selections.length === 0
    ) {
      console.error(
        "Booking loaded but no selections were returned:",
        data
      );

      return res.status(422).json({
        success: false,
        error:
          "The booking was found, but it contains no selections."
      });
    }

    /*
     * Pass the selections directly to the frontend.
     * No additional parsing is necessary.
     */

    return res.status(200).json({
      success: true,

      shareCode:
        data.shareCode || code,

      shareURL:
        data.shareURL || null,

      deadline:
        data.deadline || null,

      selections:
        data.selections
    });

  } catch (error) {
    console.error("Load slip error:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to connect to the SportyBet API."
    });
  }
}
