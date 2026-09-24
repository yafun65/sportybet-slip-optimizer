export const maxDuration = 60;

export default async function handler(req, res) {
  try {
    const selections = Array.isArray(req.body?.selections)
      ? req.body.selections
      : [];

    const eventIds = [
      ...new Set(
        selections
          .map((x) => x?.eventId)
          .filter(Boolean)
          .map(String)
      )
    ];

    const query = eventIds
      .map((id) => encodeURIComponent(id))
      .join(",");

    const url =
      `https://sportybet-api.onrender.com/event-markets?eventIds=${query}`;

    const response = await fetch(url);
    const text = await response.text();

    let data;

    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }

    return res.status(200).json({
      step1_frontend_sent: {
        selectionCount: selections.length,
        eventIds
      },

      step2_render_request: {
        url,
        status: response.status,
        ok: response.ok
      },

      step3_render_response: {
        success: data?.success ?? null,
        count: data?.count ?? null,
        resultsIsArray: Array.isArray(data?.results),
        resultsCount: Array.isArray(data?.results)
          ? data.results.length
          : 0
      },

      step4_first_event: data?.results?.[0]
        ? {
            eventId: data.results[0].eventId,
            success: data.results[0].success,
            marketCount: Array.isArray(
              data.results[0].markets
            )
              ? data.results[0].markets.length
              : 0,
            firstMarket:
              data.results[0].markets?.[0] || null
          }
        : null,

      step5_full_preview: text.slice(0, 2000)
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
}
