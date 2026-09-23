export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const code = String(req.body?.code || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{4,20}$/.test(code)) {
    return res.status(400).json({
      error: "Please enter a valid SportyBet booking code."
    });
  }

  const url =
    `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Current-Country": "NG"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "SportyBet could not load this booking code."
      });
    }

    if (data?.bizCode !== 10000 && data?.status !== "success") {
      return res.status(404).json({
        error: "Booking code not found or has expired."
      });
    }

    const booking = data?.data;

    if (!booking) {
      return res.status(404).json({
        error: "No booking information was returned."
      });
    }

    const outcomes = Array.isArray(booking.outcomes)
      ? booking.outcomes
      : [];

    if (outcomes.length === 0) {
      return res.status(404).json({
        error: "This booking code contains no available selections."
      });
    }

    const selections = outcomes.map((item) => ({
      event:
        `${item.homeTeamName || "Unknown"} vs ${item.awayTeamName || "Unknown"}`,

      market: item.marketDesc || "",

      pick:
        item.selectedOutcome ||
        item.outcomeName ||
        item.selectedOutcomeName ||
        "",

      odds:
        item.odds !== undefined && item.odds !== null
          ? Number(item.odds)
          : null,

      date: item.estimateStartTime
        ? new Date(Number(item.estimateStartTime)).toISOString()
        : "",

      eventId: item.eventId || "",
      marketId: item.marketId || "",
      outcomeId: item.outcomeId || "",
      specifier: item.specifier || ""
    }));

    return res.status(200).json({
      shareCode: code,
      shareURL:
        booking.shareURL ||
        `https://www.sportybet.com/ng/?shareCode=${code}`,
      deadline: booking.deadline || null,
      selections
    });

  } catch (error) {
    console.error("SportyBet API error:", error);

    return res.status(500).json({
      error: "Unable to connect to SportyBet right now. Please try again."
    });
  }
}
