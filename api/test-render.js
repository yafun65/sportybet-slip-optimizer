export const maxDuration = 60;

export default async function handler(req, res) {
  const eventId = "sr:match:68932720";

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 5000);

  try {
    const started = Date.now();

    const response = await fetch(
      `https://sportybet-api.onrender.com/event-markets/${encodeURIComponent(eventId)}`,
      {
        signal: controller.signal
      }
    );

    const elapsed = Date.now() - started;

    const text = await response.text();

    return res.status(200).json({
      success: true,
      renderStatus: response.status,
      renderOk: response.ok,
      responseTimeMs: elapsed,
      responseLength: text.length,
      preview: text.slice(0, 500)
    });

  } catch (error) {
    return res.status(200).json({
      success: false,
      error: error?.name || "Unknown error",
      message: error?.message || String(error),
      explanation:
        error?.name === "AbortError"
          ? "Render did not respond within 5 seconds."
          : "Vercel could not complete the request to Render."
    });

  } finally {
    clearTimeout(timeout);
  }
}
