
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { Resend } = require("resend");

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

async function sendOrderEmail({
  session,
  items,
  shipping,
  statusColumn,
  subject,
  message
}) {
  const emailTo = process.env.ORDER_TEST_EMAIL;
  if (!emailTo) {
    console.error("ORDER_TEST_EMAIL is missing");
    return;
  }

  // Claim this email so repeated Stripe events do not
  // normally send the same notification again.
  const { data: claimed, error: claimError } = await supabase
    .from("orders")
    .update({ [statusColumn]: "sending" })
    .eq("stripe_session_id", session.id)
    .eq(statusColumn, "pending")
    .select("stripe_session_id");

  if (claimError) {
    console.error("Email claim error:", claimError.message);
    return;
  }

  if (!claimed || claimed.length === 0) return;

  const currency = (session.currency || "usd").toUpperCase();
  const money = amount =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency
    }).format(amount / 100);

  const orderSummary = items
    .map(item =>
      `${item.name} x ${item.quantity}: ${money(item.amount_total * 100)}`
    )
    .join("\n");

  const address = shipping?.address;
  const shippingText = address
    ? [
        shipping.name || "",
        address.line1,
        address.line2,
        [address.city, address.state, address.postal_code]
          .filter(Boolean).join(", "),
        address.country
      ].filter(Boolean).join("\n")
    : "Not provided";

  try {
    const { error: emailError } = await resend.emails.send({
      from: "Juriah Monique Adornments <onboarding@resend.dev>",
      to: [emailTo],
      subject,
      text: [
        message,
        "",
        `Order: ${session.id}`,
        `Customer: ${session.customer_details?.name || "Not provided"}`,
        `Email: ${session.customer_details?.email || session.customer_email || "Not provided"}`,
        "",
        "Items:",
        orderSummary,
        "",
        `Total paid: ${money(session.amount_total || 0)}`,
        "",
        "Shipping address:",
        shippingText
      ].join("\n")
    });

    if (emailError) throw emailError;

    const { error: updateError } = await supabase
      .from("orders")
      .update({ [statusColumn]: "sent" })
      .eq("stripe_session_id", session.id);

    if (updateError) {
      console.error("Email status update error:", updateError.message);
    }

  } catch (emailError) {
    console.error("Resend email error:", emailError.message);

    const { error: updateError } = await supabase
      .from("orders")
      .update({ [statusColumn]: "failed" })
      .eq("stripe_session_id", session.id);

    if (updateError) {
      console.error("Email failure status error:", updateError.message);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Method not allowed");
  }

  const chunks = [];

  try {
    await new Promise((resolve, reject) => {
      req.on("data", chunk => chunks.push(chunk));
      req.on("end", resolve);
      req.on("error", reject);
    });

    const rawBody = Buffer.concat(chunks);
    const signature = req.headers["stripe-signature"];

    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );

    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      const session = event.data.object;

      if (
        session.payment_status !== "paid" &&
        session.payment_status !== "no_payment_required"
      ) {
        return res.status(200).json({ received: true });
      }

      const lineItems = await stripe.checkout.sessions.listLineItems(
        session.id,
        { limit: 100 }
      );

      const items = lineItems.data.map(item => ({
        name: item.description,
        quantity: item.quantity,
        amount_total: item.amount_total / 100
      }));

      const shipping = session.shipping_details ||
        session.collected_information?.shipping_details;

      const { error } = await supabase
        .from("orders")
        .upsert({
          stripe_session_id: session.id,
          stripe_payment_intent:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent?.id || null,
          customer_email:
            session.customer_details?.email || session.customer_email,
          customer_name:
            session.customer_details?.name || shipping?.name || null,
          shipping_address: shipping?.address || null,
          items,
          amount_total: session.amount_total / 100,
          currency: session.currency,
          status: "paid"
        }, {
          onConflict: "stripe_session_id"
        });

      if (error) throw error;

      // Preserve automatic inventory tracking
      if (process.env.INVENTORY_TRACKING_ENABLED === "true") {
        const inventoryItems = [];

        for (const item of lineItems.data) {
          const productId = item.price?.product;
          const product = await stripe.products.retrieve(productId);
          const supabaseId = product.metadata?.supabase_product_id;

          if (!supabaseId) {
            throw new Error("Missing Supabase product ID");
          }

          inventoryItems.push({
            product_id: supabaseId,
            quantity: item.quantity
          });
        }

        const { error: inventoryError } = await supabase.rpc(
          "deduct_order_inventory",
          {
            p_session_id: session.id,
            p_items: inventoryItems
          }
        );

        if (inventoryError) throw inventoryError;
      }

      // Email 1: Customer confirmation (test Gmail)
      await sendOrderEmail({
        session,
        items,
        shipping,
        statusColumn: "confirmation_email_status",
        subject: "Order Confirmation - Juriah Monique Adornments",
        message:
          "Thank you for your order! Your payment was received successfully."
      });

      // Email 2: Business owner notification (test Gmail)
      await sendOrderEmail({
        session,
        items,
        shipping,
        statusColumn: "owner_email_status",
        subject: "New Order Received - Juriah Monique Adornments",
        message:
          "A customer has placed and paid for a new order."
      });
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("Stripe webhook error:", error.message);
    return res.status(400).json({
      error: "Webhook processing failed"
    });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
