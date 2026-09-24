// api/optimize.js

export default async function handler(req, res) {
  try {
    const eventId = "sr:match:68932720";

    const url =
      "https://sportybet-api.onrender.com/event-markets/" +
      encodeURIComponent(eventId);

    const response = await fetch(url);

    const text = await response.text();

    return res.status(200).json({
      success: true,
      eventId,
      renderStatus: response.status,
      renderOk: response.ok,
      responseLength: text.length,
      responsePreview: text.slice(0, 5000)
    });

  } catch (error) {
    return res.status(200).json({
      success: false,
      error: error?.message || String(error),
      stack: error?.stack || null
    });
  }
}

Then deploy

After deployment, open:

"Test the simplified diagnostic" (https://sportybet-slip-optimizer.vercel.app/api/optimize?utm_source=chatgpt.com)

You should now get JSON rather than the Vercel 500 page.

Send me that JSON.

If this works, we'll know exactly whether Vercel can communicate with your Render API. Then we'll fix the optimizer in one final step instead of continuing to guess.
