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

  const url =
    `https://www.sportybet.com/api/ng/orders/share/${encodeURIComponent(code)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "Current-Country": "NG",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
      }
    });

    const raw = await response.text();

    console.log("SportyBet status:", response.status);
    console.log("SportyBet response:", raw.substring(0, 2000));

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
          "SportyBet returned a non-JSON response. The booking service may be temporarily unavailable."
      });
    }

    /*
      SportyBet booking response structure:

      {
        data: {
          outcomes: [...]
        }
      }
    */

    const booking = data?.data;

    if (!booking) {
      return res.status(404).json({
        error: "No booking information was returned for this code."
      });
    }

    const outcomes = Array.isArray(booking.outcomes)
      ? booking.outcomes
      : [];

    if (outcomes.length === 0) {
      return res.status(404).json({
        error:
          "The booking was found, but SportyBet returned no selections."
      });
    }

    const selections = outcomes.map((item) => {
      const home =
        item.homeTeamName ||
        item.homeName ||
        "";

      const away =
        item.awayTeamName ||
        item.awayName ||
        "";

      const event =
        home && away
          ? `${home} vs ${away}`
          : item.eventName || "Unknown match";

      const market =
        item.marketDesc ||
        item.marketName ||
        item.market ||
        "Unknown market";

      const pick =
        item.selectedOutcome ||
        item.selectedOutcomeName ||
        item.outcomeName ||
        item.outcome ||
        "Unknown pick";

      const odds =
        item.odds !== undefined && item.odds !== null
          ? Number(item.odds)
          : null;

      return {
        event,
        market,
        pick,
        odds: Number.isFinite(odds) ? odds : null
      };
    });

    return res.status(200).json({
      shareCode: code,
      selections
    });

  } catch (error) {
    console.error("SportyBet connection error:", error);

    return res.status(500).json({
      error:
        "Unable to connect to SportyBet right now. Please try again."
    });
  }
                        }
