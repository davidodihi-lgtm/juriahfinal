
const { Resend } = require("resend");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  // Keep this endpoint disabled until it is connected
  // securely to the Stripe payment webhook.
  return res.status(403).json({
    error: "Email endpoint not yet activated"
  });
};

// Email sending will be added to the Stripe webhook
// so only verified paid orders trigger notifications.
