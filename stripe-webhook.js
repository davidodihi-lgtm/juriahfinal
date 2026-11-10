// POST /api/stripe-webhook  — Stripe calls this after a payment.
// Verifies Stripe's signature, then records the order in Supabase.
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// Stripe signs the RAW request body, so it must not be pre-parsed (see config at the bottom).

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function saveOrder(stripe, supabase, session) {
  if (session.payment_status !== "paid") return; // wait for async_payment_succeeded

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
  const items = lineItems.data.map((li) => ({
    name: li.description,
    qty: li.quantity,
    amount: li.amount_total / 100,
  }));

  const ship = (session.collected_information && session.collected_information.shipping_details)
    || session.shipping_details || null;

  const { error } = await supabase.from("orders").upsert(
    {
      stripe_session_id: session.id,
      stripe_payment_intent: typeof session.payment_intent === "string" ? session.payment_intent : null,
      customer_email: session.customer_details ? session.customer_details.email : null,
      customer_name: (ship && ship.name) || (session.customer_details && session.customer_details.name) || null,
      shipping_address: ship ? ship.address : null,
      items,
      amount_total: session.amount_total / 100,
      currency: session.currency,
      status: "paid",
    },
    { onConflict: "stripe_session_id", ignoreDuplicates: true } // safe if Stripe retries
  );
  if (error) throw error;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end("Method not allowed");
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

  let event;
  try {
    const raw = await readRaw(req);
    event = stripe.webhooks.constructEvent(
      raw,
      req.headers["stripe-signature"],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature check failed:", err.message);
    return res.status(400).send("Invalid signature");
  }

  try {
    if (event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded") {
      await saveOrder(stripe, supabase, event.data.object);
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Webhook handler error:", err);
    return res.status(500).send("Handler error"); // Stripe will retry
  }
};

module.exports.config = { api: { bodyParser: false } };
