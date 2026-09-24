export default async function handler(req, res) {

  /*
   * TEMPORARY DIAGNOSTIC VERSION
   *
   * Supports:
   *
   * GET:
   * /api/load-slip?code=JQVHY8
   *
   * POST:
   * { "code": "JQVHY8" }
   */


  let code = "";


  /* -----------------------------------------
     GET REQUEST
  ----------------------------------------- */

  if (req.method === "GET") {

    code =
      String(req.query?.code || "")
        .trim()
        .toUpperCase();

  }


  /* -----------------------------------------
     POST REQUEST
  ----------------------------------------- */

  else if (req.method === "POST") {

    code =
      String(req.body?.code || "")
        .trim()
        .toUpperCase();

  }


  /* -----------------------------------------
     OTHER METHODS
  ----------------------------------------- */

  else {

    return res.status(405).json({

      success: false,

      error: "Method not allowed"

    });

  }


  /* -----------------------------------------
     VALIDATE CODE
  ----------------------------------------- */

  if (
    !/^[A-Z0-9]{4,20}$/.test(code)
  ) {

    return res.status(400).json({

      success: false,

      error:
        "Please enter a valid SportyBet booking code."

    });

  }


  /* -----------------------------------------
     CALL RENDER API
  ----------------------------------------- */

  try {

    const response =
      await fetch(
        `https://sportybet-api.onrender.com/booking/${encodeURIComponent(code)}`
      );


    const raw =
      await response.text();


    let data;


    try {

      data =
        JSON.parse(raw);

    }

    catch (error) {

      return res.status(502).json({

        success: false,

        error:
          "Render returned invalid JSON.",

        rawResponse:
          raw.substring(0, 1000)

      });

    }


    /* -----------------------------------------
       RENDER ERROR
    ----------------------------------------- */

    if (!response.ok) {

      return res.status(response.status).json({

        success: false,

        error:
          data?.error ||
          data?.message ||
          "Render could not load the SportyBet booking.",

        renderResponse:
          data

      });

    }


    /* -----------------------------------------
       RETURN EXACT DATA
    ----------------------------------------- */

    return res.status(200).json({

      success: true,

      message:
        "Vercel successfully received the SportyBet booking from Render.",

      shareCode:
        data?.shareCode ||
        code,

      shareURL:
        data?.shareURL ||
        null,

      deadline:
        data?.deadline ||
        null,

      selectionCount:
        Array.isArray(data?.selections)
          ? data.selections.length
          : 0,

      selections:
        Array.isArray(data?.selections)
          ? data.selections
          : [],

      diagnostic: {

        receivedCode:
          code,

        renderReturnedSelections:
          Array.isArray(data?.selections),

        renderSelectionCount:
          Array.isArray(data?.selections)
            ? data.selections.length
            : 0

      }

    });


  } catch (error) {

    console.error(
      "Load slip error:",
      error
    );


    return res.status(500).json({

      success: false,

      error:
        "Unable to connect to the SportyBet API.",

      details:
        error.message

    });

  }

}
