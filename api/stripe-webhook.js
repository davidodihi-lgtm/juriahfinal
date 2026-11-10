// POST /api/create-checkout  — builds a Stripe Checkout session.
// Prices come from the database here, never from the browser.
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const SHIP_TO = ["US", "CA", "GB"]; // countries you ship to (edit this list)

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ error: "Your bag is empty." });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);

    const { data: products, error } = await supabase
      .from("products")
      .select("id,name,price,image_url,in_stock")
      .in("id", items.map((i) => String(i.id)));
    if (error) throw error;
    const byId = new Map((products || []).map((p) => [p.id, p]));

    const site = (process.env.SITE_URL || `https://${req.headers.host}`).replace(/\/$/, "");

    const line_items = [];
    for (const it of items) {
      const p = byId.get(it.id);
      if (!p) return res.status(400).json({ error: "An item in your bag is no longer available." });
      if (p.in_stock === false) return res.status(400).json({ error: `${p.name} is sold out.` });
      const qty = Math.min(20, Math.max(1, parseInt(it.qty, 10) || 1));

      const img = /^https?:\/\//.test(p.image_url || "") ? p.image_url : `${site}/${p.image_url || ""}`;
      line_items.push({
        quantity: qty,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(Number(p.price) * 100),
          product_data: { name: p.name, ...(img.startsWith("https://") ? { images: [img] } : {}) },
        },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      shipping_address_collection: { allowed_countries: SHIP_TO },
      success_url: `${site}/success.html`,
      cancel_url: `${site}/index.html#products`,
    });
    return res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("create-checkout error:", e);
    return res.status(500).json({ error: "Could not start checkout." });
  }
};

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
