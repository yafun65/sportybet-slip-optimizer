export default function handler(req, res) {
  return res.status(200).json({
    success: true,
    message: "Vercel API functions are working",
    method: req.method
  });
}
