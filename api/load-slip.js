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
        "Accept": "application/json, text/plain, */*",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
        "Referer": "https://www.sportybet.com/ng/",
        "Origin": "https://www.sportybet.com"
      }
    });


    /*
      IMPORTANT:
      Do NOT call response.json() immediately.

      SportyBet may sometimes return HTML/text instead
      of JSON. We read the response as text first.
    */

    const raw = await response.text();

    console.log(
      "SportyBet response status:",
      response.status
    );

    console.log(
      "SportyBet response preview:",
      raw.substring(0, 1000)
    );


    if (!response.ok) {

      return res.status(502).json({
        error:
          "SportyBet returned HTTP " +
          response.status +
          "."
      });

    }


    let data = null;


    /*
      Try JSON safely.
    */

    try {

      data = JSON.parse(raw);

    } catch (jsonError) {

      /*
        The response wasn't JSON.

        Instead of crashing with:
        Unexpected token...

        return a useful message.
      */

      return res.status(502).json({
        error:
          "SportyBet returned an unexpected response. " +
          "The booking code service may be temporarily unavailable."
      });

    }


    /*
      Find the actual booking object.

      Different SportyBet responses may place
      the information in different locations.
    */

    const booking =
      data?.data ||
      data?.result ||
      data?.data?.order ||
      data?.result?.order ||
      null;


    if (!booking) {

      return res.status(404).json({
        error:
          "SportyBet returned no booking information for this code."
      });

    }


    /*
      Try several possible selection containers.
    */

    let outcomes =
      booking.outcomes ||
      booking.selections ||
      booking.bets ||
      booking.items ||
      [];


    if (!Array.isArray(outcomes)) {
      outcomes = [];
    }


    /*
      Convert SportyBet data into our
      standard application format.
    */

    const selections = outcomes
      .map((item) => {

        const home =
          item.homeTeamName ||
          item.homeName ||
          item.homeTeam ||
          item.home ||
          "";

        const away =
          item.awayTeamName ||
          item.awayName ||
          item.awayTeam ||
          item.away ||
          "";


        const event =
          item.eventName ||
          item.matchName ||
          (
            home && away
              ? `${home} vs ${away}`
              : ""
          );


        const market =
          item.marketDesc ||
          item.marketName ||
          item.market ||
          item.betType ||
          "";


        const pick =
          item.selectedOutcome ||
          item.selectedOutcomeName ||
          item.outcomeName ||
          item.outcome ||
          item.pick ||
          item.selection ||
          "";


        let odds = null;


        if (
          item.odds !== undefined &&
          item.odds !== null
        ) {

          const parsedOdds =
            Number(item.odds);

          if (!isNaN(parsedOdds)) {
            odds = parsedOdds;
          }

        }


        return {
          event,
          market,
          pick,
          odds
        };

      })
      .filter(item => item.event);


    /*
      If we found the games but no usable
      selection information, return the games
      instead of crashing.
    */

    if (selections.length === 0) {

      return res.status(404).json({
        error:
          "The booking code was found, but SportyBet did not provide readable selections."
      });

    }


    return res.status(200).json({

      shareCode: code,

      selections

    });


  } catch (error) {

    console.error(
      "SportyBet connection error:",
      error
    );

    return res.status(500).json({
      error:
        "Unable to connect to SportyBet right now. Please try again."
    });

  }

}
