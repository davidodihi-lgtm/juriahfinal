
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const { Resend } = require("resend");
const resend = new Resend(process.env.RESEND_API_KEY);


const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

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
        session.id
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

      // Send a test order confirmation email
      const emailTo = process.env.ORDER_TEST_EMAIL;

      if (emailTo) {
        const orderSummary = items
          .map(item =>
            `${item.name} x ${item.quantity}: $${item.amount_total.toFixed(2)}`
          )
          .join("\n");

        const { data: claimed, error: claimError } = await supabase
          .from("orders")
          .update({ confirmation_email_status: "sending" })
          .eq("stripe_session_id", session.id)
          .eq("confirmation_email_status", "pending")
          .select("stripe_session_id");

        if (claimError) throw claimError;

        if (claimed && claimed.length > 0) {
          try {
            const { error: emailError } = await resend.emails.send({
              from: "Juriah Monique Adornments <onboarding@resend.dev>",
              to: [emailTo],
              subject: "New Test Order - Juriah Monique Adornments",
              text: [
                "A payment was completed successfully!",
                "",
                `Order: ${session.id}`,
                `Customer: ${session.customer_details?.email || "Not provided"}`,
                "",
                "Items:",
                orderSummary,
                "",
                `Total: $${(session.amount_total / 100).toFixed(2)}`
              ].join("\n")
            });

            if (emailError) throw emailError;

            await supabase
              .from("orders")
              .update({ confirmation_email_status: "sent" })
              .eq("stripe_session_id", session.id);

          } catch (emailError) {
            console.error("Resend email error:", emailError.message);

            await supabase
              .from("orders")
              .update({ confirmation_email_status: "failed" })
              .eq("stripe_session_id", session.id);
          }
        }
      }

    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error("Stripe webhook error:", error.message);
    return res.status(400).json({ error: "Webhook processing failed" });
  }
};

module.exports.config = {
  api: {
    bodyParser: false
  }
};
