export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "POST only"
    });
  }

  try {
    const selections = Array.isArray(req.body?.selections)
      ? req.body.selections
      : [];

    const eventIds = [
      ...new Set(
        selections
          .map(x => x.eventId)
          .filter(Boolean)
          .map(String)
      )
    ];

    if (!eventIds.length) {
      return res.status(400).json({
        success: false,
        error: "No event IDs received",
        received: req.body
      });
    }

    const query = eventIds
      .map(id => encodeURIComponent(id))
      .join(",");

    const url =
      `https://sportybet-api.onrender.com/event-markets?eventIds=${query}`;

    const response = await fetch(url);

    const text = await response.text();

    let data = null;

    try {
      data = JSON.parse(text);
    } catch {}

    return res.status(200).json({
      success: true,

      receivedEventIds: eventIds,

      renderStatus: response.status,

      renderSuccess: response.ok,

      batchCount: data?.count ?? null,

      resultCount: Array.isArray(data?.results)
        ? data.results.length
        : null,

      firstResult: data?.results?.[0] || null,

      firstResultMarketCount:
        Array.isArray(data?.results?.[0]?.markets)
          ? data.results[0].markets.length
          : null,

      preview: text.slice(0, 1000)
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
}
