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
      error: "Invalid SportyBet booking code."
    });
  }

  const url =
    `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Current-Country": "NG"
      }
    });

    const raw = await response.text();

    console.log("SportyBet HTTP:", response.status);
    console.log("SportyBet response length:", raw.length);
    console.log("SportyBet response:", raw.substring(0, 3000));

    if (!response.ok) {
      return res.status(502).json({
        error: `SportyBet returned HTTP ${response.status}.`
      });
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error:
          "SportyBet returned a non-JSON response."
      });
    }

    /*
      SportyBet booking response:
      data.shareCode
      data.shareURL
      data.deadline
      data.outcomes
      data.unavailableOutcomes
    */

    const booking = data?.data;

    if (!booking) {
      return res.status(404).json({
        error: "No booking data was returned."
      });
    }

    const outcomes = Array.isArray(booking.outcomes)
      ? booking.outcomes
      : [];

    if (outcomes.length === 0) {
      return res.status(404).json({
        error:
          "SportyBet returned the booking but no selections were available."
      });
    }

    const selections = outcomes.map((outcome) => {

      const homeTeam =
        outcome.homeTeamName ||
        outcome.homeName ||
        "";

      const awayTeam =
        outcome.awayTeamName ||
        outcome.awayName ||
        "";

      const event =
        homeTeam && awayTeam
          ? `${homeTeam} vs ${awayTeam}`
          : outcome.eventName ||
            outcome.matchName ||
            "Unknown match";

      const market =
        outcome.marketDesc ||
        outcome.marketName ||
        outcome.market ||
        "Unknown market";

      const pick =
        outcome.selectedOutcome ||
        outcome.selectedOutcomeName ||
        outcome.outcomeName ||
        outcome.outcome ||
        outcome.desc ||
        "Unknown pick";

      const odds =
        Number(outcome.odds);

      return {
        event,
        market,
        pick,
        odds: Number.isFinite(odds) ? odds : null
      };
    });

    return res.status(200).json({
      shareCode:
        booking.shareCode || code,

      shareURL:
        booking.shareURL || null,

      selections
    });

  } catch (error) {

    console.error(
      "SportyBet API error:",
      error
    );

    return res.status(500).json({
      error:
        "Unable to connect to SportyBet."
    });
  }
}
