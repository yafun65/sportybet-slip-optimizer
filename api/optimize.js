export const maxDuration = 60;

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({
        success: false,
        error: "POST required",
        method: req.method
      });
    }

    const body = req.body || {};

    const selections = Array.isArray(body.selections)
      ? body.selections
      : [];

    return res.status(200).json({
      success: true,

      diagnostic: {
        receivedSelections: selections.length,

        selections: selections.map((selection, index) => ({
          number: index + 1,
          event: selection?.event || null,
          market: selection?.market || null,
          pick: selection?.pick || null,
          odds: selection?.odds || null,

          eventId: selection?.eventId || null,
          gameId: selection?.gameId || null,
          marketId: selection?.marketId || null,
          specifier: selection?.specifier ?? null,
          outcomeId: selection?.outcomeId || null
        }))
      },

      message:
        selections.length > 0
          ? "SUCCESS: Frontend selections reached /api/optimize."
          : "ERROR: /api/optimize received ZERO selections."
    });

  } catch (error) {

    return res.status(500).json({
      success: false,
      error: error?.message || String(error)
    });
  }
}
